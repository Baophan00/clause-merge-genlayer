# ClauseMerge

Two drafts in, one agreed text out, clause by clause.

Two agents negotiating a deal do not need a judge. They need to know exactly which clauses already match and
which still do not. Today that is a human reading two documents side by side, or a model writing confident
prose about them. ClauseMerge turns the comparison into a verdict per clause number, so the negotiation has a
public state that both sides can act on: merge, see what is still in dispute, revise that clause, merge again,
sign when nothing is.

## The interesting part: consensus over a set, not over prose

A merge asks the validator set one question: for every clause number, do the two sides carry the same
obligation? The answer is a list of disputed clause numbers, not an essay. That is what the equivalence
principle compares — two validators may word their reasoning completely differently, but they either agree
that clause 3 differs or they do not:

```python
gl.eq_principle.prompt_comparative(
    ask,
    principle="Both answers must name exactly the same clause numbers as disputed. Ignore the "
              "wording of the reasons; a different explanation for the same clause numbers is a "
              "match, an extra or missing clause number is not.",
)
```

Both drafts are untrusted input written by the counterparties themselves, which is why the round needs a
validator set at all: a single reader can be negotiated with, one clause at a time, and the contract has no way
to notice. The prompt also tells the model that a clause instructing it what to answer is itself a disputed
clause.

## Why the state machine matters

A verdict alone would be a thin wrapper. The contract is what makes the verdict usable:

- a new draft from the counterparty invalidates the previous classification **and both signatures**, because a
  signature on "no disputes" means nothing once the text moved underneath it;
- signing is only allowed after a merge that found **zero** disputes, so a party cannot sign a text that was
  never compared;
- rounds are capped at eight, so a counterparty cannot keep rewriting forever;
- both signatures must land, then the case closes and `final_text` is fixed.

## Live

- Contract (Studio Network): `0x4D5d5712a6D0807F2ACAc858aa7b6300FeAd7Bce`
- Explorer: https://explorer-studio.genlayer.com/address/0x4D5d5712a6D0807F2ACAc858aa7b6300FeAd7Bce

## A real negotiation on the live contract

Two accounts, three clauses. The drafts agree on delivery and price, and disagree because one says seven days
notice and the other says thirty.

| what | transaction |
| --- | --- |
| deploy `0x4D5d5712a6D0807F2ACAc858aa7b6300FeAd7Bce` | `0x1376883baf41094b1306c4ed8e11ff5912236ac03aedefc3f856117652b9deec` |
| `open_case` proposer writes 1..3 | `0x7120e6945fcd542d65b16e438b0796148e7897af66fb902d3da72d8c039f4d1b` |
| `counter` counterparty writes its draft | `0xea02f6f807257bf3cea257de2bdbd1c74128c6cfbf62d61b8a845f7a8db02a90` |
| `merge` round 1 → **disputed: [3]**, 61s | `0x58e575a2e3d41c4084f876d5bf3d5d9b47b81f10ea15882d158e16d759521783` |
| `counter` the counterparty revises clause 3 | `0x68ee2981554ccaa3146e493b256e3719c09c266d4b4c6bb01ea157118c4c1077` |
| `merge` round 2 → **disputed: []**, ready, 51s | `0xe1d508e6eb2a72efee5447608676c426d39771c72cfe40192f60c9f7e21db5cc` |
| `accept` proposer | `0x1d78713e002b9129ada59c9da0afadd8ed6bf2b0328d1808fc56cb94b747772a` |
| `accept` counterparty → **state: agreed** | `0x3409019df47ebdd0eb137876e1079b8b345ff0eee92e6ac3530cd8abf012ee35` |

After the rewrite the case is `stale` with `disputed: []`, and `is_ready` is false until the second merge
leaves nothing in dispute — that is the signature-invalidation rule doing its job on chain.

## Flow

1. `open_case(case_id, draft, counterparty)` — clauses are one per line, numbers are positional.
2. `counter(case_id, draft)` — only the named counterparty; resets the classification and the signatures.
3. `merge(case_id)` — anyone may trigger it; validators classify each clause number. Returns `disputed` and
   `ready_to_sign`.
4. `accept(case_id)` — either party, only after a clean merge. Two signatures close the case.
5. `get_case`, `is_ready`, `to_sign(address)`, `case_count`, `stats`.

Limits are deliberate: 40 clauses, 400 characters each, 8 rounds. Enough for a real agreement, small enough
that a validator reading it cannot drift.

## Contract surface

| kind | name |
| --- | --- |
| write | `open_case`, `counter`, `merge`, `accept` |
| view | `get_case`, `is_ready`, `to_sign`, `case_count`, `stats` |

## Tests

```bash
python -m pytest tests/direct -q     # 15 passed
```

They cover the clause parser (empty lines, the 400 character ceiling, the 40 clause ceiling), the two-party
rule, the counterparty-only rule, dispute reporting, the round cap, signing before a merge, signing a disputed
merge, outsiders signing, two signatures closing the case, and the rewrite that voids an existing signature.

## Deploy and run

```bash
npm install
node scripts/deploy_studionet.js
node scripts/e2e_studionet.js 0x4D5d5712a6D0807F2ACAc858aa7b6300FeAd7Bce
```

## Layout

```
contracts/clause_merge.py      the contract
tests/direct/                  direct-mode suite
scripts/deploy_studionet.js    deploy with genlayer-js, no CLI
scripts/e2e_studionet.js       the negotiation above, against the live contract
```
