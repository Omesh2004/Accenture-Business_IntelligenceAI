"""
Phase E (item 8, docs/audits/clickhouse_pipeline_audit_phase1_findings.md), implemented per
docs/audits/clickhouse_pipeline_implementation_phases_defg_prompt.md Phase E.

A LIVE integration test, not a mock -- item 8 is fundamentally a claim about what a real
ClickHouse query returns under real duplicate data, which a mock cannot exercise meaningfully.
Inserts a small, deliberately-duplicated dataset under an isolated fake tenant
('phase_e_dedup_test'), runs both the OLD (naive count()) and NEW (fixed) SQL for a
representative cross-section of the endpoints changed in this phase, asserts the new SQL
returns the correct deduplicated numbers, and asserts the old SQL would have been wrong -- so
this test fails loudly if the fix is ever reverted, not just if it's absent.

Dataset:
  u1: e1 'login.auth.success' (mobile)  -- inserted in one batch, then AGAIN in a SEPARATE
                                            insert() call (a genuine duplicate, simulating a
                                            worker crash-and-replay -- see the module-level note
                                            below on why a same-call duplicate doesn't work here)
  u2: e2 'login.auth.success' (desktop), e3 'login.auth.failure' (desktop)
  u3: e4 'login.auth.success' (mobile)

4 distinct logical events, 5 physical rows. u1 and u3 are single-event users (should read as
"bounced"); u1's real event_count is 1, but a naive row count sees 2 for them -- the exact bug
under test.

IMPORTANT -- why the duplicate is a SEPARATE insert() call, not two rows in one call:
`events_raw` is ReplacingMergeTree(_inserted_at) since Phase C, and this ClickHouse instance has
`optimize_on_insert=1` (the default) -- confirmed via `SELECT * FROM system.settings WHERE
name='optimize_on_insert'`. That setting pre-merges each INSERT block as if a background merge
had already run, so two IDENTICAL rows landing in the SAME insert() call collapse immediately,
before any query even runs. That's a genuine, useful property of the Phase C migration -- but it
means a same-call duplicate doesn't exercise the scenario item 8's read-time fix actually
defends against: a replayed event arriving as a separate, later insert (optimize_on_insert only
operates within one block; a background merge is not guaranteed to have run by query time
either). This was discovered by running the test the naive way first and getting a
suspiciously-clean result -- see docs/audits/clickhouse_pipeline_implementation_phase_e_report.md.

Cleans up after itself: deletes the test tenant's rows and rebuilds daily_feature_usage from
events_raw (the documented procedure, docs/DATABASE.md) so no fake tenant or drifted rollup
state is left in the live volume.

Run inside a container with a real ClickHouse connection (this is NOT a mocked test):

    docker compose run --rm --name item8-test <any python service> \\
        python -m unittest tests.test_item8_query_dedup -v

(or via an isolated verification container per the Phase D/E guardrail -- never the live
serving container, since this test writes real rows, even though it cleans them up.)
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.main import DEDUP_EVENT_KEY  # noqa: E402
from storage.client import ch_client  # noqa: E402

TENANT = "phase_e_dedup_test"


def _rebuild_rollup_from_source():
    """The documented procedure (docs/DATABASE.md) for restoring rollup/raw consistency after
    a delete against events_raw -- materialized views don't observe deletes."""
    client = ch_client._get_client()
    client.command("TRUNCATE TABLE feature_intelligence.daily_feature_usage")
    client.command("""
        INSERT INTO feature_intelligence.daily_feature_usage
        SELECT tenant_id, event_name, toDate(timestamp) AS date,
               uniqExactState(if(length(event_id) > 0, event_id,
                   concat('legacy:', user_id, ':', toString(timestamp), ':', event_name, ':', metadata))) AS event_count,
               uniqState(user_id) AS unique_users
        FROM feature_intelligence.events_raw
        GROUP BY tenant_id, event_name, date
    """)


class Item8DuplicateInjection(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        now = time.time()
        base = {"tenant_id": TENANT, "channel": "web"}
        e1 = {**base, "event_id": "e1", "user_id": "u1", "event_name": "login.auth.success",
              "timestamp": now, "metadata": {"device_type": "mobile"}}
        cls.events = [
            e1,
            {**base, "event_id": "e2", "user_id": "u2", "event_name": "login.auth.success",
             "timestamp": now, "metadata": {"device_type": "desktop"}},
            {**base, "event_id": "e3", "user_id": "u2", "event_name": "login.auth.failure",
             "timestamp": now, "metadata": {"device_type": "desktop"}},
            {**base, "event_id": "e4", "user_id": "u3", "event_name": "login.auth.success",
             "timestamp": now, "metadata": {"device_type": "mobile"}},
        ]
        ch_client.insert_events(cls.events)
        ch_client.insert_events([dict(e1)])  # separate call -- see module docstring
        time.sleep(1)  # let the MV catch up

    @classmethod
    def tearDownClass(cls):
        client = ch_client._get_client()
        client.command(
            "ALTER TABLE feature_intelligence.events_raw DELETE WHERE tenant_id = %(t)s",
            parameters={"t": TENANT},
        )
        time.sleep(2)
        _rebuild_rollup_from_source()

    def test_five_physical_rows_landed(self):
        # Sanity check on the fixture itself: confirms the duplicate genuinely persisted as two
        # rows (i.e. optimize_on_insert did NOT collapse it) before trusting anything below.
        count = ch_client.query(
            "SELECT count() as c FROM feature_intelligence.events_raw WHERE tenant_id = %(t)s",
            {"t": TENANT},
        )[0]["c"]
        self.assertEqual(count, 5)

    def test_features_usage_rollup_pattern_is_correct_and_naive_would_be_wrong(self):
        fixed = ch_client.query(
            """
            SELECT event_name, uniqExactMerge(event_count) as total
            FROM feature_intelligence.daily_feature_usage
            WHERE tenant_id = %(t)s AND date >= today() - 1
            GROUP BY event_name
            """,
            {"t": TENANT},
        )
        fixed_map = {r["event_name"]: int(r["total"]) for r in fixed}
        self.assertEqual(fixed_map.get("login.auth.success"), 3)
        self.assertEqual(fixed_map.get("login.auth.failure"), 1)

        naive = ch_client.query(
            """
            SELECT event_name, count() as total FROM feature_intelligence.events_raw
            WHERE tenant_id = %(t)s GROUP BY event_name
            """,
            {"t": TENANT},
        )
        naive_map = {r["event_name"]: int(r["total"]) for r in naive}
        self.assertEqual(naive_map.get("login.auth.success"), 4)  # proves the fix matters

    def test_metrics_devices_direct_pattern_is_correct_and_naive_would_be_wrong(self):
        fixed = ch_client.query(
            f"""
            SELECT JSONExtractString(metadata, 'device_type') as device_type,
                   uniqExact({DEDUP_EVENT_KEY}) as total
            FROM feature_intelligence.events_raw
            WHERE tenant_id = %(t)s GROUP BY device_type
            """,
            {"t": TENANT},
        )
        fixed_map = {r["device_type"]: int(r["total"]) for r in fixed}
        self.assertEqual(fixed_map.get("mobile"), 2)
        self.assertEqual(fixed_map.get("desktop"), 2)

        naive = ch_client.query(
            """
            SELECT JSONExtractString(metadata, 'device_type') as device_type, count() as total
            FROM feature_intelligence.events_raw
            WHERE tenant_id = %(t)s GROUP BY device_type
            """,
            {"t": TENANT},
        )
        naive_map = {r["device_type"]: int(r["total"]) for r in naive}
        self.assertEqual(naive_map.get("mobile"), 3)  # proves the fix matters

    def test_metrics_kpi_error_rate_is_correct_and_naive_would_be_wrong(self):
        fixed = ch_client.query(
            f"""
            SELECT uniqExact({DEDUP_EVENT_KEY}) as total,
                   uniqExactIf({DEDUP_EVENT_KEY}, lower(event_name) LIKE '%%fail%%') as errors
            FROM feature_intelligence.events_raw WHERE tenant_id = %(t)s
            """,
            {"t": TENANT},
        )[0]
        self.assertEqual(int(fixed["total"]), 4)
        self.assertEqual(int(fixed["errors"]), 1)
        fixed_rate = round(int(fixed["errors"]) / int(fixed["total"]) * 100, 1)
        self.assertEqual(fixed_rate, 25.0)

        naive = ch_client.query(
            """
            SELECT count() as total,
                   countIf(lower(event_name) LIKE '%%fail%%') as errors
            FROM feature_intelligence.events_raw WHERE tenant_id = %(t)s
            """,
            {"t": TENANT},
        )[0]
        naive_rate = round(int(naive["errors"]) / int(naive["total"]) * 100, 1)
        self.assertEqual(naive_rate, 20.0)  # proves the fix matters (25.0 != 20.0)

    def test_secondary_kpi_bounce_rate_is_correct_and_naive_would_be_wrong(self):
        """The clearest demonstration of the bug: u1's single real event is invisible behind
        its duplicate row under the naive query, so u1 wrongly reads as NOT bounced."""
        fixed = ch_client.query(
            f"""
            SELECT count() as total_users, countIf(event_count = 1) as bounced_users
            FROM (
                SELECT user_id, uniqExact({DEDUP_EVENT_KEY}) as event_count
                FROM feature_intelligence.events_raw WHERE tenant_id = %(t)s GROUP BY user_id
            )
            """,
            {"t": TENANT},
        )[0]
        self.assertEqual(int(fixed["total_users"]), 3)
        self.assertEqual(int(fixed["bounced_users"]), 2)  # u1 and u3
        fixed_rate = round(int(fixed["bounced_users"]) / int(fixed["total_users"]) * 100, 1)
        self.assertEqual(fixed_rate, 66.7)

        naive = ch_client.query(
            """
            SELECT count() as total_users, countIf(event_count = 1) as bounced_users
            FROM (
                SELECT user_id, count() as event_count
                FROM feature_intelligence.events_raw WHERE tenant_id = %(t)s GROUP BY user_id
            )
            """,
            {"t": TENANT},
        )[0]
        naive_rate = round(int(naive["bounced_users"]) / int(naive["total_users"]) * 100, 1)
        self.assertEqual(naive_rate, 33.3)  # proves the fix matters (66.7 != 33.3)


if __name__ == "__main__":
    unittest.main()
