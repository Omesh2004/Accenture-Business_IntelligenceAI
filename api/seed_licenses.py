import sys
import os
from datetime import datetime, timezone

# Add the project root to sys.path to resolve storage module
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from storage.client import ch_client

# Only REAL Pro features are enterprise-licensed.
# Basic banking features (login, transfer, dashboard) are FREE — NOT licensed.
# Licensed = features the bank PAYS for under an enterprise plan.
#
# A7 fix (docs/FinInsights_Bug_Audit.md): this used to seed feature names like
# "pro-feature?id=crypto-trading" and "wealth_rebalance", which canonicalize_event_name
# resolves to "core.pro_feature_id_crypto_trading.action" / "core.wealth_rebalance.action" --
# strings no real event ever produces. Verified live: /segmentation/compare (api/main.py) reads
# tenant_licenses.feature_name and runs it through canonicalize_event_name before matching it
# against usage, so the seeded value must equal a name real usage also canonicalizes to. Using
# the already-canonical event names directly (confirmed idempotent under canonicalize_event_name)
# and listing one row per event, matching /license/usage's hardcoded catalog exactly, means
# seeded Pro usage now registers under the same keys real Pro usage does.
features = [
    # crypto-trading
    {"feature_name": "crypto-trading.page.view", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "crypto-trading.trade_execution.success", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "crypto-trading.trade_execution.failure", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "crypto-trading.price_feeds.view", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "crypto-trading.portfolio.view", "is_licensed": True, "plan_tier": "enterprise"},
    # wealth-management-pro
    {"feature_name": "wealth-management-pro.page.view", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "wealth-management-pro.rebalance.success", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "wealth-management-pro.rebalance.failure", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "wealth-management-pro.insights.view", "is_licensed": True, "plan_tier": "enterprise"},
    # bulk-payroll-processing
    {"feature_name": "bulk-payroll-processing.page.view", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "bulk-payroll-processing.batch.success", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "bulk-payroll-processing.batch.failure", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "bulk-payroll-processing.payees.view", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "bulk-payroll-processing.search.success", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "bulk-payroll-processing.search.failure", "is_licensed": True, "plan_tier": "enterprise"},
    # ai-insights
    {"feature_name": "ai-insights.page.view", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "ai-insights.book.access", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "ai-insights.book.success", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "ai-insights.stats.view", "is_licensed": True, "plan_tier": "enterprise"},
]

# Seed for every real tenant (bank_a is legacy and gets rewritten to nexabank by
# rewrite_tenant_query_aliases -- kept for back-compat with anything still reading it directly).
# H10 fix, done here rather than deferred to Phase 7 since it's the same file and the same class
# of "seeded but unreadable" bug: safexbank was never seeded at all, so its license page read
# empty no matter what ran.
tenant_ids = ["nexabank", "bank_a", "safexbank"]
client = ch_client._get_client()

for tid in tenant_ids:
    rows = []
    for f in features:
        rows.append([tid, f["feature_name"], 1 if f["is_licensed"] else 0, f["plan_tier"], datetime.now(timezone.utc).replace(tzinfo=None)])

    try:
        client.insert(
            'feature_intelligence.tenant_licenses',
            rows,
            column_names=['tenant_id', 'feature_name', 'is_licensed', 'plan_tier', 'updated_at']
        )
        print(f"Success: Synced {len(rows)} enterprise licenses for {tid}.")
    except Exception as e:
        print(f"Error for {tid}:", e)
