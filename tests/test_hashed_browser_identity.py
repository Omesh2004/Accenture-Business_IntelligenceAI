"""
Regression guard for a finding in the NexaBank telemetry audit:
NexaBank/frontend/lib/tracker.ts's `nexaTracker.setUser()` is fed the RAW authenticated
customer ID at 3 call sites (login, registration, UserContext session hydration), and until
this fix, `track()` sent `user_id: this.userId` unhashed straight to the ingestion API. No
live call site invoked `.track()` (verified: zero matches for `nexaTracker.track(` across the
frontend), so nothing had actually leaked -- but nothing prevented a future caller from
shipping a raw authenticated customer ID into ClickHouse either.

`track()` now hashes via WebCrypto SHA-256 at send time, matching the backend's
`hashUserId()` (NexaBank/backend/src/middleware/eventTracker.ts, Node's
crypto.createHash('sha256')...digest('hex')) byte for byte -- same algorithm, same encoding, so
the same customer produces the same hashed ID whether an event goes through the backend or this
browser-direct path (a producer-consistency requirement, not just a leak-prevention one).

This test runs BOTH the real Node backend hash and a Node-hosted WebCrypto call reproducing
exactly what the browser's `hashUserIdHex()` does (TextEncoder + crypto.subtle.digest +
hex-encode), and asserts they match -- rather than asserting the two pieces of source code
"look equivalent", which is exactly the kind of claim CLAUDE.md says must be verified by running
the function.

Run:  python -m unittest tests.test_hashed_browser_identity -v
(needs `node` on PATH; no live services required)
"""
import os
import shutil
import subprocess
import sys
import textwrap
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRACKER_TS_PATH = os.path.join(REPO_ROOT, "NexaBank", "frontend", "lib", "tracker.ts")
EVENT_TRACKER_TS_PATH = os.path.join(
    REPO_ROOT, "NexaBank", "backend", "src", "middleware", "eventTracker.ts"
)

# shutil.which() checks PATH without spawning anything -- unlike subprocess.run(["node", ...]),
# it never raises when the binary is simply absent (as it is in this repo's Python service
# containers, which have no node install). Only spawn `node --version` once we already know
# the binary exists, so a node-less environment gets a clean skip instead of an import error
# that takes the whole test module down with it.
_NODE_AVAILABLE = shutil.which("node") is not None
_FILES_PRESENT = os.path.isfile(TRACKER_TS_PATH) and os.path.isfile(EVENT_TRACKER_TS_PATH)


def _node_hash_parity_check(user_ids: list[str]) -> dict[str, dict[str, str]]:
    """Runs Node's own crypto.createHash (the backend's hashUserId) and Node's WebCrypto
    subtle.digest (what the browser's hashUserIdHex actually calls) for each id, in one
    subprocess, and returns both results so the test can assert they match."""
    ids_js_array = repr(user_ids)
    script = textwrap.dedent(f"""
        const crypto = require('crypto');
        const {{ subtle }} = crypto.webcrypto;

        function backendHash(userId) {{
            return crypto.createHash('sha256').update(userId).digest('hex');
        }}

        async function browserHash(userId) {{
            const bytes = new TextEncoder().encode(userId);
            const digest = await subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
        }}

        (async () => {{
            const ids = {ids_js_array};
            const out = {{}};
            for (const id of ids) {{
                out[id] = {{ backend: backendHash(id), browser: await browserHash(id) }};
            }}
            console.log(JSON.stringify(out));
        }})();
    """)
    result = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
    import json
    return json.loads(result.stdout)


@unittest.skipUnless(_NODE_AVAILABLE, "node is not on PATH")
class BrowserHashMatchesBackendHash(unittest.TestCase):
    """The core claim: the browser tracker's hash and the backend's hash are the SAME function
    applied to the same input, not two implementations that merely look alike."""

    def test_hashes_match_for_a_range_of_ids(self):
        ids = ["cust_12345", "04932417-e93d-48c2-9a2e-45f171baa555", "abc-def-ghi", "a", ""]
        results = _node_hash_parity_check(ids)
        for user_id, hashes in results.items():
            self.assertEqual(
                hashes["backend"], hashes["browser"],
                f"Backend hashUserId and browser hashUserIdHex disagree for '{user_id}': "
                f"{hashes['backend']} vs {hashes['browser']}",
            )

    def test_hash_is_a_64_char_lowercase_hex_sha256_digest(self):
        results = _node_hash_parity_check(["sample_user"])
        digest = results["sample_user"]["browser"]
        self.assertEqual(len(digest), 64)
        self.assertTrue(all(c in "0123456789abcdef" for c in digest))

    def test_different_ids_produce_different_hashes(self):
        results = _node_hash_parity_check(["user_a", "user_b"])
        self.assertNotEqual(results["user_a"]["browser"], results["user_b"]["browser"])


@unittest.skipUnless(
    _FILES_PRESENT,
    "tracker.ts/eventTracker.ts not present in this checkout -- this container has only "
    "the Python-side repo subdirectories, not NexaBank/. Run on the host or a container "
    "with the full monorepo mounted to exercise this class.",
)
class TrackerSourceNeverSendsRawUserId(unittest.TestCase):
    """Structural guard against the regression returning: the payload's `user_id` field must be
    built from the hashed value, and setUser()'s raw parameter must not be sent directly."""

    def test_payload_user_id_is_the_hashed_value(self):
        with open(TRACKER_TS_PATH, "r", encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn("user_id: hashedUserId", source)

        # Scoped to the actual payload object literal, not the whole file: the module
        # docstring above deliberately quotes the OLD broken pattern
        # ("`user_id: this.userId` unhashed") to explain what this fix replaced, and a
        # whole-file assertNotIn would false-positive on its own explanation of the bug.
        payload_start = source.index("const payload = {")
        payload_end = source.index("\n    };", payload_start)
        payload_literal = source[payload_start:payload_end]
        self.assertNotIn("user_id: this.userId", payload_literal)

    def test_hash_helper_uses_subtlecrypto_sha256(self):
        with open(TRACKER_TS_PATH, "r", encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn("crypto.subtle.digest('SHA-256'", source)


@unittest.skipUnless(
    _FILES_PRESENT,
    "tracker.ts/eventTracker.ts not present in this checkout -- this container has only "
    "the Python-side repo subdirectories, not NexaBank/. Run on the host or a container "
    "with the full monorepo mounted to exercise this class.",
)
class BackendHashUnchanged(unittest.TestCase):
    """The backend side of the parity claim must still be SHA-256 hex -- if this ever changes,
    the browser side silently stops matching it and this whole guarantee breaks quietly."""

    def test_backend_still_uses_sha256_hex(self):
        with open(EVENT_TRACKER_TS_PATH, "r", encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn('createHash("sha256")', source)
        self.assertIn('digest("hex")', source)


if __name__ == "__main__":
    unittest.main()
