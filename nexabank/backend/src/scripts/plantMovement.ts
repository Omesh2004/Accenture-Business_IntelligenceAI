/**
 * Plant a strong, recent, localized movement in a demo tenant.
 *
 * The demo tenants drift back to "no material movement" as the scored window advances past the
 * cohorts that were degraded at generation time. Detect is right to stay quiet -- but a dashboard
 * with nothing to explain teaches nobody anything. This adds a fresh cohort whose behaviour is
 * degraded hard enough to clear the forecast band and the materiality floor, concentrated on
 * mobile so Localize has a real cell to find.
 *
 *   docker compose exec nexabank-backend npx tsx src/scripts/plantMovement.ts
 */
import { randomBytes } from "crypto";
import { prisma } from "../prisma";

const BASE = process.env.SIM_BASE_URL || "http://localhost:5000";
const SIM_EMAIL = "sim-operator@nexabank.internal";
const SIM_PASSWORD = randomBytes(24).toString("hex");
const UA = "nexabank-movement-planter";

const PLAN = [
  {
    label: "nexabank: sharp KYC + approval drop on mobile",
    tenantId: "bank_a", count: 40, days: 12,
    behavior: {
      windowDays: 6,
      kyc: { startRate: 0.95, progressMultiplier: 3.5, successRate: 0.22 },
      loans: { applicationMultiplier: 4.0, approvalRate: 0.18 },
      mix: { deviceWeights: { mobile: 6 } },
    },
  },
];

async function waitForApi(attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try { await fetch(`${BASE}/api/health/forwarder`); return; } catch { await new Promise(r => setTimeout(r, 2000)); }
  }
  throw new Error("API never became reachable");
}

async function main() {
  await waitForApi();
  const bcrypt = await import("bcryptjs");
  const password = await bcrypt.hash(SIM_PASSWORD, 10);
  await prisma.customer.update({ where: { email: SIM_EMAIL }, data: { password, role: "ADMIN" } });

  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ email: SIM_EMAIL, password: SIM_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];

  await Promise.all(PLAN.map(async (b) => {
    try {
      const r = await fetch(`${BASE}/api/events/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": UA, Cookie: cookie },
        body: JSON.stringify({ count: b.count, days: b.days, tenantId: b.tenantId, behavior: b.behavior }),
      });
      if (!r.ok) { console.error(`  FAILED ${b.label}: ${r.status}`); return; }
      const j = await r.json() as Record<string, number>;
      console.log(`  ${b.label}: users=${j.usersCreated} events=${j.eventsCreated} apps=${j.applicationsCreated}`);
    } catch {
      console.warn(`  ${b.label}: response lost; still generating server-side`);
    }
  }));

  let last = -1, stable = 0;
  while (stable < 4) {
    const n = await prisma.event.count();
    if (n === last) stable++; else { stable = 0; last = n; }
    await new Promise(r => setTimeout(r, 15000));
  }
  console.log("settled at", last, "events");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
