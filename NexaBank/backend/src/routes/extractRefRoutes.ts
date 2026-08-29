import express, { Request, Response } from "express";
import { prisma } from "../prisma";
import { analyticsTenant, parseParams, nextWatermark, requireExtractToken } from "./extractShared";

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
    const { since, limit } = parseParams(req);
    const rows = await prisma.account.findMany({
      where: { createdOn: { gt: since } },
      orderBy: [{ createdOn: "asc" }, { accNo: "asc" }],
      take: limit,
      include: { customer: true, branch: true },
    });
    res.json({
      entity: "accounts",
      count: rows.length,
      watermark: nextWatermark(rows.map((r) => ({ ts: r.createdOn })), since),
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
        opened_at: a.createdOn.toISOString(),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/extract/cards", async (req: Request, res: Response): Promise<void> => {
  if (!requireExtractToken(req, res)) return;
  try {
    const { since, limit } = parseParams(req);
    const rows = await prisma.card.findMany({
      where: { updatedOn: { gt: since } },
      orderBy: [{ updatedOn: "asc" }, { id: "asc" }],
      take: limit,
      include: { customer: true, account: { include: { branch: true } } },
    });
    res.json({
      entity: "cards",
      count: rows.length,
      watermark: nextWatermark(rows.map((r) => ({ ts: r.updatedOn })), since),
      has_more: rows.length === limit,
      records: rows.map((c) => ({
        card_id: c.id,
        tenant_id: analyticsTenant(c.customer?.tenantId || "bank_a"),
        customer_id: c.customerId,
        account_no: c.accNo,
        product_name: c.productName,
        card_type: c.cardType,
        network: c.network,
        status: c.status,
        credit_limit: c.creditLimit ?? 0,
        region: c.account?.branch?.region || "",
        issued_at: c.issuedOn.toISOString(),
        updated_at: c.updatedOn.toISOString(),
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
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/extract/campaigns", async (req: Request, res: Response): Promise<void> => {
  if (!requireExtractToken(req, res)) return;
  try {
    const { since, limit } = parseParams(req);
    const rows = await prisma.campaign.findMany({
      where: { updatedOn: { gt: since } },
      orderBy: [{ updatedOn: "asc" }, { id: "asc" }],
      take: limit,
    });
    res.json({
      entity: "campaigns",
      count: rows.length,
      watermark: nextWatermark(rows.map((r) => ({ ts: r.updatedOn })), since),
      has_more: rows.length === limit,
      records: rows.map((c) => ({
        campaign_id: c.id,
        tenant_id: analyticsTenant(c.tenantId || "bank_a"),
        name: c.name,
        channel: c.channel,
        target_segment: c.targetSegment,
        start_date: c.startDate.toISOString().slice(0, 10),
        end_date: c.endDate.toISOString().slice(0, 10),
        spend: c.spend,
        updated_at: c.updatedOn.toISOString(),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// The funnel CPA divides by. Stored as events, never a pre-computed rate: a rate cannot be
// re-aggregated across segments without being wrong.
router.get("/extract/campaign_interactions", async (req: Request, res: Response): Promise<void> => {
  if (!requireExtractToken(req, res)) return;
  try {
    const { since, limit } = parseParams(req);
    const rows = await prisma.campaignInteraction.findMany({
      where: { occurredAt: { gt: since } },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: limit,
      include: { campaign: true, customer: { include: { branch: true } } },
    });
    res.json({
      entity: "campaign_interactions",
      count: rows.length,
      watermark: nextWatermark(rows.map((r) => ({ ts: r.occurredAt })), since),
      has_more: rows.length === limit,
      records: rows.map((i) => ({
        interaction_id: i.id,
        tenant_id: analyticsTenant(i.campaign?.tenantId || "bank_a"),
        campaign_id: i.campaignId,
        campaign_name: i.campaign?.name || "",
        channel: i.campaign?.channel || "",
        customer_id: i.customerId,
        interaction_type: i.type,
        risk_segment: i.customer?.riskSegment || "",
        region: i.customer?.branch?.region || "",
        occurred_at: i.occurredAt.toISOString(),
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

router.get("/extract/macro_environment", async (req: Request, res: Response): Promise<void> => {
  if (!requireExtractToken(req, res)) return;
  try {
    const rows = await prisma.macroEnvironment.findMany({
      orderBy: [{ region: "asc" }, { monthYear: "asc" }],
    });
    res.json({
      entity: "macro_environment",
      count: rows.length,
      has_more: false,
      records: rows.map((m) => ({
        region: m.region,
        month_year: m.monthYear,
        competitor_deposit_rate: m.competitorDepositRate,
        central_bank_base_rate: m.centralBankBaseRate,
        regional_unemployment_rate: m.regionalUnemploymentRate,
        recorded_at: m.recordedOn.toISOString(),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
