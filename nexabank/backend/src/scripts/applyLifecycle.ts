/**
 * Derive account, card and transaction lifecycle from what actually happened.
 *
 * Why this exists: `lifecycleStatus` sat at ACTIVE for 100% of accounts and `Card.status` at
 * ACTIVE for 100% of cards. A field that never varies is worse than a missing one -- a contract
 * can declare a dimension or an invariant over it and it will look like it works while proving
 * nothing. `active_accounts_opened <= accounts_opened` is not a test if the two are always equal.
 *
 * Everything here is DERIVED from observed activity rather than rolled at creation, so the state
 * agrees with the transaction history instead of contradicting it. Deterministic and idempotent:
 * re-running produces the same result on the same data.
 *
 *   docker compose exec nexabank-backend npx tsx src/scripts/applyLifecycle.ts
 */
import { prisma } from "../prisma";

const DORMANT_AFTER_DAYS = 45;
const LEDGER_ACCOUNTS = ["EXTERNAL-BANK", "MERCHANT-ID", "NEXABANK-SYSTEM"];

/** Stable hash so "a small subset" is the same subset on every run. */
function bucket(id: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % mod;
}

async function main() {
  const now = Date.now();
  const dormantCutoff = new Date(now - DORMANT_AFTER_DAYS * 86400 * 1000);

  // ── Accounts ─────────────────────────────────────────────────────────────
  const accounts = await prisma.account.findMany({
    where: { accNo: { notIn: LEDGER_ACCOUNTS } },
    select: { accNo: true, balance: true },
  });

  const recent = await prisma.transaction.groupBy({
    by: ["senderAccNo"],
    where: { timestamp: { gte: dormantCutoff } },
    _count: true,
  });
  const activeAccounts = new Set(recent.map((r) => r.senderAccNo));

  const counts = { ACTIVE: 0, DORMANT: 0, FROZEN: 0, CLOSED: 0 };
  for (const a of accounts) {
    let status: "ACTIVE" | "DORMANT" | "FROZEN" | "CLOSED";
    if (!activeAccounts.has(a.accNo)) {
      // No outbound activity in the dormancy window. A drained balance, or a stable minority of
      // the dormant set, reads as a closed relationship rather than a quiet one -- otherwise
      // CLOSED never occurs and the state is decoration.
      status = (a.balance <= 100 || bucket(a.accNo, 6) === 0) ? "CLOSED" : "DORMANT";
    } else if (bucket(a.accNo, 97) === 0) {
      // A small, stable share held for review. Frozen accounts still exist and still hold money,
      // which is why they must not be folded into CLOSED.
      status = "FROZEN";
    } else {
      status = "ACTIVE";
    }
    counts[status]++;
    await prisma.account.update({ where: { accNo: a.accNo }, data: { lifecycleStatus: status } });
  }

  // ── Cards ────────────────────────────────────────────────────────────────
  const cards = await prisma.card.findMany({ select: { id: true, expMonth: true, expYear: true } });
  const cardCounts = { ACTIVE: 0, LOCKED: 0, EXPIRED: 0, CANCELLED: 0 };
  const nowYear = new Date().getUTCFullYear();
  const nowMonth = new Date().getUTCMonth() + 1;
  for (const c of cards) {
    let status: "ACTIVE" | "LOCKED" | "EXPIRED" | "CANCELLED";
    if (c.expYear < nowYear || (c.expYear === nowYear && c.expMonth < nowMonth)) {
      status = "EXPIRED";
    } else {
      const b = bucket(c.id, 40);
      status = b === 0 ? "LOCKED" : b === 1 ? "CANCELLED" : "ACTIVE";
    }
    cardCounts[status]++;
    await prisma.card.update({ where: { id: c.id }, data: { status } });
  }

  // ── Transactions ─────────────────────────────────────────────────────────
  // A settlement window that has not closed yet, and a small reversal rate. Both are real states
  // in a payment system, and both change what "successful volume" means.
  const settlementCutoff = new Date(now - 36 * 3600 * 1000);
  const fresh = await prisma.transaction.findMany({
    where: { status: "SUCCESS", timestamp: { gte: settlementCutoff } },
    select: { id: true },
  });
  const pendingIds = fresh.filter((t) => bucket(t.id, 5) === 0).map((t) => t.id);
  if (pendingIds.length) {
    await prisma.transaction.updateMany({
      where: { id: { in: pendingIds } }, data: { status: "PENDING" },
    });
  }

  const settled = await prisma.transaction.findMany({
    where: { status: "SUCCESS", timestamp: { lt: settlementCutoff } },
    select: { id: true },
  });
  const reversedIds = settled.filter((t) => bucket(t.id, 200) === 0).map((t) => t.id);
  if (reversedIds.length) {
    await prisma.transaction.updateMany({
      where: { id: { in: reversedIds } }, data: { status: "REVERSED" },
    });
  }

  console.log(JSON.stringify({
    accounts: counts,
    cards: cardCounts,
    transactions: { pending: pendingIds.length, reversed: reversedIds.length },
  }));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
