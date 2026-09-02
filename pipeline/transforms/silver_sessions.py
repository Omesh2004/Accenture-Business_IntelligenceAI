"""`silver.events` -> `silver.sessions`  (behavioural context only).

Session key = the producer's `session_id` (no 30-minute-gap inference — the
kyc_completion_rate contract forbids it, and eventTracker.ts already mints a stable per-session
id). Rows with `session_id = ''` never reach here.

Recomputed wholesale per session (scheduled INSERT ... SELECT ... GROUP BY), stamped with a new
`_version`, then OPTIMIZE ... FINAL — idempotent under a re-run.
"""
from __future__ import annotations

import logging

from warehouse.client import ch_client

logger = logging.getLogger(__name__)
SILVER = "silver"

_SQL = f"""
INSERT INTO {SILVER}.sessions
SELECT
    tenant_id,
    session_id,
    if(argMinIf(user_id, timestamp, user_id != '' AND NOT startsWith(user_id, 'anon_')) != '',
       argMinIf(user_id, timestamp, user_id != '' AND NOT startsWith(user_id, 'anon_')),
       anyLast(user_id)) AS user_id,
    min(timestamp) AS started_at,
    max(timestamp) AS ended_at,
    toUInt32(count()) AS event_count,
    toUInt32(uniqExact(event_name)) AS distinct_events,
    argMin(event_name, timestamp) AS entry_event,
    argMax(event_name, timestamp) AS exit_event,
    anyIf(channel, channel != '') AS channel,
    anyIf(device_type, device_type != '') AS device_type,
    anyIf(country, country != '') AS country,
    anyIf(continent, continent != '') AS continent,
    anyIf(city, city != '') AS city,
    anyIf(campaign, campaign != '') AS campaign,
    arrayDistinct(arrayFlatten(groupArray(fabricated_dims))) AS fabricated_dims,
    toUInt8(count() / greatest(dateDiff('second', min(timestamp), max(timestamp)), 1) > 5) AS is_suspected_bot,
    now() AS _version
FROM {SILVER}.events
WHERE session_id != ''
GROUP BY tenant_id, session_id
"""


def run() -> dict:
    client = ch_client._get_client()
    try:
        client.command(f"TRUNCATE TABLE {SILVER}.sessions")
        client.command(_SQL)
        client.command(f"OPTIMIZE TABLE {SILVER}.sessions FINAL")
    finally:
        try:
            client.close()
        except Exception:
            pass
    rows = ch_client.query(f"SELECT count() AS n FROM {SILVER}.sessions FINAL")
    return {"sessions": int(rows[0]["n"]) if rows else 0}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(run())
