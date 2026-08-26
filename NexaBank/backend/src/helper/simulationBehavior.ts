/**
 * Behaviour knobs for POST /events/simulate.
 *
 * The simulate page lets an operator change how simulated users BEHAVE -- how often KYC
 * completes, how many loans get approved, which devices and countries the traffic comes
 * from, how often pro features convert or error. The generator then produces users who
 * genuinely behave that way.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It records no ground truth. Nothing is written that says "a KYC drop was planted here".
 * The only trace a knob change leaves is the shape of the events in events_raw. That is the
 * point: the intelligence layer has to infer the movement and its cause from telemetry
 * alone, exactly as it would for a real incident. A truth table sitting next to the data
 * would let a pipeline look up the answer instead of finding it.
 *
 * The API response echoes the resolved behaviour back to the caller so the operator can see
 * what they asked for. That echo is never persisted.
 *
 * TWO IDEAS THAT MAKE A MOVEMENT DETECTABLE
 * -----------------------------------------
 * 1. A WINDOW. An override applies only to the last `windowDays` of simulated history; the
 *    rest generates at baseline. Without earlier days at the baseline rate there is nothing
 *    to move against, and a detector scoring residuals against a forecast band would see a
 *    flat series at the new level rather than a drop.
 *
 * 2. A SEGMENT. An override can be scoped to e.g. {device_type: "mobile", location: "India"}.
 *    Only matching sessions get the changed rates, so the movement is concentrated in a cell
 *    that localization can actually recover. An unscoped override moves everything uniformly,
 *    which is detectable but has no root cause to find.
 *
 * GRAIN NOTE
 * ----------
 * Mix overrides (device/country/channel) are applied PER SESSION inside the window, not per
 * user. kyc_completion_rate localizes at session grain, and its contract requires only that
 * a dimension be invariant WITHIN a session -- a user appearing on mobile one day and
 * desktop the next is both realistic and contract-legal. Re-rolling per event would not be:
 * that is the FOUNDATION-2 bug this repo just fixed.
 */

export interface KycBehavior {
  /** Chance an eligible user starts KYC on a given day. */
  startRate: number;
  /** Multiplier on the persona's own kycCompletionRate for progressing out of PENDING. */
  progressMultiplier: number;
  /** Of users who progress, the share that VERIFY rather than get REJECTED. */
  successRate: number;
}

export interface LoanBehavior {
  /** Multiplier on the persona's loanInterest for applying on a given day. */
  applicationMultiplier: number;
  /** Share of submitted applications that reach approved status. */
  approvalRate: number;
}

export interface MixBehavior {
  /** Relative weights; keys are device_type values. Empty means "leave the default mix". */
  deviceWeights: Record<string, number>;
  /** Relative weights over country names, matching the `location` metadata value. */
  countryWeights: Record<string, number>;
  /** Relative weights over acquisition channel names. */
  channelWeights: Record<string, number>;
}

export interface ProBehavior {
  /** Multiplier on the persona's proConversionChance. */
  conversionMultiplier: number;
  /** Share of pro-feature interactions that fail. */
  errorRate: number;
  /** Chance a session emits an auth.role.violation (a user-role actor hitting admin scope). */
  roleViolationRate: number;
}

export interface SimulationBehavior {
  kyc: KycBehavior;
  loans: LoanBehavior;
  mix: MixBehavior;
  pro: ProBehavior;
}

export interface BehaviorSegment {
  device_type?: string;
  location?: string;
}

export interface BehaviorOverride {
  /** Trailing days of simulated history the override applies to. */
  windowDays: number;
  /** Restrict the override to sessions matching all provided keys. */
  segment?: BehaviorSegment;
  kyc?: Partial<KycBehavior>;
  loans?: Partial<LoanBehavior>;
  mix?: Partial<MixBehavior>;
  pro?: Partial<ProBehavior>;
}

/**
 * Reproduces the generator's behaviour before knobs existed. A run with no override must
 * produce the same distribution it always did, so an operator can establish a baseline.
 */
export const BASELINE_BEHAVIOR: SimulationBehavior = {
  kyc: { startRate: 0.25, progressMultiplier: 0.3, successRate: 0.85 },
  loans: { applicationMultiplier: 0.15, approvalRate: 0.72 },
  mix: { deviceWeights: {}, countryWeights: {}, channelWeights: {} },
  pro: { conversionMultiplier: 1, errorRate: 0.03, roleViolationRate: 0 },
};

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function cleanWeights(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isFiniteNumber(value) && value > 0) out[key] = value;
  }
  return out;
}

/**
 * Parse an untrusted request body into an override, or null when nothing usable is present.
 * Every rate is clamped; multipliers are capped so a typo cannot make a run never terminate.
 */
export function parseBehaviorOverride(raw: unknown): BehaviorOverride | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, any>;

  const windowDays = isFiniteNumber(Number(body.windowDays))
    ? Math.max(1, Math.min(Math.floor(Number(body.windowDays)), 60))
    : 3;

  const override: BehaviorOverride = { windowDays };

  const segment: BehaviorSegment = {};
  if (typeof body.segment?.device_type === "string" && body.segment.device_type.trim()) {
    segment.device_type = body.segment.device_type.trim();
  }
  if (typeof body.segment?.location === "string" && body.segment.location.trim()) {
    segment.location = body.segment.location.trim();
  }
  if (Object.keys(segment).length) override.segment = segment;

  if (body.kyc && typeof body.kyc === "object") {
    const kyc: Partial<KycBehavior> = {};
    if (isFiniteNumber(Number(body.kyc.startRate))) kyc.startRate = clamp01(Number(body.kyc.startRate));
    if (isFiniteNumber(Number(body.kyc.progressMultiplier))) {
      kyc.progressMultiplier = Math.max(0, Math.min(Number(body.kyc.progressMultiplier), 5));
    }
    if (isFiniteNumber(Number(body.kyc.successRate))) kyc.successRate = clamp01(Number(body.kyc.successRate));
    if (Object.keys(kyc).length) override.kyc = kyc;
  }

  if (body.loans && typeof body.loans === "object") {
    const loans: Partial<LoanBehavior> = {};
    if (isFiniteNumber(Number(body.loans.applicationMultiplier))) {
      loans.applicationMultiplier = Math.max(0, Math.min(Number(body.loans.applicationMultiplier), 5));
    }
    if (isFiniteNumber(Number(body.loans.approvalRate))) {
      loans.approvalRate = clamp01(Number(body.loans.approvalRate));
    }
    if (Object.keys(loans).length) override.loans = loans;
  }

  if (body.mix && typeof body.mix === "object") {
    const mix: Partial<MixBehavior> = {};
    const device = cleanWeights(body.mix.deviceWeights);
    const country = cleanWeights(body.mix.countryWeights);
    const channel = cleanWeights(body.mix.channelWeights);
    if (Object.keys(device).length) mix.deviceWeights = device;
    if (Object.keys(country).length) mix.countryWeights = country;
    if (Object.keys(channel).length) mix.channelWeights = channel;
    if (Object.keys(mix).length) override.mix = mix;
  }

  if (body.pro && typeof body.pro === "object") {
    const pro: Partial<ProBehavior> = {};
    if (isFiniteNumber(Number(body.pro.conversionMultiplier))) {
      pro.conversionMultiplier = Math.max(0, Math.min(Number(body.pro.conversionMultiplier), 20));
    }
    if (isFiniteNumber(Number(body.pro.errorRate))) pro.errorRate = clamp01(Number(body.pro.errorRate));
    if (isFiniteNumber(Number(body.pro.roleViolationRate))) {
      pro.roleViolationRate = clamp01(Number(body.pro.roleViolationRate));
    }
    if (Object.keys(pro).length) override.pro = pro;
  }

  const touched = override.kyc || override.loans || override.mix || override.pro;
  return touched ? override : null;
}

export interface BehaviorContext {
  /** How many days before "now" this simulated day sits. 0 is today. */
  daysAgo: number;
  /** The session's device_type, for segment matching. */
  deviceType?: string;
  /** The session's location (a COUNTRY value -- see CLAUDE.md coupling point 6). */
  location?: string;
}

function matchesSegment(segment: BehaviorSegment | undefined, ctx: BehaviorContext): boolean {
  if (!segment) return true;
  if (segment.device_type && segment.device_type !== ctx.deviceType) return false;
  if (segment.location && segment.location !== ctx.location) return false;
  return true;
}

/** True when this session sits inside the override's window AND matches its segment. */
export function overrideApplies(
  override: BehaviorOverride | null,
  ctx: BehaviorContext
): boolean {
  if (!override) return false;
  if (ctx.daysAgo >= override.windowDays) return false;
  return matchesSegment(override.segment, ctx);
}

/**
 * Effective behaviour for one simulated session.
 *
 * Outside the window, or outside the segment, this is exactly BASELINE_BEHAVIOR -- which is
 * what gives a detector something to score the window against.
 */
export function resolveBehavior(
  override: BehaviorOverride | null,
  ctx: BehaviorContext
): SimulationBehavior {
  if (!overrideApplies(override, ctx)) return BASELINE_BEHAVIOR;
  const o = override as BehaviorOverride;
  return {
    kyc: { ...BASELINE_BEHAVIOR.kyc, ...(o.kyc || {}) },
    loans: { ...BASELINE_BEHAVIOR.loans, ...(o.loans || {}) },
    mix: { ...BASELINE_BEHAVIOR.mix, ...(o.mix || {}) },
    pro: { ...BASELINE_BEHAVIOR.pro, ...(o.pro || {}) },
  };
}

/** Weighted pick over a {value: weight} map. Returns null when the map is empty. */
export function pickWeighted(weights: Record<string, number>): string | null {
  const entries = Object.entries(weights);
  if (!entries.length) return null;
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return null;
  let roll = Math.random() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

/**
 * A short, human-readable description of what the run was asked to do.
 * Returned to the caller for display. NEVER written to Postgres or ClickHouse.
 */
export function describeOverride(override: BehaviorOverride | null): string[] {
  if (!override) return ["Baseline behaviour -- no parameters changed."];

  const lines: string[] = [];
  const scope = override.segment
    ? Object.entries(override.segment).map(([k, v]) => `${k}=${v}`).join(" AND ")
    : "all traffic";
  lines.push(`Applied to ${scope} over the last ${override.windowDays} day(s); earlier days ran at baseline.`);

  const b = BASELINE_BEHAVIOR;
  if (override.kyc?.startRate !== undefined) {
    lines.push(`KYC start rate ${b.kyc.startRate} -> ${override.kyc.startRate}`);
  }
  if (override.kyc?.progressMultiplier !== undefined) {
    lines.push(`KYC completion multiplier ${b.kyc.progressMultiplier} -> ${override.kyc.progressMultiplier}`);
  }
  if (override.kyc?.successRate !== undefined) {
    lines.push(`KYC success share ${b.kyc.successRate} -> ${override.kyc.successRate}`);
  }
  if (override.loans?.applicationMultiplier !== undefined) {
    lines.push(`Loan application multiplier ${b.loans.applicationMultiplier} -> ${override.loans.applicationMultiplier}`);
  }
  if (override.loans?.approvalRate !== undefined) {
    lines.push(`Loan approval rate ${b.loans.approvalRate} -> ${override.loans.approvalRate}`);
  }
  for (const key of ["deviceWeights", "countryWeights", "channelWeights"] as const) {
    const weights = override.mix?.[key];
    if (weights && Object.keys(weights).length) {
      lines.push(`${key} biased to ${JSON.stringify(weights)}`);
    }
  }
  if (override.pro?.conversionMultiplier !== undefined) {
    lines.push(`Pro conversion multiplier ${b.pro.conversionMultiplier} -> ${override.pro.conversionMultiplier}`);
  }
  if (override.pro?.errorRate !== undefined) {
    lines.push(`Pro error rate ${b.pro.errorRate} -> ${override.pro.errorRate}`);
  }
  if (override.pro?.roleViolationRate !== undefined) {
    lines.push(`Role-violation rate ${b.pro.roleViolationRate} -> ${override.pro.roleViolationRate}`);
  }
  return lines;
}
