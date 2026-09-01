import express, { Request, Response } from "express";
import { prisma } from "../prisma";
import { analyticsTenant, parseParams, nextWatermark, nextCursorId, keysetWhere, requireExtractToken } from "./extractShared";

/**
 * Extract endpoints for the non-core sources.
 *
 *   Source A (core banking)  -> extractRoutes.ts   real-time / hourly, txn + account grain
 *   Source B (CRM/marketing) -> here               weekly, customer + campaign grain
 *   Source C (branch + macro)-> here               monthly, regional grain
 *
 * They are separate systems in the story and separate source_ids downstream, because their grains
 * and refresh cadences genuinely differ -- one global freshness rule cannot gate all three.
 */
const router = express.Router();

// ─── Source A extras: account openings and cards ───────────────────────────
// Openings are a CHANGE FEED on createdOn; account_snapshot is a point-in-time balance sheet.
// Openings are additive over time, balances are not, so they must not share a table.
router.get("/extract/accounts", async (req: Request, res: Response): Promise<void> => {
  if (!requireExtractToken(req, res)) return;
  try {
    const { since, sinceId, limit } = parseParams(req);
    const rows = await prisma.account.findMany({
      where: keysetWhere("createdOn", since, sinceId),
      orderBy: [{ createdOn: "asc" }, { accNo: "asc" }],
      take: limit,
      include: { customer: true, branch: true },
    });
    res.json({
      entity: "accounts",
      count: rows.length,
      watermark: nextWatermark(rows.map((r) => ({ ts: r.createdOn })), since),
      cursor_id: nextCursorId(rows, sinceId),
      has_more: rows.length === limit,
      records: rows.map((a) => ({
        account_no: a.accNo,
        tenant_id: analyticsTenant(a.customer?.tenantId || "bank_a"),
        customer_id: a.customerId,
        account_type: a.accountType,
        lifecycle_status: a.lifecycleStatus,
        interest_rate: a.interestRate,
        branch_code: a.branchCode || "",
        region: a.branch?.region || "",
        country: a.branch?.country || "",
        opened_at: a.createdOn.toISOString(),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});


// ─── Source B: CRM and marketing ───────────────────────────────────────────
router.get("/extract/customers", async (req: Request, res: Response): Promise<void> => {
  if (!requireExtractToken(req, res)) return;
  try {
    const { limit } = parseParams(req);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = await prisma.customer.findMany({
      orderBy: { id: "asc" }, take: limit, skip: offset,
      include: { branch: true },
    });
    res.json({
      entity: "customers",
      count: rows.length,
      offset,
      has_more: rows.length === limit,
      records: rows.map((c) => ({
        customer_id: c.id,
        tenant_id: analyticsTenant(c.tenantId || "bank_a"),
        age_bracket: c.ageBracket || "",
        income_bracket: c.incomeBracket || "",
        employment_status: c.employmentStatus || "",
        risk_segment: c.riskSegment || "",
        lifetime_value: c.lifetimeValue,
        kyc_status: c.kycStatus,
        branch_code: c.branchCode || "",
        region: c.branch?.region || "",
        country: c.branch?.country || "",
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});


// ─── Source C: branch operations and macro environment ─────────────────────
router.get("/extract/branches", async (req: Request, res: Response): Promise<void> => {
  if (!requireExtractToken(req, res)) return;
  try {
    const rows = await prisma.branch.findMany({ orderBy: { code: "asc" } });
    res.json({
      entity: "branches",
      count: rows.length,
      has_more: false,
      records: rows.map((b) => ({
        branch_code: b.code,
        tenant_id: analyticsTenant(b.tenantId || "bank_a"),
        name: b.name,
        region: b.region,
        country: b.country,
        city: b.city,
        manager_name: b.managerName,
        staffing_headcount: b.staffingHeadcount,
        opened_at: b.openedOn.toISOString(),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});


export default router;
