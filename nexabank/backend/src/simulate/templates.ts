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
    direction: "up" | "down";
    rank1Dimension: string;
    verdict: "pass" | "fail" | "abstain";
    caveat?: string;
  };
}

const BASE: Modifiers = {
  txnVolume: 1, failureRate: 0.014, applicationRate: 1, kycCompletion: 0.72, approvalRate: 0.68,
};

export const TEMPLATES: Record<string, Template> = {
  /** Onboarding leaks in one region: KYC completion falls, approvals fall with it. */
  kyc_leak_region: {
    name: "kyc_leak_region",
    kpi: "kyc_completion_rate",
    // Nine days, so the baseline window is clean. Fourteen put both the scored and the
    // comparison window inside the leak, and a level shift already in the baseline is invisible.
    lastDays: 9,
    // Two regions, not one. A single region is a sixth of volume, so the aggregate stayed inside
    // its noise band and Detect correctly declined -- which meant Localize never ran on it.
    segment: { region: ["Europe", "North America"] },
    effect: { kycCompletion: 0.15 },
    expect: { direction: "down", rank1Dimension: "region", verdict: "pass" },
  },

  /**
   * The same onboarding leak, concentrated in ONE region and cut harder.
   *
   * `kyc_leak_region` spreads across Europe and North America, which together are about half the
   * bank. Detect fires on it, but every cell then moves roughly in proportion to its share of the
   * population, so Localize correctly refuses to name a driver and the attribution comes back
   * empty. A leak the engine can localise has to be concentrated as well as large: one region,
   * cut far enough that the aggregate still clears the band.
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
    effect: { failureRate: 0.11 },
    expect: { direction: "up", rank1Dimension: "", verdict: "pass" },
  },

  /** Lending demand spikes: more applications, approval rate holds. */
  loan_demand_spike: {
    name: "loan_demand_spike",
    kpi: "loan_approval_volume",
    lastDays: 10,
    segment: {},
    effect: { applicationRate: 2.6 },
    expect: { direction: "up", rank1Dimension: "", verdict: "pass" },
  },

  /** Credit tightens for high-risk applicants only: approvals fall, applications do not. */
  approval_tightening: {
    name: "approval_tightening",
    kpi: "loan_approval_volume",
    lastDays: 12,
    segment: { risk: ["HIGH", "MEDIUM"] },
    effect: { approvalRate: 0.22 },
    expect: { direction: "down", rank1Dimension: "risk_segment", verdict: "pass" },
  },

  /** Spend collapses in one region. Revenue follows, with no internal cause inside the funnel. */
  spend_slump_region: {
    name: "spend_slump_region",
    kpi: "revenue",
    lastDays: 14,
    segment: { region: ["Asia"] },
    effect: { txnVolume: 0.45 },
    expect: { direction: "down", rank1Dimension: "region", verdict: "pass" },
  },

  /** Pure variance, no level change. The engine must NOT report an anomaly. */
  noise_only: {
    name: "noise_only",
    kpi: "transaction_failure_rate",
    lastDays: 21,
    segment: {},
    effect: { txnVolume: 1.0 },
    expect: { direction: "up", rank1Dimension: "", verdict: "abstain",
              caveat: "no material movement" },
  },
};

function inSegment(t: Template, ctx: DayContext): boolean {
  if (t.segment.region?.length && !t.segment.region.includes(ctx.region)) return false;
  if (t.segment.risk?.length && !t.segment.risk.includes(ctx.risk)) return false;
  return true;
}

/**
 * Combine every template that applies to this customer-day.
 * `day` is measured from the start of the window, so `lastDays` is counted from the end.
 */
export function applyTemplates(templates: Template[], ctx: DayContext, totalDays?: number): Modifiers {
  const out: Modifiers = { ...BASE };
  const horizon = totalDays ?? ctx.day + 1;
  for (const t of templates) {
    const withinWindow = horizon - ctx.day <= t.lastDays;
    if (!withinWindow || !inSegment(t, ctx)) continue;
    for (const [k, v] of Object.entries(t.effect)) {
      const key = k as keyof Modifiers;
      // Rates are set outright; volumes multiply.
      out[key] = key === "txnVolume" || key === "applicationRate" ? out[key] * v : v;
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
