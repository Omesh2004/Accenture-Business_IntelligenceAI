/**
 * Anomaly templates: the shapes a planted movement can take.
 *
 * A template never edits a KPI. It changes the rate at which the generator emits underlying rows
 * for a chosen window and segment, so the movement exists in the source data and the engine has
 * to discover it -- which is the rule that makes the whole demo honest.
 *
 * Each template also declares its own ground truth, so `plantedTruth()` can write the answer key
 * the intelligence gates score against.
 */

/** What the generator asks a template about, for one customer on one day. */
export interface DayContext {
  day: number;
  region: string;
  risk: string;
  branch: string;
}

/** Multipliers the generator applies. 1.0 means "leave it alone". */
export interface Modifiers {
  txnVolume: number;
  failureRate: number;
  applicationRate: number;
  kycCompletion: number;
  approvalRate: number;
  /** Share of accounts that still open inside the affected window. Drives the signups KPI. */
  openRate: number;
  /** Spread multiplier on daily transaction volume. Variance only, no level change. */
  noise: number;
}

export interface Template {
  name: string;
  kpi: string;
  /** Days from the end of the window that the movement covers. */
  lastDays: number;
  /** Only these segment values are affected. Empty means every segment. */
  segment: { region?: string[]; risk?: string[] };
  effect: Partial<Modifiers>;
  /** What the engine is expected to conclude. Written to the ground-truth fixture. */
  expect: {
    direction: "up" | "down" | "flat";
    rank1Dimension: string;
    verdict: "pass" | "fail" | "abstain";
    caveat?: string;
  };
}

const BASE: Modifiers = {
  txnVolume: 1, failureRate: 0.014, applicationRate: 1, kycCompletion: 0.72, approvalRate: 0.68,
  openRate: 1, noise: 1,
};

export const TEMPLATES: Record<string, Template> = {
  /** Nothing planted. The quiet state to record before introducing a movement. */
  baseline: {
    name: "baseline",
    kpi: "",
    lastDays: 0,
    segment: {},
    effect: {},
    expect: { direction: "flat", rank1Dimension: "", verdict: "abstain" },
  },

  /**
   * KYC completion collapses in ONE region.
   *
   * One region, not two. Spread across Europe and North America the leak is about half the bank,
   * every cell then moves in proportion to its share of the population, and Localize correctly
   * refuses to name a driver -- a large movement with no attributable cause. Concentrated in one
   * region it clears both the detection band and the concentration test.
   */
  kyc_leak_single_region: {
    name: "kyc_leak_single_region",
    kpi: "kyc_completion_rate",
    lastDays: 9,
    segment: { region: ["Europe"] },
    effect: { kycCompletion: 0.08 },
    expect: { direction: "down", rank1Dimension: "region", verdict: "pass" },
  },

  /** A payments incident: failures rise sharply, dragging fee revenue with them. */
  failure_burst: {
    name: "failure_burst",
    kpi: "transaction_failure_rate",
    lastDays: 7,
    segment: {},
    effect: { failureRate: 0.34 },
    expect: { direction: "up", rank1Dimension: "", verdict: "pass" },
  },

  /** Marketing lands: applications surge, and approvals follow demand. */
  loan_demand_spike: {
    name: "loan_demand_spike",
    kpi: "loan_approval_volume",
    lastDays: 10,
    segment: {},
    effect: { applicationRate: 2.6 },
    expect: { direction: "up", rank1Dimension: "", verdict: "pass" },
  },

  /** Spend collapses in one region. Revenue follows, with no cause inside the funnel. */
  spend_slump_region: {
    name: "spend_slump_region",
    kpi: "revenue",
    lastDays: 14,
    segment: { region: ["Asia"] },
    effect: { txnVolume: 0.45 },
    expect: { direction: "down", rank1Dimension: "region", verdict: "pass" },
  },

  /** Onboarding stalls: fewer accounts opened, nothing wrong downstream. */
  signup_slowdown: {
    name: "signup_slowdown",
    kpi: "signups",
    lastDays: 10,
    segment: {},
    effect: { openRate: 0.35 },
    expect: { direction: "down", rank1Dimension: "", verdict: "pass" },
  },

  /** Pure variance, no level change. The engine must NOT report an anomaly. */
  noise_only: {
    name: "noise_only",
    kpi: "",
    lastDays: 10,
    segment: {},
    effect: { noise: 2.2 },
    expect: { direction: "flat", rank1Dimension: "", verdict: "abstain" },
  },
};

/** Whether this customer-day falls inside the template's declared segment. */
function inSegment(t: Template, ctx: DayContext): boolean {
  if (t.segment.region?.length && !t.segment.region.includes(ctx.region)) return false;
  if (t.segment.risk?.length && !t.segment.risk.includes(ctx.risk)) return false;
  return true;
}

export function applyTemplates(templates: Template[], ctx: DayContext, totalDays?: number): Modifiers {
  const out: Modifiers = { ...BASE };
  const horizon = totalDays ?? ctx.day + 1;
  for (const t of templates) {
    const withinWindow = horizon - ctx.day <= t.lastDays;
    if (!withinWindow || !inSegment(t, ctx)) continue;
    for (const [k, v] of Object.entries(t.effect)) {
      const key = k as keyof Modifiers;
      // Rates are set outright; volumes multiply.
      // Volumes and spreads multiply; rates are set outright.
      out[key] = key === "txnVolume" || key === "applicationRate" || key === "noise"
        ? out[key] * v : v;
    }
  }
  return out;
}

/** The answer key: what was actually planted, for the gates to score against. */
export function plantedTruth(tenantId: string, templates: Template[]) {
  return templates.map((t) => ({
    tenant_id: tenantId,
    scenario: t.name,
    kpi_id: t.kpi,
    anomaly_days: t.lastDays,
    planted_segment: t.segment,
    expected_direction: t.expect.direction,
    expected_rank1_dimension: t.expect.rank1Dimension,
    expected_verdict: t.expect.verdict,
    ...(t.expect.caveat ? { expected_caveat: t.expect.caveat } : {}),
  }));
}
