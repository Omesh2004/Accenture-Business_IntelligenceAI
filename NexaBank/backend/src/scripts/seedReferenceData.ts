/**
 * Source C — branch operations and macro environment. Slow-moving reference data, monthly grain.
 *
 * Deterministic and idempotent: every value is a function of (region, month), never a random
 * draw, so re-seeding overwrites in place and the intelligence layer's determinism guarantee is
 * not undermined by its own inputs moving.
 *
 * The Northeast competitor-rate rise in the most recent months is the planted EXTERNAL driver.
 * Nothing records that it is a driver; the engine has to reach for it when internal causes fail
 * to explain a deposit movement.
 *
 *   docker compose exec nexabank-backend npx tsx src/scripts/seedReferenceData.ts
 */
import { prisma } from "../prisma";

const REGIONS = ["Northeast", "Midwest", "South", "West"];

const BRANCHES = [
  { code: "NE-014", name: "Boston Downtown", region: "Northeast", city: "Boston", head: 24, tenantId: "bank_a" },
  { code: "NE-021", name: "Manhattan Midtown", region: "Northeast", city: "New York", head: 31, tenantId: "bank_a" },
  { code: "NE-033", name: "Philadelphia Center", region: "Northeast", city: "Philadelphia", head: 18, tenantId: "bank_a" },
  { code: "MW-007", name: "Chicago Loop", region: "Midwest", city: "Chicago", head: 27, tenantId: "bank_a" },
  { code: "MW-012", name: "Detroit Riverfront", region: "Midwest", city: "Detroit", head: 15, tenantId: "bank_a" },
  { code: "ST-005", name: "Atlanta Peachtree", region: "South", city: "Atlanta", head: 22, tenantId: "bank_a" },
  { code: "ST-019", name: "Dallas Uptown", region: "South", city: "Dallas", head: 20, tenantId: "bank_a" },
  { code: "WT-003", name: "San Francisco SoMa", region: "West", city: "San Francisco", head: 29, tenantId: "bank_a" },
  { code: "WT-011", name: "Seattle Pike", region: "West", city: "Seattle", head: 17, tenantId: "bank_a" },
  { code: "SB-101", name: "SafeX Boston", region: "Northeast", city: "Boston", head: 14, tenantId: "bank_b" },
  { code: "SB-205", name: "SafeX Chicago", region: "Midwest", city: "Chicago", head: 12, tenantId: "bank_b" },
  { code: "SB-309", name: "SafeX Austin", region: "South", city: "Austin", head: 11, tenantId: "bank_b" },
  { code: "SB-402", name: "SafeX Portland", region: "West", city: "Portland", head: 10, tenantId: "bank_b" },
];

const MANAGERS = ["A. Whitfield", "R. Okonkwo", "M. Delgado", "S. Nakamura", "P. Lindqvist",
  "J. Abara", "T. Moreau", "K. Haddad", "L. Petrova", "D. Castellanos",
  "N. Rasmussen", "F. Oyelaran", "C. Bergstrom"];

/** Months back from today, oldest first, as YYYY-MM plus the first-of-month date. */
function months(count: number): Array<{ key: string; date: Date }> {
  const out: Array<{ key: string; date: Date }> = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push({ key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, date: d });
  }
  return out;
}

/**
 * Competitor deposit rate. Flat everywhere except the Northeast, which steps up sharply in the
 * two most recent months -- the external pressure that explains a deposit outflow no internal
 * segment accounts for.
 */
function competitorRate(region: string, index: number, total: number): number {
  const base = { Northeast: 3.4, Midwest: 3.1, South: 3.2, West: 3.3 }[region] ?? 3.2;
  const monthsFromEnd = total - 1 - index;
  if (region === "Northeast" && monthsFromEnd <= 1) return 5.0;
  if (region === "Northeast" && monthsFromEnd === 2) return 4.1;
  // A slow, deterministic drift so the series is not perfectly flat.
  return Number((base + (index % 3) * 0.05).toFixed(2));
}

function baseRate(index: number): number {
  return Number((4.25 + (index % 4) * 0.05).toFixed(2));
}

function unemployment(region: string, index: number): number {
  const base = { Northeast: 4.1, Midwest: 4.6, South: 3.9, West: 4.4 }[region] ?? 4.2;
  return Number((base + ((index % 5) - 2) * 0.1).toFixed(2));
}

async function main() {
  for (const [i, b] of BRANCHES.entries()) {
    await prisma.branch.upsert({
      where: { code: b.code },
      update: { name: b.name, region: b.region, city: b.city, staffingHeadcount: b.head,
                managerName: MANAGERS[i % MANAGERS.length], tenantId: b.tenantId },
      create: { code: b.code, name: b.name, region: b.region, city: b.city,
                staffingHeadcount: b.head, managerName: MANAGERS[i % MANAGERS.length],
                tenantId: b.tenantId,
                openedOn: new Date(Date.UTC(2010 + (i % 12), i % 12, 1)) },
    });
  }

  const series = months(14);
  for (const region of REGIONS) {
    for (const [i, m] of series.entries()) {
      const values = {
        competitorDepositRate: competitorRate(region, i, series.length),
        centralBankBaseRate: baseRate(i),
        regionalUnemploymentRate: unemployment(region, i),
        recordedOn: m.date,
      };
      await prisma.macroEnvironment.upsert({
        where: { region_monthYear: { region, monthYear: m.key } },
        update: values,
        create: { region, monthYear: m.key, ...values },
      });
    }
  }

  // ── Source B: campaigns. Interactions are generated per customer by the simulator; the
  //    campaigns themselves are reference data with a known spend, which is CPA's numerator.
  const today = new Date();
  const day = (offset: number) =>
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
  const CAMPAIGNS = [
    { name: "Q3 High-Yield Savings Promo", channel: "EMAIL" as const, segment: "ALL",
      from: -55, to: -5, spend: 48000, tenantId: "bank_a" },
    { name: "Student Card Launch", channel: "APP_PUSH" as const, segment: "STUDENT",
      from: -12, to: 14, spend: 16500, tenantId: "bank_a" },
    { name: "Premium Upgrade Drive", channel: "SMS" as const, segment: "LOW",
      from: -40, to: -2, spend: 27000, tenantId: "bank_a" },
    { name: "Branch Loyalty Outreach", channel: "BRANCH" as const, segment: "MEDIUM",
      from: -30, to: 7, spend: 12000, tenantId: "bank_a" },
    { name: "SafeX Savings Switch", channel: "EMAIL" as const, segment: "ALL",
      from: -45, to: -3, spend: 31000, tenantId: "bank_b" },
    { name: "SafeX Student Onboarding", channel: "APP_PUSH" as const, segment: "STUDENT",
      from: -14, to: 10, spend: 9800, tenantId: "bank_b" },
  ];
  for (const c of CAMPAIGNS) {
    const existing = await prisma.campaign.findFirst({
      where: { name: c.name, tenantId: c.tenantId }, select: { id: true },
    });
    const values = { name: c.name, channel: c.channel, targetSegment: c.segment,
                     startDate: day(c.from), endDate: day(c.to), spend: c.spend,
                     tenantId: c.tenantId };
    if (existing) {
      await prisma.campaign.update({ where: { id: existing.id }, data: values });
    } else {
      await prisma.campaign.create({ data: values });
    }
  }

  console.log(JSON.stringify({
    branches: await prisma.branch.count(),
    campaigns: await prisma.campaign.count(),
    macroRows: await prisma.macroEnvironment.count(),
    months: series.length,
    northeastLatest: await prisma.macroEnvironment.findFirst({
      where: { region: "Northeast" }, orderBy: { monthYear: "desc" },
      select: { monthYear: true, competitorDepositRate: true },
    }),
  }));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
