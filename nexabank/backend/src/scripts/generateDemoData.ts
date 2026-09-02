/**
 * Rebuild the demo dataset by driving /events/simulate, which is the only generator that writes
 * BOTH telemetry and real core-banking rows (customers, accounts, transactions, applications,
 * loans). Seeding the tables directly would produce facts with no matching clickstream.
 *
 * Runs through the real auth path rather than minting a token, so the admin guard on
 * /events/simulate is exercised the way a browser would exercise it.
 *
 *   docker compose exec nexabank-backend npx tsx src/scripts/generateDemoData.ts
 */
import { randomBytes } from "crypto";

import { prisma } from "../prisma";

const BASE = process.env.SIM_BASE_URL || "http://localhost:5000";
const SIM_EMAIL = "sim-operator@nexabank.internal";
// Minted per run and never persisted in plaintext: an ADMIN account with a default
// password committed to the repo would be a standing credential, not a fixture.
const SIM_PASSWORD = randomBytes(24).toString("hex");
const UA = "nexabank-demo-generator";

interface Batch {
  label: string;
  tenantId: string;
  count: number;
  days: number;
  behavior?: Record<string, unknown>;
  // Baseline batches create the population; the recent cohorts act on customers it made.
  createAccounts?: boolean;
  phase?: 1 | 2;
}

/**
 * Baseline first, then a shorter recent batch whose behaviour differs. The recent batch is what
 * gives Detect a real movement to find: nothing records that it happened, so the intelligence
 * layer has to infer it from the shape of the events.
 */
/**
 * Two shapes of batch, and both matter.
 *
 * BASELINE spans 50 days at raised KYC and lending rates. The generator's stock rates
 * (`applicationMultiplier: 0.15`, `kyc.startRate: 0.25`) yield roughly 26 loan applications per
 * 130 users over 5 weeks, which is below every min_denominator the Trust Gate enforces -- the
 * layer abstains, correctly, and the demo shows nothing.
 *
 * RECENT plants a movement. `windowDays: 7` applies the override to the trailing 7 days only, so
 * one cohort steps down while the baseline cohort keeps running: a genuine before/after inside one
 * window, recorded nowhere. `days: 12` rather than 7 is deliberate -- the generator gates loan
 * applications on `day > 5`, so a 7-day cohort can never apply for one.
 *
 * Cost is user-days, not users: ~300 user-days per minute measured.
 */
const HIGH_VOLUME = {
  kyc: { startRate: 0.9, progressMultiplier: 3.0, successRate: 0.88 },
  loans: { applicationMultiplier: 3.5, approvalRate: 0.78 },
};

const PLAN: Batch[] = [
  { createAccounts: true, phase: 1, label: "nexabank baseline a", tenantId: "bank_a", count: 70, days: 55,
    behavior: { windowDays: 55, ...HIGH_VOLUME } },
  { createAccounts: true, phase: 1, label: "nexabank baseline b", tenantId: "bank_a", count: 70, days: 55,
    behavior: { windowDays: 55, ...HIGH_VOLUME } },
  { createAccounts: true, phase: 1, label: "nexabank baseline c", tenantId: "bank_a", count: 60, days: 55,
    behavior: { windowDays: 55, ...HIGH_VOLUME } },
  {
    phase: 2, label: "nexabank recent: approvals fall, skewed to mobile",
    tenantId: "bank_a", count: 45, days: 12,
    behavior: { windowDays: 7,
                kyc: { startRate: 0.9, progressMultiplier: 3.0, successRate: 0.85 },
                loans: { applicationMultiplier: 3.5, approvalRate: 0.28 },
                mix: { deviceWeights: { mobile: 4 } } },
  },
  {
    phase: 2, label: "nexabank recent: second degraded cohort",
    tenantId: "bank_a", count: 45, days: 12,
    behavior: { windowDays: 7,
                kyc: { startRate: 0.9, progressMultiplier: 3.0, successRate: 0.85 },
                loans: { applicationMultiplier: 3.5, approvalRate: 0.24 },
                mix: { deviceWeights: { mobile: 4 } } },
  },
];

async function ensureOperator(): Promise<void> {
  const bcrypt = await import("bcryptjs");
  const existing = await prisma.customer.findUnique({ where: { email: SIM_EMAIL } });
  const password = await bcrypt.hash(SIM_PASSWORD, 10);
  if (existing) {
    await prisma.customer.update({ where: { email: SIM_EMAIL }, data: { password, role: "ADMIN" } });
    return;
  }
  await prisma.customer.create({
    data: {
      name: "Simulation Operator", email: SIM_EMAIL, password, role: "ADMIN",
      tenantId: "bank_a", pan: "SIMOP0000X", phone: "9000000001",
      dateOfBirth: new Date("1990-01-01"),
      address: { line1: "internal" }, settingConfig: {},
    },
  });
}

/** The API may still be booting after a restart; a fixed sleep is a guess, this is not. */
async function waitForApi(attempts = 30): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await fetch(`${BASE}/api/health/forwarder`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`API at ${BASE} never became reachable`);
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ email: SIM_EMAIL, password: SIM_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("login returned no cookie");
  return cookie.split(";")[0];
}

async function run(): Promise<void> {
  await waitForApi();
  await ensureOperator();
  const cookie = await login();
  console.log("authenticated as the simulation operator\n");

  const totals = { users: 0, events: 0, txns: 0, apps: 0, loans: 0 };

  /** Wait until no new customer row has appeared for `quietMs`; a batch is done when the
   *  database stops growing, not when the HTTP call returns. */
  async function waitUntilQuiet(quietMs = 90_000, pollMs = 15_000): Promise<void> {
    let last = -1;
    let lastChange = Date.now();
    for (;;) {
      const n = await prisma.customer.count();
      if (n !== last) {
        last = n;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= quietMs) {
        return;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async function runBatch(batch: Batch): Promise<void> {
    const started = Date.now();
    const res = await fetch(`${BASE}/api/events/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA, Cookie: cookie },
      body: JSON.stringify({
        count: batch.count, days: batch.days, tenantId: batch.tenantId,
        ...(batch.createAccounts ? { createAccounts: true } : {}),
        ...(batch.behavior ? { behavior: batch.behavior } : {}),
      }),
    });
    if (!res.ok) {
      console.error(`  FAILED ${batch.label}: ${res.status} ${await res.text()}`);
      process.exitCode = 1;
      return;
    }
    const body = (await res.json()) as Record<string, number>;
    totals.users += body.usersCreated || 0;
    totals.events += body.eventsCreated || 0;
    totals.txns += body.transactionsCreated || 0;
    totals.apps += body.applicationsCreated || 0;
    totals.loans += body.loansDisbursed || 0;
    console.log(
      `  done ${batch.label}: users=${body.usersCreated} events=${body.eventsCreated} ` +
      `txns=${body.transactionsCreated} apps=${body.applicationsCreated} ` +
      `loans=${body.loansDisbursed} (${Math.round((Date.now() - started) / 1000)}s)`
    );
  }

  // Phase 1 builds the population, phase 2 acts on it. Run concurrently within a phase but
  // never across: a phase-2 batch against an empty tenant is refused with 409.
  for (const phase of [1, 2] as const) {
    const batches = PLAN.filter((b) => (b.phase ?? 1) === phase);
    if (!batches.length) continue;
    console.log(`
phase ${phase}: ${batches.length} batches concurrently...`);
    // A slow batch outlives the client's header timeout. Losing the response loses the per-batch
    // summary, not the data, so a timeout is reported and the run still waits for the writes.
    await Promise.all(batches.map((b) => runBatch(b).catch(() => {
      console.warn(`  ${b.label}: response lost; the request is still generating`);
    })));
    console.log("waiting for writes to settle...");
    await waitUntilQuiet();
  }

  console.log(`\ntotals: ${JSON.stringify(totals)}`);
  console.log("db:", JSON.stringify({
    customers: await prisma.customer.count(),
    accounts: await prisma.account.count(),
    transactions: await prisma.transaction.count(),
    applications: await prisma.loanApplication.count(),
    loans: await prisma.loan.count(),
  }));
}

run()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
