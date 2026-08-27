"""
Tests for Phase 3 proposal 4a/4b (docs/audits/clickhouse_pipeline_audit_phase3_proposals.md),
implemented in core/models.py per
docs/audits/clickhouse_pipeline_implementation_prompt.md Phase A.

Also re-runs the Phase 2 event_id behavioral checks (empty / omitted / whitespace-only / valid)
so this file catches a regression of that fix too, per the implementation prompt's guardrail
("do not regress anything Phase 2 already fixed").

Run from the repo root, in an environment with pydantic installed (e.g. inside the
ingestion-api / analytics-api / processor-worker container, which all share requirements.txt):

    python -m unittest tests.test_feature_event_schema_evolution -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pydantic import ValidationError  # noqa: E402

from core.models import FeatureEvent  # noqa: E402


BASE = dict(
    event_name="login.auth.success",
    tenant_id="nexabank",
    user_id="u1",
    timestamp=1718361234.56,
    channel="web",
)


class SchemaVersionDefaultsTo1(unittest.TestCase):
    """4a: schema_version defaults to 1 so no existing producer has to change."""

    def test_omitted_schema_version_defaults_to_1(self):
        ev = FeatureEvent(event_id="evt_1", **BASE)
        self.assertEqual(ev.schema_version, 1)

    def test_explicit_schema_version_is_preserved(self):
        ev = FeatureEvent(event_id="evt_1", schema_version=2, **BASE)
        self.assertEqual(ev.schema_version, 2)


class UnrecognizedFieldsAreCaptured(unittest.TestCase):
    """4b: extra="ignore" must not go back to silently dropping fields -- they should land in
    metadata._unrecognized_fields instead, and nothing should be rejected any differently."""

    def test_unknown_top_level_field_is_captured_into_metadata(self):
        ev = FeatureEvent(
            event_id="evt_1",
            a_future_field="surprise",
            **BASE,
        )
        self.assertEqual(
            ev.metadata.get("_unrecognized_fields"),
            {"a_future_field": "surprise"},
        )
        # And it must NOT appear as a real attribute -- extra="ignore" is still in effect.
        self.assertFalse(hasattr(ev, "a_future_field"))

    def test_multiple_unknown_fields_all_captured(self):
        ev = FeatureEvent(
            event_id="evt_1",
            future_a=1,
            future_b="two",
            **BASE,
        )
        self.assertEqual(
            ev.metadata.get("_unrecognized_fields"),
            {"future_a": 1, "future_b": "two"},
        )

    def test_no_unknown_fields_leaves_metadata_untouched(self):
        ev = FeatureEvent(event_id="evt_1", metadata={"browser": "Chrome"}, **BASE)
        self.assertEqual(ev.metadata, {"browser": "Chrome"})
        self.assertNotIn("_unrecognized_fields", ev.metadata)

    def test_capture_merges_with_existing_metadata_without_dropping_it(self):
        ev = FeatureEvent(
            event_id="evt_1",
            future_field="x",
            metadata={"browser": "Chrome"},
            **BASE,
        )
        self.assertEqual(ev.metadata.get("browser"), "Chrome")
        self.assertEqual(ev.metadata.get("_unrecognized_fields"), {"future_field": "x"})

    def test_malformed_metadata_still_rejected_normally_not_masked(self):
        # metadata must be a dict; the capture hook must not paper over a genuinely bad payload
        # by quietly replacing metadata with one that happens to validate.
        with self.assertRaises(ValidationError):
            FeatureEvent(
                event_id="evt_1",
                future_field="x",
                metadata="not-a-dict",
                **BASE,
            )

    def test_unrecognized_fields_never_cause_rejection(self):
        # extra="ignore" semantics must be unchanged -- an unknown field is still never a 422
        # on its own.
        try:
            FeatureEvent(event_id="evt_1", anything_goes=object(), **BASE)
        except ValidationError:
            self.fail("An unrecognized field must never be rejected outright.")


class Phase2RegressionGuard(unittest.TestCase):
    """Re-asserts the Phase 2 event_id fix still holds after this phase's changes to the same
    file (core/models.py), per the implementation prompt's guardrail."""

    def test_empty_event_id_still_rejected(self):
        with self.assertRaises(ValidationError):
            FeatureEvent(event_id="", **BASE)

    def test_omitted_event_id_still_rejected(self):
        with self.assertRaises(ValidationError):
            FeatureEvent(**BASE)

    def test_whitespace_only_event_id_still_rejected(self):
        with self.assertRaises(ValidationError):
            FeatureEvent(event_id="   ", **BASE)

    def test_valid_event_id_still_accepted_unchanged(self):
        ev = FeatureEvent(event_id="evt_real_123", **BASE)
        self.assertEqual(ev.event_id, "evt_real_123")


if __name__ == "__main__":
    unittest.main()
