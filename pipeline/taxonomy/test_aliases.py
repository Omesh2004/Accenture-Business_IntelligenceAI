"""Every event name the pipeline can currently see must canonicalise, OR be a deliberate reject.

Run in the tools image:  docker compose --profile tools run --rm tools pytest pipeline/taxonomy -q
"""
from pipeline.taxonomy import canonicalize, ALIASES, TAXONOMY_REGEX

# Names emitted by scripts/seed_data.py, api/fast_seed.py, and NexaBank instrumentation that a
# KPI contract or a funnel stage references. Each MUST resolve to a canonical 3-part name.
MUST_RESOLVE = [
    "login.auth.success", "login.auth.failed", "register.auth.success",
    "dashboard.page.view", "account.page.view", "transaction.page.view",
    "loan.kyc_started.success", "loan.kyc_completed.success",
    "loan.applied.success", "loan.approved.success",
    "loan.kyc_failed.failure", "loan.kyc_abandoned.failure",
    "transaction.pay_now.success", "transaction.pay_now.failure",
    "transaction.transfer.success", "transaction.transfer.failure",
    "crypto-trading.trade_execution.success",
    "wealth-management-pro.rebalance.success",
    "bulk-payroll-processing.batch.success",
    "ai-insights.book.success",
    # legacy flat names that instrumentation has emitted
    "kyc_started", "kyc_completed", "loan_applied", "loan_approved",
    "transfer_completed", "payment_completed", "payment_failed",
    "free.loan.applied", "lending.loan.kyc_started",
]

# Deliberate rejects — known, but not part of the Round-2 chain, so dead-lettered not renamed.
MUST_REJECT = [
    "Loan KYC Started!",       # bad shape
    "totally unknown event",   # unknown
    "pro.features_unlock.success",   # aliased to null on purpose
    "",
]


def test_must_resolve():
    bad = {n: canonicalize(n) for n in MUST_RESOLVE if not canonicalize(n)}
    assert not bad, f"expected these to canonicalise, got None: {sorted(bad)}"


def test_resolved_names_are_canonical_shape():
    for n in MUST_RESOLVE:
        c = canonicalize(n)
        assert c and TAXONOMY_REGEX.match(c), f"{n!r} -> {c!r} is not page.feature.status"


def test_must_reject():
    for n in MUST_REJECT:
        assert canonicalize(n) is None, f"{n!r} should have been rejected, got {canonicalize(n)!r}"


def test_every_alias_target_is_canonical_or_null():
    for key, target in ALIASES.items():
        if target is None:
            continue
        assert TAXONOMY_REGEX.match(target), f"alias {key!r} -> {target!r} is not canonical shape"


def test_idempotent_on_canonical_input():
    for n in MUST_RESOLVE:
        c = canonicalize(n)
        assert canonicalize(c) == c, f"canonicalize not idempotent for {c!r}"
