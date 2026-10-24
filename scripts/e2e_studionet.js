#!/usr/bin/env node
/**
 * End to end run of ClauseMerge on GenLayer Studio Network.
 *
 *   node scripts/e2e_studionet.js <contractAddress>
 *
 * Two real accounts negotiate a three clause deal. Round one has a genuine
 * disagreement on the termination notice; the counterparty then revises that
 * clause, round two comes back clean, and both sides sign. Every merge is a real
 * consensus round with a live model.
 */
const fs = require("fs");
const path = require("path");
const { createClient, createAccount, generatePrivateKey } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");

const ADDRESS = process.argv[2];
if (!ADDRESS) {
  console.error("usage: node scripts/e2e_studionet.js <contractAddress>");
  process.exit(1);
}

const KEYFILE = path.join(__dirname, ".e2e-keys.json");
function keys() {
  if (fs.existsSync(KEYFILE)) return JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
  const k = { proposer: generatePrivateKey(), counterparty: generatePrivateKey() };
  fs.writeFileSync(KEYFILE, JSON.stringify(k, null, 2), { mode: 0o600 });
  return k;
}
const k = keys();
const proposer = createAccount(k.proposer || k.buyer);
const counterparty = createAccount(k.counterparty || k.seller);
const proposerClient = createClient({ chain: studionet, account: proposer });
const counterpartyClient = createClient({ chain: studionet, account: counterparty });
const reader = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label) {
  let last;
  for (let i = 0; i < 8; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String(e && e.message);
      if (!/DOCTYPE|fetch failed|ECONNRESET|timeout|temporarily unavailable|not available/i.test(msg)) throw e;
      console.log(`  ${label}: rpc hiccup, retry ${i + 1}`);
      await sleep(4000);
    }
  }
  throw last;
}

async function write(client, who, functionName, args) {
  console.log(`\n[${who}] ${functionName}(${args.map((a) => JSON.stringify(a).slice(0, 60)).join(", ")})`);
  const hash = await client.writeContract({ address: ADDRESS, functionName, args, value: 0n });
  console.log(`  tx ${hash}`);
  const receipt = await withRetry(
    () => client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 200, interval: 3000 }),
    "receipt"
  );
  console.log(`  ${receipt.status_name || receipt.status}  (execution ${receipt.result_name || receipt.result || "?"})`);
  const trace = JSON.stringify(receipt.genvm_result || receipt.last_round || {});
  if (trace.includes('"ERROR"') || /Traceback|Error:/.test(trace)) {
    console.log("  contract execution FAILED:", trace.slice(0, 900));
    throw new Error(`${functionName} failed inside the contract`);
  }
  return receipt;
}

const read = (functionName, args) =>
  withRetry(() => reader.readContract({ address: ADDRESS, functionName, args }), "read");

const DRAFT_A = [
  "1. The seller delivers the dataset within five working days of signature.",
  "2. The buyer pays 1200 USDC on delivery.",
  "3. Either party may terminate with seven days written notice.",
].join("\n");

const DRAFT_B_FIRST = [
  "1. The seller hands over the dataset no later than five working days after signing.",
  "2. The buyer pays 1200 USDC once the dataset is delivered.",
  "3. Either party may terminate with thirty days written notice.",
].join("\n");

const DRAFT_B_SECOND = [
  "1. The seller hands over the dataset no later than five working days after signing.",
  "2. The buyer pays 1200 USDC once the dataset is delivered.",
  "3. Either party may end the agreement with seven days written notice.",
].join("\n");

(async () => {
  console.log("contract    ", ADDRESS);
  console.log("proposer    ", proposer.address);
  console.log("counterparty", counterparty.address);

  await write(proposerClient, "proposer", "open_case", ["deal-e2e", DRAFT_A, counterparty.address]);
  await write(counterpartyClient, "counterparty", "counter", ["deal-e2e", DRAFT_B_FIRST]);

  console.log("\n[validators] merge round 1 - the termination notice really differs");
  const t0 = Date.now();
  await write(proposerClient, "proposer", "merge", ["deal-e2e"]);
  console.log(`  round took ${Math.round((Date.now() - t0) / 1000)}s`);
  let c = await read("get_case", ["deal-e2e"]);
  console.log("  disputed:", JSON.stringify(c.disputed), "| state:", c.state, "| round:", c.round);
  if (!Array.isArray(c.disputed) || c.disputed.length === 0) {
    throw new Error("expected at least one disputed clause in round 1");
  }
  const disputedFirst = c.disputed.slice();

  console.log("\n[proposer] the counterparty revises the disputed clause");
  await write(counterpartyClient, "counterparty", "counter", ["deal-e2e", DRAFT_B_SECOND]);
  c = await read("get_case", ["deal-e2e"]);
  console.log("  state after the rewrite:", c.state, "| disputed reset:", JSON.stringify(c.disputed));

  console.log("\n[validators] merge round 2 - the drafts now say the same thing");
  const t1 = Date.now();
  await write(proposerClient, "proposer", "merge", ["deal-e2e"]);
  console.log(`  round took ${Math.round((Date.now() - t1) / 1000)}s`);
  c = await read("get_case", ["deal-e2e"]);
  console.log("  disputed:", JSON.stringify(c.disputed), "| ready:", await read("is_ready", ["deal-e2e"]));
  if (c.disputed.length !== 0) {
    throw new Error(`expected no disputes in round 2, got ${JSON.stringify(c.disputed)}`);
  }

  console.log("\n[both] sign");
  await write(proposerClient, "proposer", "accept", ["deal-e2e"]);
  await write(counterpartyClient, "counterparty", "accept", ["deal-e2e"]);
  c = await read("get_case", ["deal-e2e"]);
  console.log("  state:", c.state, "| signed_a:", c.signed_a, "| signed_b:", c.signed_b);
  console.log("  final text starts:", JSON.stringify((c.final_text || "").slice(0, 60)));
  if (c.state !== "agreed") throw new Error(`expected agreed, got ${c.state}`);

  console.log("\nstats");
  console.log(JSON.stringify(await read("stats", []), null, 2));
  console.log(
    `\nRESULT: round 1 disputed clause(s) ${JSON.stringify(disputedFirst)}, round 2 clean, both signatures in, text final`
  );
})().catch((e) => {
  console.error("\nFAILED:", e.message);
  if (e.cause) console.error(String(e.cause).slice(0, 900));
  process.exit(1);
});
