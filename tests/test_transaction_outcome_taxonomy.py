"""
Regression guard for a business-correctness bug found in the NexaBank telemetry audit:
NexaBank/backend/src/routes/transactionRoutes.ts's POST /transactions fired
trackEvent("transfer_completed" | "payees", ...) UNCONDITIONALLY -- never checking the
transaction's own `status` field, which this same handler accepts and persists as
SUCCESS/FAILED/PENDING. So a FAILED or PENDING transaction still emitted a success-shaped
event. Worse, neither literal was even taxonomy-valid for a success: verified through the real
chain (Node enforceTaxonomy -> ingestion normalization -> canonicalize_event_name),
"transfer_completed" resolved to core.transfer_completed.action (invisible to every contract,
a silent zero) and "payees" resolved to payee.page.view (a completed PAYMENT counted as a page
view of the unrelated payees list page).

This test runs the REAL Node enforceTaxonomy (via scripts/taxonomy_probe.js -- CLAUDE.md:
verify taxonomy claims by running the function, not reimplementing it) and the real Python
ingest+canonicalize chain, so it cannot drift from either dialect's actual behaviour. It also
does a structural check that transactionRoutes.ts branches on `result.status` before choosing
an event name, since a live Express harness for the whole route is out of this test's scope.

Run inside a container with `node` on PATH and this repo's Python deps available:

    docker compose run --rm --name outcome-taxonomy-test <any python service> \\
        python -m unittest tests.test_transaction_outcome_taxonomy -v
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.page_map import canonicalize_event_name  # noqa: E402
from core.event_names import normalize_ingest_event_name  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVENT_TRACKER_PATH = os.path.join(
    REPO_ROOT, "NexaBank", "backend", "src", "middleware", "eventTracker.ts"
)
PROBE_PATH = os.path.join(REPO_ROOT, "scripts", "taxonomy_probe.js")
TRANSACTION_ROUTES_PATH = os.path.join(
    REPO_ROOT, "NexaBank", "backend", "src", "routes", "transactionRoutes.ts"
)

# shutil.which() only checks PATH, never spawns a process -- unlike subprocess.run(["node",
# ...]), which raises FileNotFoundError (not a nonzero returncode) when the binary is simply
# absent, as it is in this repo's Python service containers. That raised at test-module import
# time, taking the whole file down as an ERROR instead of a clean per-class skip.
_NODE_AVAILABLE = shutil.which("node") is not None


def _run_node_taxonomy(names: list[str]) -> dict[str, str]:
    """Feed raw names through the REAL enforceTaxonomy in eventTracker.ts."""
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as fh:
        fh.write("\n".join(names))
        names_file = fh.name
    try:
        out = subprocess.run(
            ["node", PROBE_PATH, EVENT_TRACKER_PATH, names_file],
            capture_output=True, text=True, check=True,
        ).stdout
    finally:
        os.unlink(names_file)
    result = {}
    for line in out.splitlines():
        if "\t" in line:
            raw, mapped = line.split("\t", 1)
            result[raw] = mapped
    return result


def _full_chain(raw_name: str, node_output: dict[str, str]) -> str:
    """Node enforceTaxonomy -> Python ingest normalization -> canonicalize_event_name."""
    node_out = node_output[raw_name]
    ingest_out = normalize_ingest_event_name(node_out)
    canonical = canonicalize_event_name(ingest_out)
    return canonical


@unittest.skipUnless(
    _NODE_AVAILABLE,
    "node is not on PATH -- this test runs the real Node taxonomy dialect, it does not "
    "reimplement it (see module docstring).",
)
class TransactionEventNamesResolveDistinctly(unittest.TestCase):
    """The four names transactionRoutes.ts now emits must each land on a distinct,
    taxonomy-valid, non-'core.*.action' canonical name -- proving success and failure are
    actually distinguishable downstream, for both transaction types."""

    @classmethod
    def setUpClass(cls):
        cls.names = [
            "transfer_completed", "transfer_failed",
            "payment_completed", "payment_failed",
        ]
        cls.node_output = _run_node_taxonomy(cls.names)

    def test_none_of_the_four_fall_through_to_the_generic_core_action_bucket(self):
        for name in self.names:
            canonical = _full_chain(name, self.node_output)
            self.assertIsNotNone(canonical, f"'{name}' canonicalizes to None -- dropped at read time")
            self.assertFalse(
                canonical.startswith("core.") and canonical.endswith(".action"),
                f"'{name}' resolved to '{canonical}' -- the generic fallback bucket no contract "
                f"reads. This is the exact silent-zero bug this test guards against.",
            )

    def test_transfer_success_and_failure_are_distinguishable(self):
        success = _full_chain("transfer_completed", self.node_output)
        failure = _full_chain("transfer_failed", self.node_output)
        self.assertNotEqual(
            success, failure,
            "A TRANSFER success and failure must not canonicalize to the same event name, or "
            "a failed transfer counts as a successful one downstream.",
        )
        self.assertTrue(success.endswith(".success"), success)
        self.assertTrue(failure.endswith(".failure"), failure)

    def test_payment_success_and_failure_are_distinguishable(self):
        success = _full_chain("payment_completed", self.node_output)
        failure = _full_chain("payment_failed", self.node_output)
        self.assertNotEqual(success, failure)
        self.assertTrue(success.endswith(".success"), success)
        self.assertTrue(failure.endswith(".failure"), failure)

    def test_transfer_and_payment_do_not_collide_with_each_other(self):
        # A completed payment must not be counted as a completed transfer or vice versa --
        # the original bug ALSO collapsed a payment into an unrelated page-view counter.
        transfer_success = _full_chain("transfer_completed", self.node_output)
        payment_success = _full_chain("payment_completed", self.node_output)
        self.assertNotEqual(transfer_success, payment_success)
        self.assertNotIn("page.view", transfer_success)
        self.assertNotIn("page.view", payment_success)


@unittest.skipUnless(
    os.path.isfile(TRANSACTION_ROUTES_PATH),
    "transactionRoutes.ts not present in this checkout -- this container has only the "
    "Python-side repo subdirectories (api/, core/, storage/, processing/, ingestion/, "
    "tests/, contracts/), not NexaBank/. Run on the host or a container with the full "
    "monorepo mounted to exercise this class.",
)
class TransactionRoutesBranchesOnStatus(unittest.TestCase):
    """Structural guard: the handler must choose its event name FROM the transaction's own
    `status`, not fire the same literal regardless of outcome. A full Express integration
    harness for this route is out of scope here; this at least prevents the unconditional-call
    regression from silently returning."""

    def test_track_event_call_is_conditioned_on_result_status(self):
        with open(TRANSACTION_ROUTES_PATH, "r", encoding="utf-8") as fh:
            source = fh.read()

        track_call_start = source.index("await trackEvent(")
        # The branching logic must appear BEFORE the trackEvent call that uses it.
        preceding = source[:track_call_start]
        self.assertIn(
            'result.status === "SUCCESS"', preceding,
            "POST /transactions no longer appears to branch its analytics event name on "
            "result.status -- this is the exact regression this test exists to catch.",
        )

    def test_metadata_includes_status_and_channel_from_the_source_record(self):
        with open(TRANSACTION_ROUTES_PATH, "r", encoding="utf-8") as fh:
            source = fh.read()
        track_block_start = source.index("await trackEvent(")
        track_block = source[track_block_start:track_block_start + 800]
        self.assertIn("status: result.status", track_block)
        self.assertIn("channel: result.channel", track_block)


if __name__ == "__main__":
    unittest.main()
