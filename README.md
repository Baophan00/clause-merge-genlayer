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

A verdict alone would be a thin wrapper. The contract is what makes the verdict usable, and each rule below
exists because a verdict is only true of the exact text it was computed on:

- every draft change moves `rev`, and a merge stores the revision it classified in `merged_rev`. Signing
  requires `merged_rev == rev`, so a revised draft cannot be signed on the old verdict, even when that verdict
  said "nothing disputed" and even when the case still looks clean in `disputed`;
- `is_ready` and `to_sign` use the same test, so the read side never advertises a case whose verdict is older
  than its text;
- only the two parties may merge. A merge is the parties' own action, so a passer-by cannot burn one of the
  eight rounds, and there is no outsider who can wipe a signature by calling `merge`;
- a revision is merged once: calling `merge` again on unchanged drafts is refused rather than burning a round
  and clearing the other side's signature for nothing;
- a malformed verdict stops the round. A missing `disputed` key, a value that is not a list, an entry that is
  not a clause number or a number that no clause has is an error, not an empty dispute list: dropping bad
  entries would turn a broken answer into permission to sign;
- both signatures must land, then the case closes and `final_text` is fixed.

## Live

- Contract (Studio Network): `0xc8bF1070CA6916E79979c3C57E4d1780607431CF`
- Explorer: https://explorer-studio.genlayer.com/address/0xc8bF1070CA6916E79979c3C57E4d1780607431CF

## A real negotiation on the live contract

Two accounts and a stranger, three clauses. The drafts agree on delivery and price and disagree on the
termination notice. Case `mismatchb`, every merge a real consensus round with a live model.

| what | transaction |
| --- | --- |
| deploy `0xc8bF1070CA6916E79979c3C57E4d1780607431CF` | `0xe41f4d78105e315f8d6385983df6042f1e110b17843866908c0a86461892cf29` |
| `open_case` proposer writes 1..3 (rev 1) | `0x58a5eb7bbd839b9ccdf73cb48c43d2c901d07b768bab823953f03ac459ec2e5f` |
| `counter` counterparty writes its draft (rev 2) | `0xb29860c37d91ab2c97ab9d7e781c1c1084ba1ecac25d25b7d07dbfca2e268ae5` |
| `merge` round 1 → **disputed: [3]**, 46s | `0xc8ce8c2bb163e2d84a1c584b4dbb89a69ebd6a2b1541b8c0e1517b9626bace9b` |
| a stranger calls `merge` → **refused**, round stays 1 | `0x14be24ee7de41ae8eb42fc820fcbe0f8721b5f55961ef316aad3fa4533c3ba46` |
| `counter` counterparty revises clause 3 (rev 3) | `0xa8f48d43b09ccb23adb828162b68a89bd39276b7313285205c416be121304f59` |
| `accept` proposer on the revised draft → **refused**, the verdict predates the rewrite | `0x33aa52eee541a6c57addd3bf1d7622bf5520b7091617f2581621b454f0e36605` |
| `merge` round 2 → **disputed: []**, ready, 56s | `0xc8cbd2de61d9894582d69b540364f9f305190d7bc295370927b345712e75ea16` |
| `merge` again on the same revision → **refused**, no round burned | `0x8be2e00c27b5a0cd1bef51046f511ea14ddffe63c236b9942782b6d306849e5f` |
| `accept` proposer | `0xa906f34ef710156cd6ed1e253d6f366458af47751eb5e0073745183f25a44a2a` |
| `accept` counterparty → **state: agreed** | `0x366c118d8c58cc801e66573b98f636d4e905c54822577f7c6e936e24a5157539` |

What the two refusals show, in the same case that ends `agreed`: after the rewrite `is_ready` was false and
`to_sign` empty while `disputed` was already `[]`, so the only reason the case was not signable was that the
verdict was older than the text. The stranger's merge and the replay both reverted with the round counter
unchanged, so neither can burn the eight rounds or wipe a signature.

## Flow

1. `open_case(case_id, draft, counterparty)` — clauses are one per line, numbers are positional.
2. `counter(case_id, draft)` — only the named counterparty; resets the classification and the signatures.
3. `merge(case_id)` — either party; validators classify each clause number. Returns `disputed`,
   `ready_to_sign` and the revision it covered. One merge per revision, eight rounds per case.
4. `accept(case_id)` — either party, only when the current revision was merged with nothing in dispute. Two
   signatures close the case.
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
python -m pytest tests/direct -q     # 22 passed
```

They cover the clause parser (empty lines, the 400 character ceiling, the 40 clause ceiling), the two-party
rule, the counterparty-only rule, dispute reporting, the round cap, signing before a merge, signing a disputed
merge, outsiders signing, two signatures closing the case, and the rewrite that voids an existing signature.

Three classes pin the review asks:

- `TestMalformedVerdict` — a missing dispute list, a list that is not a list, an entry that is not a number and
  a clause number that does not exist each revert the merge and leave the round at 0, so a broken answer can
  never read as "nothing disputed";
- `TestMerge::test_only_the_parties_merge` and `test_the_same_drafts_are_not_merged_twice` — a stranger's merge
  is refused and the round counter does not move; a replay on unchanged drafts is refused and the existing
  signature survives;
- `TestAccept::test_a_revised_draft_cannot_be_signed_on_the_old_verdict` — after a clean merge, a rewrite makes
  `is_ready` false, empties `to_sign`, refuses `accept`, and only a new merge on the new revision can be signed.

The seven tests in those asks fail against the previous contract (`git show HEAD:contracts/clause_merge.py`),
so they pin the defects rather than the current behaviour.

## Deploy and run

```bash
npm install
node scripts/deploy_studionet.js
node scripts/e2e_studionet.js 0xc8bF1070CA6916E79979c3C57E4d1780607431CF
```

## Layout

```
contracts/clause_merge.py      the contract
tests/direct/                  direct-mode suite
scripts/deploy_studionet.js    deploy with genlayer-js, no CLI
scripts/e2e_studionet.js       the negotiation above, against the live contract
```
