import sys
import os
from datetime import datetime, timezone

# Add the project root to sys.path to resolve storage module
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from storage.client import ch_client

# Only REAL Pro features are enterprise-licensed.
# Basic banking features (login, transfer, dashboard) are FREE — NOT licensed.
# Licensed = features the bank PAYS for under an enterprise plan.
features = [
    # The 4 actual Pro features that require an enterprise license
    {"feature_name": "pro-feature?id=crypto-trading", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "wealth_rebalance", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "pro-feature?id=bulk-payroll-processing", "is_licensed": True, "plan_tier": "enterprise"},
    {"feature_name": "ai_insight_download", "is_licensed": True, "plan_tier": "enterprise"},
]

# Seed for both tenant IDs (bank_a is legacy, nexabank is current)
tenant_ids = ["nexabank", "bank_a"]
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
