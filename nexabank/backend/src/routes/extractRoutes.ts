import express, { Request, Response } from "express";
import { prisma } from "../prisma";
import {
  analyticsTenant,
  parseParams,
  nextWatermark,
  nextCursorId,
  keysetWhere,
  requireExtractToken,
  EXTERNAL_ACCOUNT,
} from "./extractShared";

/**
 * Source A - core banking. The source-system boundary for transaction and account data.
 *
 * Exposed as an API rather than letting the analytics side connect to Postgres directly, so the
 * database credentials stay in one service and the contract between systems is explicit. Every
 * endpoint is watermarked and page-bounded, so a loader resumes instead of re-reading history.
 */
const router = express.Router();

// ─── GET /api/extract/transactions ─────────────────────────────────────────
router.get("/extract/transactions", async (req: Request, res: Response): Promise<void> => {
  if (!requireExtractToken(req, res)) return;
  try {
    const { since, sinceId, limit } = parseParams(req);
    // updatedOn, not timestamp. timestamp is event time and never moves, so a status change
    // (SUCCESS -> PENDING/REVERSED) was never re-extracted and the analytics copy stayed SUCCESS
    // forever — wrong for every KPI that filters on it.
    const rows = await prisma.transaction.findMany({
      where: keysetWhere("updatedOn", since, sinceId),
      orderBy: [{ updatedOn: "asc" }, { id: "asc" }],
      take: limit,
      include: {
        senderAccount: { include: { customer: true, branch: true } },
        receiverAccount: { include: { customer: true, branch: true } },
      },
    });
    const records = rows.map((t) => {
      // EXTERNAL-BANK is one shared account owned by a single bank_a customer, so reading tenant
      // from the sender attributed every inbound deposit -- including other tenants' salary
      // credits -- to nexabank. Attribute to whichever side is really the bank's own customer.
      const senderIsOwn = t.senderAccNo !== EXTERNAL_ACCOUNT && !!t.senderAccount?.customer;
      const owner = senderIsOwn ? t.senderAccount : t.receiverAccount;
      const counterparty = senderIsOwn ? t.receiverAccNo : t.senderAccNo;
      return {
        txn_id: t.id,
        tenant_id: analyticsTenant(owner?.customer?.tenantId || "bank_a"),
        customer_id: owner?.customerId || "",
        account_no: owner?.accNo || t.senderAccNo,
        counterparty_acc: counterparty,
        direction: senderIsOwn ? "out" : "in",
        branch_code: owner?.branchCode || "",
        region: owner?.branch?.region || "",
        country: owner?.branch?.country || "",
        mcc: t.merchantCategoryCode || "",
        merchant_name: t.merchantName || "",
        reference_number: t.referenceNumber || "",
        txn_type: t.transactionType,
        category: t.category || "",
        channel: t.channel,
        status: t.status,
        amount: t.amount,
        occurred_at: t.timestamp.toISOString(),
      };
    });
    res.json({
      entity: "transactions", count: records.length,
      watermark: nextWatermark(rows.map((r) => ({ ts: r.updatedOn })), since),
      cursor_id: nextCursorId(rows, sinceId),
      has_more: records.length === limit, records,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── GET /api/extract/loan_applications ────────────────────────────────────
// Applications MUTATE, so the cursor is updatedOn, not createdOn -- a status change must be
// re-extracted or the analytics copy keeps a stale outcome forever.
router.get("/extract/loan_applications", async (req: Request, res: Response): Promise<void> => {
  if (!requireExtractToken(req, res)) return;
  try {
    const { since, sinceId, limit } = parseParams(req);
    const rows = await prisma.loanApplication.findMany({
      where: keysetWhere("updatedOn", since, sinceId),
      orderBy: [{ updatedOn: "asc" }, { id: "asc" }],
      take: limit,
      include: { customer: { include: { branch: true } } },
    });
    const decided = new Set(["APPROVED", "REJECTED"]);
    const records = rows.map((a) => ({
      application_id: a.id,
      tenant_id: analyticsTenant(a.customer?.tenantId || "bank_a"),
      customer_id: a.customerId,
      branch_code: a.customer?.branchCode || "",
      region: a.customer?.branch?.region || "",
      country: a.customer?.branch?.country || "",
      risk_segment: a.customer?.riskSegment || "",
      loan_type: a.loanType,
      status: a.status,
      principal_amount: a.principalAmount,
      interest_rate: a.interestRate,
      term_months: a.term,
      kyc_step: a.kycStep,
      created_at: a.createdOn.toISOString(),
      decided_at: decided.has(a.status) ? a.updatedOn.toISOString() : null,
      updated_at: a.updatedOn.toISOString(),
    }));
    res.json({
      entity: "loan_applications", count: records.length,
      watermark: nextWatermark(rows.map((r) => ({ ts: r.updatedOn })), since),
      cursor_id: nextCursorId(rows, sinceId),
      has_more: records.length === limit, records,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});



export default router;
