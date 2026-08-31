/**
 * Source C — branch operations and macro environment. Slow-moving reference data, monthly grain.
 *
 * Deterministic and idempotent: every value is a function of (region, month), never a random
 * draw, so re-seeding overwrites in place and the intelligence layer's determinism guarantee is
 * not undermined by its own inputs moving.
 *
 * The Europe competitor-rate rise in the most recent months is the planted EXTERNAL driver.
 * Nothing records that it is a driver; the engine has to reach for it when internal causes fail
 * to explain a deposit movement.
 *
 * GEOGRAPHY IS GLOBAL, AND THAT IS A CONTRACT.
 * -------------------------------------------
 * `region` is a CONTINENT, and every branch city is drawn from the same worldwide set the
 * clickstream producers emit (`GEO_PROFILES` in eventTracker.ts, `WORLDWIDE_CITIES` in
 * eventRoutes.ts, `GEO` in scripts/seed_data.py). This used to be four US regions with US
 * cities, which meant the bank had two disjoint geographies: the dashboard's Geographic
 * Distribution showed India, USA and Brazil while an intelligence answer about
 * net_deposit_growth said "Northeast" -- a place that appeared on no chart. A reader could not
 * reconcile them, and nothing failed to make that visible.
 *
 * `tests/test_geo_vocabulary_alignment.py` asserts the sets still agree. If you add a branch,
 * its city must already exist in the clickstream vocabulary or that test fails.
 *
 *   docker compose exec nexabank-backend npx tsx src/scripts/seedReferenceData.ts
 */
import { prisma } from "../prisma";

/** Continents, matching the dashboard's Geographic Distribution continent view exactly. */
const REGIONS = ["Asia", "Europe", "North America", "South America", "Africa", "Oceania"];

const BRANCHES = [
  { code: "AS-014", name: "Mumbai Nariman Point", region: "Asia", country: "India", city: "Mumbai", head: 24, tenantId: "bank_a" },
  { code: "AS-021", name: "Singapore Raffles", region: "Asia", country: "Singapore", city: "Singapore", head: 31, tenantId: "bank_a" },
  { code: "AS-033", name: "Tokyo Marunouchi", region: "Asia", country: "Japan", city: "Tokyo", head: 18, tenantId: "bank_a" },
  { code: "EU-007", name: "London Canary Wharf", region: "Europe", country: "United Kingdom", city: "London", head: 27, tenantId: "bank_a" },
  { code: "EU-012", name: "Berlin Mitte", region: "Europe", country: "Germany", city: "Berlin", head: 15, tenantId: "bank_a" },
  { code: "EU-024", name: "Paris La Defense", region: "Europe", country: "France", city: "Paris", head: 21, tenantId: "bank_a" },
  { code: "NA-005", name: "Manhattan Midtown", region: "North America", country: "USA", city: "New York", head: 22, tenantId: "bank_a" },
  { code: "NA-019", name: "San Francisco SoMa", region: "North America", country: "USA", city: "San Francisco", head: 20, tenantId: "bank_a" },
  { code: "NA-031", name: "Toronto Bay Street", region: "North America", country: "Canada", city: "Toronto", head: 17, tenantId: "bank_a" },
  { code: "SA-003", name: "Sao Paulo Faria Lima", region: "South America", country: "Brazil", city: "São Paulo", head: 29, tenantId: "bank_a" },
  { code: "AF-011", name: "Lagos Victoria Island", region: "Africa", country: "Nigeria", city: "Lagos", head: 17, tenantId: "bank_a" },
  { code: "OC-002", name: "Sydney CBD", region: "Oceania", country: "Australia", city: "Sydney", head: 19, tenantId: "bank_a" },
];

const MANAGERS = ["A. Whitfield", "R. Okonkwo", "M. Delgado", "S. Nakamura", "P. Lindqvist",
  "J. Abara", "T. Moreau", "K. Haddad", "L. Petrova", "D. Castellanos",
  "N. Rasmussen", "F. Oyelaran", "C. Bergstrom", "H. Nakamura", "E. Sowande",
  "V. Marchetti"];

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
 * Competitor deposit rate. Flat everywhere except Europe, which steps up sharply in the
 * two most recent months -- the external pressure that explains a deposit outflow no internal
 * segment accounts for.
 */
function competitorRate(region: string, index: number, total: number): number {
  const base: Record<string, number> = { Asia: 3.1, Europe: 3.4, "North America": 3.3,
    "South America": 3.6, Africa: 3.8, Oceania: 3.2 };
  const rate = base[region] ?? 3.2;
  const monthsFromEnd = total - 1 - index;
  if (region === "Europe" && monthsFromEnd <= 1) return 5.0;
  if (region === "Europe" && monthsFromEnd === 2) return 4.1;
  // A slow, deterministic drift so the series is not perfectly flat.
  return Number((rate + (index % 3) * 0.05).toFixed(2));
}

function baseRate(index: number): number {
  return Number((4.25 + (index % 4) * 0.05).toFixed(2));
}

function unemployment(region: string, index: number): number {
  const base: Record<string, number> = { Asia: 4.3, Europe: 4.1, "North America": 4.4,
    "South America": 5.2, Africa: 5.8, Oceania: 3.9 };
  const rate = base[region] ?? 4.2;
  return Number((rate + ((index % 5) - 2) * 0.1).toFixed(2));
}

/**
 * The US-region branch codes this file used to seed, mapped onto their global replacements.
 *
 * Idempotent: once the legacy rows are gone this is a no-op. It exists because `upsert` keys on
 * `code`, so globalising the list ADDS the new branches and silently strands every customer and
 * account still pointing at an old one -- they would keep reporting `region: "Northeast"` forever
 * while the seeder claimed the bank was global.
 *
 * The three Northeast branches map to Europe deliberately: that cohort is the planted deposit
 * outflow, and Europe is where the competitor-rate step now lives. Breaking that pairing would
 * leave the multi-source scenario with an internal segment and no external driver.
 */
const LEGACY_BRANCH_MAP: Record<string, string> = {
  "NE-014": "EU-007", "NE-021": "EU-012", "NE-033": "EU-024",
  "MW-007": "AS-014", "MW-012": "AS-021",
  "ST-005": "AS-033", "ST-019": "NA-005",
  "WT-003": "NA-019", "WT-011": "SA-003",
};

async function retireLegacyBranches(): Promise<Record<string, number>> {
  let customers = 0, accounts = 0, removed = 0;
  for (const [from, to] of Object.entries(LEGACY_BRANCH_MAP)) {
    if (!(await prisma.branch.findUnique({ where: { code: from } }))) continue;
    customers += (await prisma.customer.updateMany({
      where: { branchCode: from }, data: { branchCode: to } })).count;
    accounts += (await prisma.account.updateMany({
      where: { branchCode: from }, data: { branchCode: to } })).count;
    await prisma.branch.delete({ where: { code: from } });
    removed++;
  }
  // Macro rows are keyed on (region, month), so upserting the new regions ADDS to the old ones
  // rather than replacing them. Left behind, the extract keeps returning retired regions as live
  // reference data -- and because that source re-reads in full, downstream has no way to tell
  // they are dead. Delete anything outside the declared region set.
  const macro = await prisma.macroEnvironment.deleteMany({
    where: { region: { notIn: REGIONS } },
  });
  return { customers, accounts, removed, macroRowsRemoved: macro.count };
}

async function main() {
  for (const [i, b] of BRANCHES.entries()) {
    await prisma.branch.upsert({
      where: { code: b.code },
      update: { name: b.name, region: b.region, country: b.country, city: b.city,
                staffingHeadcount: b.head,
                managerName: MANAGERS[i % MANAGERS.length], tenantId: b.tenantId },
      create: { code: b.code, name: b.name, region: b.region, country: b.country,
                city: b.city,
                staffingHeadcount: b.head, managerName: MANAGERS[i % MANAGERS.length],
                tenantId: b.tenantId,
                openedOn: new Date(Date.UTC(2010 + (i % 12), i % 12, 1)) },
    });
  }

  // After the new branches exist, never before: the re-point is an FK write and its target has
  // to be there already.
  const retired = await retireLegacyBranches();

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
    retiredLegacyBranches: retired,
    plantedDriverLatest: await prisma.macroEnvironment.findFirst({
      where: { region: "Europe" }, orderBy: { monthYear: "desc" },
      select: { region: true, monthYear: true, competitorDepositRate: true },
    }),
  }));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
