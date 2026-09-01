/**
 * Bulk banking-fact generator: source A of the two-source model.
 *
 * The per-user simulation in /events/simulate produces a clickstream AND banking rows, which
 * couples volume to simulated user-days -- about 300 a minute. A bank's fact volume cannot be
 * reached that way: 350 customers yield ~110 loan applications over 55 days, which is realistic
 * per customer and far too thin to detect or localize a movement on.
 *
 * So the two sources are generated separately, as the data model says they are consumed:
 * this writes facts for a large population directly, and the simulation keeps producing the
 * behavioural clickstream for a representative sample. Not every banking customer needs a
 * browser session.
 *
 *   docker compose exec nexabank-backend npx tsx src/simulate/generateFacts.ts \
 *     --tenant bank_a --customers 4000 --days 55
 */
import { createHash } from "crypto";

import { prisma } from "../prisma";
import { TEMPLATES, applyTemplates, plantedTruth, type Template } from "./templates";

// ── deterministic RNG ────────────────────────────────────────────────────────
// Seeded so the same arguments rebuild the same bank. A dataset nobody can reproduce cannot be
// used to check whether the engine found what was planted.
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ids derived from the seed, not random, so a re-run is idempotent rather than a duplicate. */
function derivedUuid(key: string): string {
  const h = createHash("sha1").update(key).digest("hex");
  return [h.slice(0, 8), h.slice(8, 12), "5" + h.slice(13, 16),
          ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) + h.slice(18, 20),
          h.slice(20, 32)].join("-");
}

/** Short unique id for PAN and phone. Padding the index truncated and collided every 100 rows. */
function shortId(key: string): string {
  return createHash("sha1").update(key).digest("hex").slice(0, 12).toUpperCase();
}

export interface FactPlan {
  tenantId: string;
  customers: number;
  days: number;
  seed: number;
  templates: Template[];
  /** Restrict the write to one entity. Everything else is generated but not inserted. */
  only?: "customers" | "accounts" | "transactions" | "applications";
}

type Rng = () => number;
const pick = <T,>(r: Rng, a: T[]): T => a[Math.floor(r() * a.length)];
function weighted<T>(r: Rng, items: T[], weights: number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r() * total;
  for (let i = 0; i < items.length; i++) { x -= weights[i]; if (x <= 0) return items[i]; }
  return items[items.length - 1];
}
/** Lognormal-ish amount: most transactions small, a long tail of large ones. */
function amountFor(r: Rng, median: number): number {
  const z = Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
  return Math.max(50, Math.round(median * Math.exp(0.9 * z)));
}

const AGE = ["UNDER_25", "AGE_25_34", "AGE_35_49", "AGE_50_64", "AGE_65_PLUS"];
const INCOME = ["UNDER_30K", "INC_30K_60K", "INC_60K_100K", "INC_100K_200K", "INC_200K_PLUS"];
const EMPLOYMENT = ["SALARIED", "SELF_EMPLOYED", "STUDENT", "RETIRED", "UNEMPLOYED"];
const RISK = ["LOW", "MEDIUM", "HIGH"];
const ACCOUNT_TYPES = ["SAVINGS", "CURRENT", "INVESTMENT"];
const LOAN_TYPES = ["HOME", "AUTO", "PERSONAL", "STUDENT"];
const LOAN_RANGE: Record<string, [number, number]> = {
  HOME: [500000, 5000000], AUTO: [200000, 1500000],
  PERSONAL: [50000, 500000], STUDENT: [100000, 1000000],
};
const MCC = [
  ["5411", "FreshMart Grocery", "GROCERIES"], ["5812", "The Copper Kettle", "DINING"],
  ["5541", "Northgate Fuel", "FUEL"], ["4900", "Metro Utilities", "UTILITIES"],
  ["5732", "PixelWorks Electronics", "ELECTRONICS"], ["4111", "CityTransit", "TRANSPORT"],
  ["5912", "Wellspring Pharmacy", "HEALTHCARE"], ["7832", "Odeon Cinemas", "ENTERTAINMENT"],
  ["5651", "Rowan & Fields", "RETAIL"], ["4722", "Skyline Travel", "TRAVEL"],
];
// Channel follows the transaction: a card purchase happens at a POS, cash comes from an ATM.
const CHANNEL_MIX: Record<string, [string[], number[]]> = {
  PAYMENT: [["POS", "WEB", "MOBILE"], [45, 25, 30]],
  WITHDRAWAL: [["ATM", "POS", "WEB", "MOBILE"], [72, 14, 6, 8]],
  TRANSFER: [["WEB", "MOBILE"], [45, 55]],
  DEPOSIT: [["WEB", "MOBILE", "ATM"], [50, 40, 10]],
};

const BATCH = 500;

// Raw INSERT sends every parameter as text, so uuid, enum and jsonb columns need an explicit
// cast or Postgres rejects the row.
const CASTS: Record<string, string> = {
  id: "uuid", customerId: "uuid", loanId: "uuid", reviewedBy: "uuid",
  settingConfig: "jsonb", address: "jsonb", kycData: "jsonb", investment: "jsonb[]",
  customerType: '"CustomerType"', role: '"CustomerRole"', kycStatus: '"KycStatus"',
  ageBracket: '"AgeBracket"', employmentStatus: '"EmploymentStatus"',
  incomeBracket: '"IncomeBracket"', riskSegment: '"RiskSegment"',
  accountType: '"AccountType"', lifecycleStatus: '"AccountStatus"',
  transactionType: '"TransactionType"', channel: '"TransactionChannel"',
  loanType: '"LoanType"',
};
const STATUS_CAST: Record<string, string> = {
  Transaction: '"TransactionStatus"', LoanApplication: '"ApplicationStatus"',
};

async function insertRows(table: string, cols: string[], rows: unknown[][]): Promise<number> {
  if (!rows.length) return 0;
  const colList = cols.map((c) => `"${c}"`).join(", ");
  const castOf = (c: string) => (c === "status" ? STATUS_CAST[table] : CASTS[c]) || "";
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const ph = row.map((v, j) => {
        const cast = castOf(cols[j]);
        params.push(cast === "jsonb" && v !== null ? JSON.stringify(v) : v);
        return cast ? `$${params.length}::${cast}` : `$${params.length}`;
      });
      return `(${ph.join(", ")})`;
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${table}" (${colList}) VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`,
      ...params);
    written += chunk.length;
  }
  return written;
}

export async function generateFacts(plan: FactPlan) {
  const r = mulberry32(plan.seed);
  const now = new Date();
  const dayMs = 86400000;
  const startMs = now.getTime() - plan.days * dayMs;
  const dayStart = (d: number) => new Date(startMs + d * dayMs);

  const branches = await prisma.branch.findMany({
    select: { code: true, region: true }, orderBy: { code: "asc" } });
  if (!branches.length) throw new Error("no branches: run seedReferenceData.ts first");

  const tag = `${plan.tenantId}-${plan.seed}`;
  const custCols = ["id", "name", "email", "phone", "password", "customerType", "dateOfBirth",
    "pan", "settingConfig", "address", "role", "tenantId", "kycStatus", "kycCompletedAt",
    "ageBracket", "branchCode", "employmentStatus", "incomeBracket", "lifetimeValue", "riskSegment"];
  const acctCols = ["accNo", "customerId", "ifsc", "accountType", "balance", "createdOn",
    "updatedOn", "investment", "branchCode", "interestRate", "lifecycleStatus"];
  const txnCols = ["id", "transactionType", "senderAccNo", "receiverAccNo", "amount", "status",
    "category", "channel", "description", "timestamp", "updatedOn", "merchantCategoryCode",
    "merchantName", "referenceNumber"];
  const appCols = ["id", "customerId", "loanType", "principalAmount", "term", "interestRate",
    "status", "kycData", "kycStep", "createdOn", "updatedOn"];

  const customers: unknown[][] = [], accounts: unknown[][] = [];
  const txns: unknown[][] = [], apps: unknown[][] = [];

  type Person = { id: string; accNo: string; branch: string; region: string; risk: string;
                  openDay: number; spendRate: number; median: number };
  const people: Person[] = [];

  // Regenerating one entity must target the segment the customer ACTUALLY has, not the one this
  // run would compute. Recomputing risks planting the movement against different customers.
  if (plan.only === "applications") {
    const existing = await prisma.customer.findMany({
      where: { email: { startsWith: `bulk.${tag}.` } },
      select: { id: true, riskSegment: true, branchCode: true, branch: { select: { region: true } } },
      orderBy: { email: "asc" },
    });
    if (!existing.length) throw new Error(`no bulk customers for ${tag}; generate them first`);
    for (const c of existing) {
      people.push({ id: c.id, accNo: "", branch: c.branchCode || "",
                    region: c.branch?.region || "", risk: String(c.riskSegment || "LOW"),
                    openDay: 0, spendRate: 0, median: 0 });
    }
  }

  for (let i = 0; plan.only !== "applications" && i < plan.customers; i++) {
    const id = derivedUuid(`${tag}:cust:${i}`);
    const b = pick(r, branches);
    const risk = weighted(r, RISK, [55, 33, 12]);
    // Opened uniformly across the window, so signups are a real daily series rather than a
    // single spike on day zero.
    const openDay = Math.floor(r() * plan.days);
    const accNo = `${tag}-A${String(i).padStart(6, "0")}`;
    const opened = dayStart(openDay);
    const income = weighted(r, INCOME, [22, 30, 26, 16, 6]);
    const median = income === "INC_200K_PLUS" ? 9000 : income === "INC_100K_200K" ? 5000
      : income === "INC_60K_100K" ? 2600 : income === "INC_30K_60K" ? 1400 : 700;

    customers.push([id, `Customer ${tag} ${i}`, `bulk.${tag}.${i}@nexabank.test`,
      "9" + shortId(`${tag}:phone:${i}`).slice(0, 11),
      "!bulk-generated-no-login", "INDIVIDUAL",
      new Date(1960 + Math.floor(r() * 45), Math.floor(r() * 12), 1 + Math.floor(r() * 27)),
      shortId(`${tag}:pan:${i}`),
      {}, { line1: "generated" }, "USER", plan.tenantId,
      "NOT_STARTED", null,
      weighted(r, AGE, [18, 30, 28, 17, 7]), b.code,
      weighted(r, EMPLOYMENT, [52, 18, 14, 10, 6]), income,
      Math.round(r() * 20000) / 1, risk]);

    accounts.push([accNo, id, "NEXA0001", weighted(r, ACCOUNT_TYPES, [60, 20, 20]),
      Math.round(5000 + r() * 250000), opened, opened, "{}", b.code,
      Math.round(r() * 400) / 100, "ACTIVE"]);

    people.push({ id, accNo, branch: b.code, region: b.region, risk, openDay,
                  spendRate: 0.7 + r() * 2.4, median });
  }

  // ── daily activity ─────────────────────────────────────────────────────────
  for (const p of people) {
    for (let day = p.openDay; day < plan.days; day++) {
      const ctx = { day, region: p.region, risk: p.risk, branch: p.branch };
      const mod = applyTemplates(plan.templates, ctx, plan.days);

      const n = plan.only === "applications"
        ? 0 : Math.floor(p.spendRate * mod.txnVolume * (0.5 + r()));
      for (let k = 0; k < n; k++) {
        const type = weighted(r, ["PAYMENT", "TRANSFER", "WITHDRAWAL", "DEPOSIT"], [58, 20, 14, 8]);
        const [opts, w] = CHANNEL_MIX[type];
        const channel = weighted(r, opts, w);
        const failed = r() < mod.failureRate;
        const ts = new Date(startMs + day * dayMs + Math.floor(r() * dayMs));
        const m = pick(r, MCC);
        txns.push([derivedUuid(`${tag}:txn:${p.accNo}:${day}:${k}`), type, p.accNo,
          type === "PAYMENT" ? "MERCHANT-ID" : "EXTERNAL-BANK",
          amountFor(r, p.median), failed ? "FAILED" : "SUCCESS",
          type === "PAYMENT" ? m[2] : type === "WITHDRAWAL" ? "Cash Withdrawal" : "Transfer",
          channel, failed ? "Failed: network error" : null, ts, ts,
          type === "PAYMENT" ? m[0] : null, type === "PAYMENT" ? m[1] : null,
          `REF${Math.floor(r() * 1e11).toString(36).toUpperCase()}`]);
      }

      // ── loan application ────────────────────────────────────────────────
      if (r() < 0.012 * mod.applicationRate) {
        const loanType = pick(r, LOAN_TYPES);
        const [lo, hi] = LOAN_RANGE[loanType];
        const created = new Date(startMs + day * dayMs + Math.floor(r() * dayMs));
        // KYC is a funnel on the application itself: every application starts at step 1 and
        // either walks to 3 or stalls. The rate is derived from these counts, never stored.
        const completes = r() < mod.kycCompletion;
        const kycStep = completes ? 3 : 1 + Math.floor(r() * 2);
        let status = "KYC_PENDING", decided = created;
        if (completes) {
          const approved = r() < mod.approvalRate;
          // Decided a few days after applying, so decided_at and created_at differ and the
          // approval series is not a copy of the application series.
          const lag = 1 + Math.floor(r() * 4);
          decided = new Date(Math.min(created.getTime() + lag * dayMs, now.getTime()));
          status = decided.getTime() >= now.getTime() ? "PENDING"
            : approved ? "APPROVED" : "REJECTED";
        }
        apps.push([derivedUuid(`${tag}:app:${p.id}:${day}`), p.id, loanType,
          Math.floor(lo + r() * (hi - lo)), pick(r, [12, 24, 36, 48, 60]),
          Math.round((7 + r() * 7) * 100) / 100, status,
          completes ? { verified: true } : {}, kycStep, created, decided]);
      }
    }
  }

  const want = (name: string) => !plan.only || plan.only === name;
  const written = {
    customers: want("customers") ? await insertRows("Customer", custCols, customers) : 0,
    accounts: want("accounts") ? await insertRows("Account", acctCols, accounts) : 0,
    transactions: want("transactions") ? await insertRows("Transaction", txnCols, txns) : 0,
    applications: want("applications") ? await insertRows("LoanApplication", appCols, apps) : 0,
  };
  return written;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

  const templateNames = arg("templates", "").split(",").filter(Boolean);
  const plan: FactPlan = {
    tenantId: arg("tenant", "bank_a"),
    customers: Number(arg("customers", "4000")),
    days: Number(arg("days", "55")),
    seed: Number(arg("seed", "20260831")),
    only: (arg("only", "") || undefined) as FactPlan["only"],
    templates: templateNames.map((n) => {
      const t = TEMPLATES[n];
      if (!t) throw new Error(`unknown template "${n}". known: ${Object.keys(TEMPLATES).join(", ")}`);
      return t;
    }),
  };
  console.log("plan:", JSON.stringify({ ...plan, templates: templateNames }));
  const started = Date.now();
  generateFacts(plan)
    .then(async (w) => {
      console.log("written:", JSON.stringify(w));
      // The answer key the gates score against: what was planted and what the engine is
      // expected to conclude. A record of what ran cannot check anything.
      const fs = await import("fs");
      const path = await import("path");
      const outDir = process.env.FIXTURES_DIR || path.join(process.cwd(), "fixtures");
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "planted_truth.json"), JSON.stringify({
        generated_at: new Date().toISOString(),
        plan: { ...plan, templates: templateNames },
        written: w,
        planted: plantedTruth(plan.tenantId, plan.templates),
      }, null, 2));
      console.log(`wrote ${path.join(outDir, "planted_truth.json")}`);
      console.log(`took ${Math.round((Date.now() - started) / 1000)}s`);
      await prisma.$disconnect();
    })
    .catch(async (e) => {
      console.error(e);
      await prisma.$disconnect();
      process.exit(1);
    });
