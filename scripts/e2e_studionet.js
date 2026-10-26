#!/usr/bin/env node
/**
 * End to end run of ClauseMerge on GenLayer Studio Network.
 *
 *   node scripts/e2e_studionet.js <contractAddress>
 *
 * Two real accounts negotiate a three clause deal, with a stranger watching.
 *
 *   round 1        a genuine disagreement on the termination notice
 *   stranger       tries to merge: refused, the round is not burned
 *   rewrite        the disputed clause is revised, so the old verdict is void:
 *                  the case is not ready and signing is refused
 *   round 2        the drafts now say the same thing
 *   replay         the same revision cannot be merged twice
 *   signatures     both sides sign, the text is final
 *
 * Every merge is a real consensus round with a live model.
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
  const k = {
    proposer: generatePrivateKey(),
    counterparty: generatePrivateKey(),
    stranger: generatePrivateKey(),
  };
  fs.writeFileSync(KEYFILE, JSON.stringify(k, null, 2), { mode: 0o600 });
  return k;
}
const k = keys();
const proposer = createAccount(k.proposer || k.buyer);
const counterparty = createAccount(k.counterparty || k.seller);
const stranger = createAccount(k.stranger || generatePrivateKey());
const proposerClient = createClient({ chain: studionet, account: proposer });
const counterpartyClient = createClient({ chain: studionet, account: counterparty });
const strangerClient = createClient({ chain: studionet, account: stranger });
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

function refused(receipt) {
  const leader = (receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
  return String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR";
}

async function send(client, who, functionName, args) {
  console.log(`\n[${who}] ${functionName}(${args.map((a) => JSON.stringify(a).slice(0, 60)).join(", ")})`);
  const hash = await client.writeContract({ address: ADDRESS, functionName, args, value: 0n });
  console.log(`  tx ${hash}`);
  const receipt = await withRetry(
    () => client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 200, interval: 3000 }),
    "receipt"
  );
  const verdict = refused(receipt) ? "refused by the contract" : "executed";
  console.log(`  ${receipt.status_name || receipt.status}  (${verdict})`);
  return { hash, refused: refused(receipt) };
}

async function write(client, who, functionName, args) {
  const { hash, refused: reverted } = await send(client, who, functionName, args);
  if (reverted) throw new Error(`${functionName} failed inside the contract`);
  return hash;
}

async function expectRefused(client, who, functionName, args, why) {
  const { hash, refused: reverted } = await send(client, who, functionName, args);
  if (!reverted) throw new Error(`${who} was allowed to ${functionName}: ${why}`);
  console.log(`  refused as expected: ${why} (tx ${hash})`);
  return hash;
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
  const caseId = process.argv[3] || `deal-${Date.now().toString(36)}`;
  console.log("contract    ", ADDRESS);
  console.log("case        ", caseId);
  console.log("proposer    ", proposer.address);
  console.log("counterparty", counterparty.address);
  console.log("stranger    ", stranger.address);

  await write(proposerClient, "proposer", "open_case", [caseId, DRAFT_A, counterparty.address]);
  await write(counterpartyClient, "counterparty", "counter", [caseId, DRAFT_B_FIRST]);

  console.log("\n[validators] merge round 1 - the termination notice really differs");
  const t0 = Date.now();
  await write(proposerClient, "proposer", "merge", [caseId]);
  console.log(`  round took ${Math.round((Date.now() - t0) / 1000)}s`);
  let c = await read("get_case", [caseId]);
  console.log("  disputed:", JSON.stringify(c.disputed), "| state:", c.state, "| rev:", c.rev, "| round:", c.round);
  if (!Array.isArray(c.disputed) || c.disputed.length === 0) {
    throw new Error("expected at least one disputed clause in round 1");
  }

  console.log("\n[guard] the stranger tries to merge, and to merge again after a rewrite");
  await expectRefused(strangerClient, "stranger", "merge", [caseId], "only the parties merge their drafts");
  c = await read("get_case", [caseId]);
  console.log("  round after the attempt:", c.round);
  if (c.round !== "1") throw new Error("a stranger burned a round");

  console.log("\n[counterparty] revises the disputed clause");
  await write(counterpartyClient, "counterparty", "counter", [caseId, DRAFT_B_SECOND]);
  c = await read("get_case", [caseId]);
  console.log("  state:", c.state, "| disputed reset:", JSON.stringify(c.disputed), "| rev:", c.rev, "| merged_rev:", c.merged_rev);
  console.log("  is_ready:", await read("is_ready", [caseId]), "| to_sign(counterparty):", JSON.stringify(await read("to_sign", [counterparty.address])));
  if ((await read("is_ready", [caseId])) !== false) {
    throw new Error("a revised draft was reported as ready to sign");
  }
  await expectRefused(proposerClient, "proposer", "accept", [caseId], "the verdict predates the rewrite");

  console.log("\n[validators] merge round 2 - the drafts now say the same thing");
  const t1 = Date.now();
  await write(proposerClient, "proposer", "merge", [caseId]);
  console.log(`  round took ${Math.round((Date.now() - t1) / 1000)}s`);
  c = await read("get_case", [caseId]);
  console.log("  disputed:", JSON.stringify(c.disputed), "| ready:", await read("is_ready", [caseId]));
  if (c.disputed.length !== 0) {
    throw new Error(`expected no disputes in round 2, got ${JSON.stringify(c.disputed)}`);
  }

  console.log("\n[guard] the same revision cannot be merged twice");
  await expectRefused(proposerClient, "proposer", "merge", [caseId], "these drafts were already merged");
  c = await read("get_case", [caseId]);
  console.log("  round after the replay:", c.round, "| disputed:", JSON.stringify(c.disputed));

  console.log("\n[both] sign");
  await write(proposerClient, "proposer", "accept", [caseId]);
  await write(counterpartyClient, "counterparty", "accept", [caseId]);
  c = await read("get_case", [caseId]);
  console.log("  state:", c.state, "| signed_a:", c.signed_a, "| signed_b:", c.signed_b);
  console.log("  final text starts:", JSON.stringify((c.final_text || "").slice(0, 60)));
  if (c.state !== "agreed") throw new Error(`expected agreed, got ${c.state}`);

  console.log("\nstats");
  console.log(JSON.stringify(await read("stats", []), null, 2));
  console.log(
    "\nRESULT: disputed round, stranger refused without burning a round, rewrite blocked signing, clean round, replay refused, both signatures in"
  );
})().catch((e) => {
  console.error("\nFAILED:", e.message);
  if (e.cause) console.error(String(e.cause).slice(0, 900));
  process.exit(1);
});
