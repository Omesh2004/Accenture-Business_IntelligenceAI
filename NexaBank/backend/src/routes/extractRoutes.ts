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
      include: { customer: true },
    });
    const decided = new Set(["APPROVED", "REJECTED"]);
    const records = rows.map((a) => ({
      application_id: a.id,
      tenant_id: analyticsTenant(a.customer?.tenantId || "bank_a"),
      customer_id: a.customerId,
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

// ─── GET /api/extract/loans ────────────────────────────────────────────────
router.get("/extract/loans", async (req: Request, res: Response): Promise<void> => {
  if (!requireExtractToken(req, res)) return;
  try {
    const { since, sinceId, limit } = parseParams(req);
    const rows = await prisma.loan.findMany({
      where: keysetWhere("updatedOn", since, sinceId),
      orderBy: [{ updatedOn: "asc" }, { id: "asc" }],
      take: limit,
      include: { Account: { include: { customer: true } } },
    });
    const records = rows.map((l) => ({
      loan_id: l.id,
      tenant_id: analyticsTenant(l.Account?.customer?.tenantId || "bank_a"),
      account_no: l.accNo,
      loan_type: l.loanType,
      principal_amount: l.principalAmount,
      interest_amount: l.interestAmount,
      interest_rate: l.interestRate,
      term_months: l.term,
      due_amount: l.dueAmount,
      is_active: l.status === "ACTIVE" ? 1 : 0,
      loan_status: l.status,
      started_at: l.startDate.toISOString(),
      updated_at: l.updatedOn.toISOString(),
    }));
    res.json({
      entity: "loans", count: records.length,
      watermark: nextWatermark(rows.map((r) => ({ ts: r.updatedOn })), since),
      cursor_id: nextCursorId(rows, sinceId),
      has_more: records.length === limit, records,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── GET /api/extract/account_snapshot ─────────────────────────────────────
// A point-in-time SNAPSHOT, not a change feed: balances have no history in the source, so the
// loader stamps the extract date. Snapshots must never be summed across dates downstream.
router.get("/extract/account_snapshot", async (req: Request, res: Response): Promise<void> => {
  if (!requireExtractToken(req, res)) return;
  try {
    const { limit } = parseParams(req);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = await prisma.account.findMany({
      orderBy: { accNo: "asc" }, take: limit, skip: offset,
      include: { customer: true, branch: true },
    });
    const records = rows.map((a) => ({
      account_no: a.accNo,
      tenant_id: analyticsTenant(a.customer?.tenantId || "bank_a"),
      customer_id: a.customerId,
      account_type: a.accountType,
      balance: a.balance,
      // Derived from the business lifecycle, not the operational transact flag, so analytics has
      // one definition of "active".
      is_active: a.lifecycleStatus === "ACTIVE" ? 1 : 0,
      lifecycle_status: a.lifecycleStatus,
      interest_rate: a.interestRate,
      branch_code: a.branchCode || "",
      region: a.branch?.region || "",
      opened_at: a.createdOn.toISOString(),
    }));
    res.json({
      entity: "account_snapshot", count: records.length,
      offset, has_more: records.length === limit, records,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
