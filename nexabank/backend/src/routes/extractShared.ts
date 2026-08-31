import { Request, Response } from "express";

/**
 * Shared plumbing for the extract APIs. One implementation, so the token guard and the paging
 * cursor cannot drift between the core and reference extracts.
 */

export const MAX_LIMIT = 5000;
export const DEFAULT_LIMIT = 1000;

/** The bank's own clearing account; it is not a customer of either tenant. */
export const EXTERNAL_ACCOUNT = "EXTERNAL-BANK";

const TENANT_TO_ANALYTICS: Record<string, string> = { bank_a: "nexabank" };
const ANALYTICS_TO_TENANT: Record<string, string> = { nexabank: "bank_a" };

export function analyticsTenant(prismaTenantId: string): string {
  return TENANT_TO_ANALYTICS[prismaTenantId] || prismaTenantId;
}

/** Shared-secret guard. The extract exposes customer-level financial data. */
export function requireExtractToken(req: Request, res: Response): boolean {
  const expected = process.env.EXTRACT_API_TOKEN;
  if (!expected) {
    res.status(503).json({ error: "EXTRACT_API_TOKEN is not configured; extract is disabled" });
    return false;
  }
  if (req.headers["x-extract-token"] !== expected) {
    res.status(401).json({ error: "invalid extract token" });
    return false;
  }
  return true;
}

export function parseParams(req: Request) {
  const since = req.query.since ? new Date(String(req.query.since)) : new Date(0);
  const sinceId = req.query.since_id ? String(req.query.since_id) : "";
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(Math.floor(rawLimit), MAX_LIMIT))
    : DEFAULT_LIMIT;
  const tenantParam = String(req.query.tenant || "").trim().toLowerCase();
  const tenantId = ANALYTICS_TO_TENANT[tenantParam] || tenantParam || null;
  return {
    since: isNaN(since.getTime()) ? new Date(0) : since,
    sinceId,
    limit,
    tenantId,
  };
}

/**
 * Keyset predicate on (timeField, id).
 *
 * `{ [timeField]: { gt: since } }` alone loses every row that shares the boundary timestamp with
 * the last row of the previous page — permanently, because the cursor has already moved past it.
 * Comparing the id as a tiebreaker is what makes the page boundary exact.
 */
export function keysetWhere(timeField: string, since: Date, sinceId: string): object {
  if (!sinceId) return { [timeField]: { gt: since } };
  return {
    OR: [
      { [timeField]: { gt: since } },
      { AND: [{ [timeField]: since }, { id: { gt: sinceId } }] },
    ],
  };
}

/**
 * The cursor is (timestamp, id) — both halves. Returning only the timestamp meant the next page
 * resumed at `gt: thatTimestamp` and silently dropped every sibling row sharing it.
 */
export function nextWatermark(rows: Array<{ ts: Date }>, fallback: Date): string {
  if (!rows.length) return fallback.toISOString();
  return rows[rows.length - 1].ts.toISOString();
}

export function nextCursorId(rows: Array<{ id?: string }>, fallback = ""): string {
  if (!rows.length) return fallback;
  return String(rows[rows.length - 1].id ?? fallback);
}
