"""Core-banking extract -> `bronze.core_banking` (the landing table only).

Moved from `api/intelligence/loaders.py`. The HTTP paging, watermark + `cursor_id` keyset
resume, branch-fingerprint watermark invalidation and freshness bookkeeping are kept verbatim —
that logic is good. What changed: this writes **only** `bronze.core_banking` (one row per
extracted record, `_raw` = the JSON verbatim). Silver facts are re-derived from bronze by
`pipeline/transforms/silver_facts.py`, so a replay never re-hits NexaBank.

Entities consumed for the 5-KPI chain (Phase 0): transactions, loan_applications, accounts,
customers, campaigns, branches. Dropped: cards, campaign_interactions, macro_environment.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from warehouse.client import ch_client
from pipeline.tenant import TENANT
from pipeline.extract.freshness import (
    EPOCH, read_watermark, read_cursor_id, write_watermark, record_freshness)

logger = logging.getLogger(__name__)

BRONZE = "bronze"
EXTRACT_URL = os.environ.get("EXTRACT_API_URL", "http://nexabank-backend:5000/api")
EXTRACT_TOKEN = os.environ.get("EXTRACT_API_TOKEN", "")
PAGE_SIZE = int(os.environ.get("EXTRACT_PAGE_SIZE", "1000"))
# A safety stop, not a budget. At 200 pages a full extract quietly ended after 200,000 source
# rows: the bank has more than that, so bronze held history up to one arbitrary day and every
# downstream number for the days after it read zero. The cap has to sit well above the size of
# the source, or it silently truncates the warehouse.
MAX_PAGES = int(os.environ.get("EXTRACT_MAX_PAGES", "5000"))
HTTP_TIMEOUT_S = int(os.environ.get("EXTRACT_TIMEOUT_S", "30"))

# entity -> (_source_id, the record's id field, the record's version-clock field)
# accounts has no `updated_at` in the extract shape; opening is the event, so `opened_at` is
# the version clock. transactions likewise expose only `occurred_at` (Track A ask: add
# `updated_at` to the transactions extract so a status change re-versions cleanly). The silver
# transform breaks a version-clock tie with `_extracted_at`, so a re-extracted status change
# still wins.
ENTITIES = {
    "transactions":      ("nexabank_core", "txn_id", "occurred_at"),
    "loan_applications": ("nexabank_core", "application_id", "updated_at"),
    "accounts":          ("nexabank_core", "account_no", "opened_at"),
    "campaigns":         ("nexabank_crm", "campaign_id", "updated_at"),
}
# Full-re-read entities (no change feed): paged by offset / returned whole.
FULL_ENTITIES = {
    "customers": ("nexabank_crm", "customer_id"),
    "branches":  ("market_ops", "branch_code"),
}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _dt(value) -> datetime:
    if not value:
        return EPOCH
    text = str(value).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).astimezone(timezone.utc).replace(tzinfo=None)
    except ValueError:
        return EPOCH


def _fetch(entity: str, params: dict) -> dict:
    query = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    req = urllib.request.Request(f"{EXTRACT_URL}/extract/{entity}?{query}",
                                 headers={"x-extract-token": EXTRACT_TOKEN}, method="GET")
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _land(rows: list[list]) -> int:
    if not rows:
        return 0
    client = ch_client._get_client()
    try:
        client.insert(
            f"{BRONZE}.core_banking", rows,
            column_names=["record_id", "entity", "tenant_id", "_source_id", "_extracted_at",
                          "_source_updated_at", "_page_watermark", "_page_cursor_id", "_raw",
                          "_ingested_at"])
        return len(rows)
    finally:
        try:
            client.close()
        except Exception:
            pass


def _extract_watermarked(entity: str, full: bool) -> int:
    source_id, id_key, ver_key = ENTITIES[entity]
    since = EPOCH if full else read_watermark(source_id, entity)
    cursor_id = "" if full else read_cursor_id(source_id, entity)
    extracted_at = _now()
    total, max_ts = 0, since
    page_watermark = since
    for _ in range(MAX_PAGES):
        page = _fetch(entity, {"since": since.isoformat(), "since_id": cursor_id,
                               "limit": PAGE_SIZE})
        records = page.get("records") or []
        if not records:
            break
        page_wm = _dt(page.get("watermark"))
        page_cur = str(page.get("cursor_id") or "")
        rows = []
        for r in records:
            ver = _dt(r.get(ver_key)) or _dt(r.get("occurred_at")) or _dt(r.get("opened_at"))
            max_ts = max(max_ts, ver)          # advance the cursor over EVERY row, all tenants
            if str(r.get("tenant_id", "")) != TENANT:
                continue                       # Round 2 is one bank — other tenants never land
            rows.append([str(r.get(id_key, "")), entity, str(r.get("tenant_id", "")), source_id,
                         extracted_at, ver, page_wm, page_cur,
                         json.dumps(r, default=str, sort_keys=True), extracted_at])
        total += _land(rows)
        since = _dt(page.get("watermark")) or max_ts
        # The cursor the NEXT run resumes from has to be the one the source paginates on.
        # `max_ts` is the newest row VERSION seen, and for transactions the payload carries no
        # version field at all, so it fell back to `occurred_at` -- event time. Storing that as
        # the cursor mixed two clocks: the next run asked for `updatedOn > <an occurred_at>`.
        page_watermark = max(page_watermark, _dt(page.get("watermark")) or EPOCH)
        cursor_id = page_cur
        if not page.get("has_more"):
            break
    else:
        logger.warning("%s: stopped at the %d page safety cap with more rows on the source; "
                       "raise EXTRACT_MAX_PAGES", entity, MAX_PAGES)
    write_watermark(source_id, entity, page_watermark or max_ts, total, cursor_id=cursor_id)
    return total


def _extract_full(entity: str) -> int:
    source_id, id_key = FULL_ENTITIES[entity]
    extracted_at = _now()
    total, offset = 0, 0
    for _ in range(MAX_PAGES):
        params = {"limit": PAGE_SIZE, "offset": offset} if entity == "customers" else {}
        page = _fetch(entity, params)
        records = page.get("records") or []
        if not records:
            break
        rows = [[str(r.get(id_key, "")), entity, str(r.get("tenant_id", "")), source_id,
                 extracted_at, extracted_at, EPOCH, "",
                 json.dumps(r, default=str, sort_keys=True), extracted_at]
                for r in records if str(r.get("tenant_id", "")) == TENANT]
        total += _land(rows)
        offset += len(records)
        if not page.get("has_more") or not params:
            break
    write_watermark(source_id, entity, extracted_at, total)
    return total


# ── branch-fingerprint watermark invalidation ───────────────────────────────
# A watermarked extract cursors on the ENTITY's own updatedOn. Re-pointing a branch or renaming
# its region touches no transaction row, so the next incremental load reads nothing and the
# denormalised region/country on transactions/accounts/customers keeps a stale value. When the
# branch fingerprint changes, reset those feeds' watermarks so the next load re-reads in full.
BRANCH_DERIVED = [("nexabank_core", "transactions"), ("nexabank_core", "accounts"),
                  ("nexabank_crm", "customers")]


def _branch_fingerprint(branch_raws: list[str]) -> str:
    parts = []
    for raw in branch_raws:
        try:
            b = json.loads(raw)
        except Exception:
            continue
        parts.append("%s|%s|%s" % (b.get("branch_code", ""), b.get("region", ""),
                                   b.get("country", "")))
    return hashlib.sha1(chr(10).join(sorted(parts)).encode("utf-8")).hexdigest()


def _invalidate_on_branch_change() -> list[str]:
    rows = ch_client.query(
        "SELECT _raw FROM bronze.core_banking WHERE entity = 'branches' "
        "ORDER BY _extracted_at DESC LIMIT 10000")
    if not rows:
        return []
    # newest extraction only
    newest = ch_client.query(
        "SELECT _raw FROM bronze.core_banking WHERE entity = 'branches' "
        "AND _extracted_at = (SELECT max(_extracted_at) FROM bronze.core_banking WHERE entity='branches')")
    current = _branch_fingerprint([str(r["_raw"]) for r in newest])
    prev_rows = ch_client.query(
        "SELECT cursor_id FROM gold.ingest_watermarks FINAL "
        "WHERE source_id = 'market_ops' AND entity = 'branch_fingerprint'")
    previous = str(prev_rows[0]["cursor_id"]) if prev_rows else ""
    if previous == current:
        return []
    for source_id, entity in BRANCH_DERIVED:
        write_watermark(source_id, entity, EPOCH, 0, cursor_id="")
    write_watermark("market_ops", "branch_fingerprint", _now(), len(newest), cursor_id=current)
    return ["%s/%s" % (s, e) for s, e in BRANCH_DERIVED]


# ── entrypoint ──────────────────────────────────────────────────────────────
def run(full: bool = False, tenants: list[str] | None = None) -> dict:
    """One extract sweep: land every consumed entity into bronze.core_banking."""
    counts: dict = {}
    # branches first, so a geo change invalidates the derived feeds before they run
    counts["branches"] = _extract_full("branches")
    invalidated = _invalidate_on_branch_change()
    if invalidated:
        logger.info("branch fingerprint changed; reset watermarks for %s", invalidated)
        counts["invalidated_watermarks"] = invalidated

    for entity in ("transactions", "loan_applications", "accounts", "campaigns"):
        counts[entity] = _extract_watermarked(entity, full)
    counts["customers"] = _extract_full("customers")

    # freshness, per tenant, from what actually landed
    for source_id, entity_filter in (("nexabank_core", "('transactions','loan_applications','accounts')"),
                                     ("nexabank_crm", "('customers','campaigns')"),
                                     ("market_ops", "('branches')")):
        rows = ch_client.query(
            f"SELECT tenant_id, max(_source_updated_at) AS m, count() AS n "
            f"FROM bronze.core_banking WHERE entity IN {entity_filter} GROUP BY tenant_id")
        for row in rows:
            if row["tenant_id"]:
                record_freshness(source_id, str(row["tenant_id"]), row["m"], int(row["n"]))
    return counts


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(run(full=True))
