/**
 * Behaviour knobs for POST /events/simulate.
 *
 * The simulate page lets an operator change how simulated traffic behaves in three ways:
 *   1. ROUTE / EVENT TARGETS  -- dial one route or event up/down for traffic and,
 *      independently, for failure (helper/journeyModel.ts).
 *   2. POPULATION MIX         -- bias the device / country / channel mix of the sessions
 *      generated in the window, without changing any rate.
 *   3. A WINDOW + optional SEGMENT that scope 1 and 2 (see below).
 *
 * The old bespoke rate groups (kyc / loans / pro Partial overrides) were removed: the same
 * movements are now expressed through targets, which the operator can also edit by hand.
 * BASELINE_BEHAVIOR still holds the generator's baseline rates -- those are the numbers the
 * traffic / failure multipliers scale.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It records no ground truth. Nothing is written that says "a KYC drop was planted here".
 * The only trace a change leaves is the shape of the events in events_raw. That is the
 * point: the intelligence layer has to infer the movement and its cause from telemetry
 * alone. The API response echoes the resolved override back to the caller for display; that
 * echo is never persisted.
 *
 * TWO IDEAS THAT MAKE A MOVEMENT DETECTABLE
 * -----------------------------------------
 * 1. A WINDOW. An override applies only to the last `windowDays` of simulated history; the
 *    rest generates at baseline. Without earlier days at the baseline rate there is nothing
 *    to move against.
 *
 * 2. A SEGMENT. An override can be scoped to e.g. {device_type: "mobile", location: "India"}.
 *    Only matching sessions get the change, so the movement concentrates in a cell that
 *    localization can actually recover. This scopes targets AND mix.
 *
 * GRAIN NOTE
 * ----------
 * Mix overrides (device/country/channel) are applied PER SESSION inside the window, not per
 * user. kyc_completion_rate localizes at session grain, and its contract requires only that
 * a dimension be invariant WITHIN a session -- a user appearing on mobile one day and
 * desktop the next is both realistic and contract-legal. Re-rolling per event would not be:
 * that is the FOUNDATION-2 bug this repo just fixed.
 *
 * `relaxJourney` turns off the journey-consistency safeguard so a targeted event can spike
 * without its prerequisites (an anomaly / exploit shape). See helper/journeyModel.ts.
 */

import {
  ParsedTarget,
  parseTargets,
  describeTargets,
} from "./journeyModel";

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
  /** Restrict the override (targets AND mix) to sessions matching all provided keys. */
  segment?: BehaviorSegment;
  /** Bias the device / country / channel mix of sessions generated in the window. */
  mix?: Partial<MixBehavior>;
  /** Per-route / per-event traffic & failure multipliers. Validated against the real
   *  vocabulary in journeyModel.ts; invalid identifiers are dropped, not coerced. */
  targets?: ParsedTarget[];
  /** When true, the journey-consistency safeguard is off for targeted routes/events:
   *  they may fire without their prerequisites and do not pull their funnel with them. */
  relaxJourney?: boolean;
}

/**
 * The generator's baseline rates. These are the numbers the traffic / failure multipliers
 * scale; a run with no override generates exactly this distribution.
 */
export const BASELINE_BEHAVIOR: SimulationBehavior = {
  kyc: { startRate: 0.25, progressMultiplier: 0.3, successRate: 0.85 },
  loans: { applicationMultiplier: 0.15, approvalRate: 0.72 },
  mix: { deviceWeights: {}, countryWeights: {}, channelWeights: {} },
  pro: { conversionMultiplier: 1, errorRate: 0.03, roleViolationRate: 0 },
};

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

  const targets = parseTargets(body.targets);
  if (targets.length) override.targets = targets;

  const relaxJourney = body.relaxJourney === true || body.relaxJourney === "true";
  if (relaxJourney) override.relaxJourney = true;

  const touched = override.mix || override.targets || override.relaxJourney;
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
  // Only `mix` is a rate-shaping override now; kyc/loans/pro stay at baseline and are
  // moved via targets instead.
  return {
    kyc: BASELINE_BEHAVIOR.kyc,
    loans: BASELINE_BEHAVIOR.loans,
    mix: { ...BASELINE_BEHAVIOR.mix, ...(o.mix || {}) },
    pro: BASELINE_BEHAVIOR.pro,
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

  for (const key of ["deviceWeights", "countryWeights", "channelWeights"] as const) {
    const weights = override.mix?.[key];
    if (weights && Object.keys(weights).length) {
      lines.push(`${key} biased to ${JSON.stringify(weights)}`);
    }
  }
  for (const line of describeTargets(override.targets ?? [], override.relaxJourney === true)) {
    lines.push(line);
  }
  return lines;
}
