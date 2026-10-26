"""Direct-mode tests for ClauseMerge.

    python -m pytest tests/direct -q

The model is mocked, the contract is not: every test drives the same code the
validators run, including the clause splitting and the round bookkeeping.
"""

import json

CONTRACT = "contracts/clause_merge.py"

DRAFT_A = """1. The seller delivers the dataset within five working days of signature.
2. The buyer pays 1200 USDC on delivery.
3. Either party may terminate with seven days written notice."""

DRAFT_B_SAME = """1. The seller hands over the dataset no later than five working days after signing.
2. The buyer pays 1200 USDC when the data is delivered.
3. Termination is allowed with seven days written notice by either party."""

DRAFT_B_DIFFERENT = """1. The seller hands over the dataset no later than five working days after signing.
2. The buyer pays 1200 USDC when the data is delivered.
3. Either party may terminate with thirty days written notice."""


def address(raw):
    from genlayer import Address

    return Address(raw)


def deploy(direct_deploy):
    return direct_deploy(CONTRACT)


def open_case(contract, direct_vm, sender, other, draft=DRAFT_A, case_id="deal-1"):
    direct_vm.sender = sender
    contract.open_case(case_id, draft, address(other))
    return case_id


def mock_merge(direct_vm, disputed):
    payload = json.dumps({"disputed": disputed, "why": {str(n): "differs" for n in disputed}})
    direct_vm.mock_llm(r"You are comparing two drafts", payload)


def mock_raw(direct_vm, payload):
    direct_vm.mock_llm(r"You are comparing two drafts", payload)


class TestOpen:
    def test_a_case_starts_open_with_one_draft(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        open_case(contract, direct_vm, direct_alice, direct_bob)

        case = contract.get_case("deal-1")
        assert case["state"] == "open"
        assert case["clauses"] == 3
        assert case["round"] == "0"
        assert case["disputed"] == []
        assert case["draft_b"] == ""
        assert contract.case_count() == 1

    def test_case_ids_are_unique(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        open_case(contract, direct_vm, direct_alice, direct_bob)
        with direct_vm.expect_revert("case id is taken"):
            open_case(contract, direct_vm, direct_alice, direct_bob)

    def test_a_case_needs_two_parties(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        with direct_vm.expect_revert("two different parties"):
            open_case(contract, direct_vm, direct_alice, direct_alice)

    def test_clause_limits_are_enforced(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        with direct_vm.expect_revert("at least one clause"):
            open_case(contract, direct_vm, direct_alice, direct_bob, draft="   \n  \n")
        with direct_vm.expect_revert("longer than 400"):
            open_case(contract, direct_vm, direct_alice, direct_bob, draft="1. " + "x" * 401)
        with direct_vm.expect_revert("more than 40"):
            open_case(contract, direct_vm, direct_alice, direct_bob, draft="\n".join("clause" for _ in range(41)))


class TestCounter:
    def test_only_the_counterparty_writes_the_second_draft(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        open_case(contract, direct_vm, direct_alice, direct_bob)
        with direct_vm.expect_revert("only the counterparty"):
            contract.counter("deal-1", DRAFT_B_SAME)

    def test_a_new_draft_marks_the_case_stale(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        open_case(contract, direct_vm, direct_alice, direct_bob)
        direct_vm.sender = direct_bob
        contract.counter("deal-1", DRAFT_B_DIFFERENT)
        mock_merge(direct_vm, [3])
        direct_vm.sender = direct_alice
        contract.merge("deal-1")
        assert contract.get_case("deal-1")["disputed"] == [3]

        direct_vm.sender = direct_bob
        contract.counter("deal-1", DRAFT_B_SAME)
        case = contract.get_case("deal-1")
        assert case["state"] == "stale"
        assert case["disputed"] == []
        assert case["draft_b"].startswith("1. The seller hands over")


class TestMerge:
    def test_merge_needs_both_drafts(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        open_case(contract, direct_vm, direct_alice, direct_bob)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("has not written a draft"):
            contract.merge("deal-1")

    def test_a_disputed_clause_is_reported(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        open_case(contract, direct_vm, direct_alice, direct_bob)
        direct_vm.sender = direct_bob
        contract.counter("deal-1", DRAFT_B_DIFFERENT)
        mock_merge(direct_vm, [3])

        direct_vm.sender = direct_alice
        result = contract.merge("deal-1")

        assert result["disputed"] == [3]
        assert result["ready_to_sign"] is False
        case = contract.get_case("deal-1")
        assert case["round"] == "1"
        assert case["state"] == "stale"
        assert contract.is_ready("deal-1") is False

    def test_a_clean_merge_is_ready_to_sign(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        open_case(contract, direct_vm, direct_alice, direct_bob)
        direct_vm.sender = direct_bob
        contract.counter("deal-1", DRAFT_B_SAME)
        mock_merge(direct_vm, [])

        direct_vm.sender = direct_alice
        result = contract.merge("deal-1")

        assert result["disputed"] == []
        assert result["ready_to_sign"] is True
        assert contract.is_ready("deal-1") is True
        assert contract.to_sign(address(direct_bob)) == ["deal-1"]

    def test_each_merge_burns_a_round(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        open_case(contract, direct_vm, direct_alice, direct_bob)
        mock_merge(direct_vm, [2])
        for expected in range(1, 9):
            direct_vm.sender = direct_bob
            contract.counter("deal-1", DRAFT_B_DIFFERENT)
            direct_vm.sender = direct_alice
            assert contract.merge("deal-1")["round"] == str(expected)
        direct_vm.sender = direct_bob
        contract.counter("deal-1", DRAFT_B_DIFFERENT)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("ran out of rounds"):
            contract.merge("deal-1")

    def test_only_the_parties_merge(self, direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
        contract = deploy(direct_deploy)
        open_case(contract, direct_vm, direct_alice, direct_bob)
        direct_vm.sender = direct_bob
        contract.counter("deal-1", DRAFT_B_DIFFERENT)
        mock_merge(direct_vm, [2])

        direct_vm.sender = direct_charlie
        with direct_vm.expect_revert("only the two parties merge"):
            contract.merge("deal-1")
        assert contract.get_case("deal-1")["round"] == "0"

    def test_the_same_drafts_are_not_merged_twice(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        open_case(contract, direct_vm, direct_alice, direct_bob)
        direct_vm.sender = direct_bob
        contract.counter("deal-1", DRAFT_B_SAME)
        mock_merge(direct_vm, [])
        direct_vm.sender = direct_alice
        contract.merge("deal-1")
        contract.accept("deal-1")
        assert contract.get_case("deal-1")["signed_a"] is True

        with direct_vm.expect_revert("already merged"):
            contract.merge("deal-1")
        assert contract.get_case("deal-1")["round"] == "1"
        assert contract.get_case("deal-1")["signed_a"] is True


class TestAccept:
    def test_signing_needs_a_clean_merge(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        open_case(contract, direct_vm, direct_alice, direct_bob)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("sign only after a merge"):
            contract.accept("deal-1")

    def test_a_disputed_merge_cannot_be_signed(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        open_case(contract, direct_vm, direct_alice, direct_bob)
        direct_vm.sender = direct_bob
        contract.counter("deal-1", DRAFT_B_DIFFERENT)
        mock_merge(direct_vm, [3])
        direct_vm.sender = direct_alice
        contract.merge("deal-1")

        with direct_vm.expect_revert("nothing disputed"):
            contract.accept("deal-1")

    def test_outside_parties_cannot_sign(self, direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
        contract = deploy(direct_deploy)
        open_case(contract, direct_vm, direct_alice, direct_bob)
        direct_vm.sender = direct_bob
        contract.counter("deal-1", DRAFT_B_SAME)
        mock_merge(direct_vm, [])
        direct_vm.sender = direct_alice
        contract.merge("deal-1")

        direct_vm.sender = direct_charlie
        with direct_vm.expect_revert("only the two parties"):
            contract.accept("deal-1")

    def test_a_revised_draft_cannot_be_signed_on_the_old_verdict(
        self, direct_vm, direct_deploy, direct_alice, direct_bob
    ):
        contract = deploy(direct_deploy)
        open_case(contract, direct_vm, direct_alice, direct_bob)
        direct_vm.sender = direct_bob
        contract.counter("deal-1", DRAFT_B_SAME)
        mock_merge(direct_vm, [])

        direct_vm.sender = direct_alice
        contract.merge("deal-1")
        contract.accept("deal-1")
        assert contract.is_ready("deal-1") is True

        # The counterparty rewrites clause 3 after the clean merge. The old verdict
        # described text that no longer exists, so nothing is signable until a new
        # merge covers the new revision.
        direct_vm.sender = direct_bob
        contract.counter("deal-1", DRAFT_B_DIFFERENT)
        case = contract.get_case("deal-1")
        assert case["disputed"] == []
        assert case["rev"] == "3"
        assert case["merged_rev"] == "2"
        assert contract.is_ready("deal-1") is False
        assert contract.to_sign(address(direct_bob)) == []

        with direct_vm.expect_revert("sign only after a merge of the current drafts"):
            contract.accept("deal-1")

        direct_vm.clear_mocks()
        mock_merge(direct_vm, [3])
        direct_vm.sender = direct_alice
        contract.merge("deal-1")
        assert contract.is_ready("deal-1") is False
        with direct_vm.expect_revert("nothing disputed"):
            contract.accept("deal-1")

    def test_two_signatures_close_the_case(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        open_case(contract, direct_vm, direct_alice, direct_bob)
        direct_vm.sender = direct_bob
        contract.counter("deal-1", DRAFT_B_SAME)
        mock_merge(direct_vm, [])
        direct_vm.sender = direct_alice
        contract.merge("deal-1")

        assert contract.accept("deal-1")["state"] == "open"
        direct_vm.sender = direct_bob
        assert contract.accept("deal-1")["state"] == "agreed"

        case = contract.get_case("deal-1")
        assert case["state"] == "agreed"
        assert case["final_text"] == DRAFT_A.strip()
        assert contract.stats()["states"]["agreed"] == 1
        assert contract.to_sign(address(direct_bob)) == []

    def test_a_late_rewrite_voids_the_signatures(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        open_case(contract, direct_vm, direct_alice, direct_bob)
        direct_vm.sender = direct_bob
        contract.counter("deal-1", DRAFT_B_SAME)
        mock_merge(direct_vm, [])
        direct_vm.sender = direct_alice
        contract.merge("deal-1")
        contract.accept("deal-1")

        direct_vm.sender = direct_bob
        contract.counter("deal-1", DRAFT_B_DIFFERENT)
        case = contract.get_case("deal-1")
        assert case["signed_a"] is False
        assert case["state"] == "stale"
        assert contract.is_ready("deal-1") is False


class TestMalformedVerdict:
    """A broken answer must stop the round, not read as "nothing disputed"."""

    def setup_case(self, direct_vm, contract, direct_alice, direct_bob):
        open_case(contract, direct_vm, direct_alice, direct_bob)
        direct_vm.sender = direct_bob
        contract.counter("deal-1", DRAFT_B_DIFFERENT)
        direct_vm.sender = direct_alice

    def test_missing_dispute_list_is_rejected(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        self.setup_case(direct_vm, contract, direct_alice, direct_bob)
        mock_raw(direct_vm, json.dumps({"why": {"3": "differs"}}))

        with direct_vm.expect_revert("no dispute list"):
            contract.merge("deal-1")
        case = contract.get_case("deal-1")
        assert case["round"] == "0"
        assert contract.is_ready("deal-1") is False

    def test_a_dispute_list_that_is_not_a_list_is_rejected(
        self, direct_vm, direct_deploy, direct_alice, direct_bob
    ):
        contract = deploy(direct_deploy)
        self.setup_case(direct_vm, contract, direct_alice, direct_bob)
        mock_raw(direct_vm, json.dumps({"disputed": "3"}))

        with direct_vm.expect_revert("not a list"):
            contract.merge("deal-1")
        assert contract.get_case("deal-1")["round"] == "0"

    def test_an_entry_that_is_not_a_number_is_rejected(
        self, direct_vm, direct_deploy, direct_alice, direct_bob
    ):
        contract = deploy(direct_deploy)
        self.setup_case(direct_vm, contract, direct_alice, direct_bob)
        mock_raw(direct_vm, json.dumps({"disputed": [3, "third"]}))

        with direct_vm.expect_revert("not a clause number"):
            contract.merge("deal-1")
        case = contract.get_case("deal-1")
        assert case["disputed"] == []
        assert contract.is_ready("deal-1") is False

    def test_a_clause_number_that_does_not_exist_is_rejected(
        self, direct_vm, direct_deploy, direct_alice, direct_bob
    ):
        contract = deploy(direct_deploy)
        self.setup_case(direct_vm, contract, direct_alice, direct_bob)
        mock_raw(direct_vm, json.dumps({"disputed": [99]}))

        with direct_vm.expect_revert("does not exist"):
            contract.merge("deal-1")
        assert contract.get_case("deal-1")["round"] == "0"
