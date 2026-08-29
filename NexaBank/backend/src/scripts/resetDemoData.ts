/**
 * Drop all simulated banking data so it can be regenerated from /events/simulate.
 *
 * Preserves what the demo cannot rebuild: ADMIN logins, and the EXTERNAL-BANK clearing account
 * that every deposit is booked against. Deleting either leaves the app unusable rather than empty.
 *
 *   docker compose exec nexabank-backend npx tsx src/scripts/resetDemoData.ts --yes
 */
import { prisma } from "../prisma";

/** Ledger accounts every simulated transaction books against. Deleting one makes the next
 *  simulate run fail on a foreign key, not produce an empty dataset. */
const SYSTEM_ACCOUNTS = ["EXTERNAL-BANK", "MERCHANT-ID", "NEXABANK-SYSTEM"];

async function main() {
  if (!process.argv.includes("--yes")) {
    console.error("Refusing to delete without --yes. This removes every non-admin customer.");
    process.exit(2);
  }

  const keepCustomers = await prisma.customer.findMany({
    where: { role: { not: "USER" } },
    select: { id: true },
  });
  const keepIds = keepCustomers.map((c) => c.id);
  console.log(`preserving ${keepIds.length} admin customers and ${SYSTEM_ACCOUNTS.join(", ")}`);

  const before = {
    customers: await prisma.customer.count(),
    accounts: await prisma.account.count(),
    transactions: await prisma.transaction.count(),
    loans: await prisma.loan.count(),
    applications: await prisma.loanApplication.count(),
    events: await prisma.event.count(),
    cards: await prisma.card.count(),
    interactions: await prisma.campaignInteraction.count(),
  };

  // FK order: transactions reference loans and accounts; loans reference accounts;
  // accounts reference customers.
  // Event rows survive a customer delete (the FK nulls out), so a wipe that skips them leaves
  // stale telemetry behind to be re-forwarded on the next run.
  await prisma.event.deleteMany({});
  await prisma.notification.deleteMany({});
  await prisma.campaignInteraction.deleteMany({});
  await prisma.card.deleteMany({});
  await prisma.transaction.deleteMany({});
  await prisma.loan.deleteMany({});
  await prisma.loanApplication.deleteMany({});
  await prisma.userLocation.deleteMany({});
  await prisma.userLicense.deleteMany({});
  await prisma.payee.deleteMany({});
  await prisma.account.deleteMany({ where: { accNo: { notIn: SYSTEM_ACCOUNTS } } });
  await prisma.customer.deleteMany({ where: { id: { notIn: keepIds } } });

  // Ledger accounts must start flat, or a stale balance leaks into the new dataset.
  await prisma.account.updateMany({ where: { accNo: { in: SYSTEM_ACCOUNTS } }, data: { balance: 0 } });

  // Recreate any ledger account a previous run removed, so simulate never hits a foreign key.
  const systemCustomer = await prisma.customer.findFirst({ where: { role: { not: "USER" } } });
  if (systemCustomer) {
    for (const accNo of SYSTEM_ACCOUNTS) {
      await prisma.account.upsert({
        where: { accNo },
        update: {},
        create: { accNo, customerId: systemCustomer.id, ifsc: "NEXA0000001",
                  accountType: "SAVINGS", balance: 0, lifecycleStatus: "ACTIVE", investment: [] },
      });
    }
  }

  const after = {
    customers: await prisma.customer.count(),
    accounts: await prisma.account.count(),
    transactions: await prisma.transaction.count(),
    loans: await prisma.loan.count(),
    applications: await prisma.loanApplication.count(),
    events: await prisma.event.count(),
    cards: await prisma.card.count(),
    interactions: await prisma.campaignInteraction.count(),
  };
  console.log("before:", JSON.stringify(before));
  console.log("after: ", JSON.stringify(after));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
