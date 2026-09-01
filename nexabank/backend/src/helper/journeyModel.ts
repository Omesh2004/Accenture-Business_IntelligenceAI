/**
 * Journey model for POST /events/simulate.
 *
 * WHAT THIS IS
 * ------------
 * The simulate route emits ~40 distinct raw event names. Whether one of them is
 * *allowed to occur* for a given simulated session depends on what that session has
 * already done -- a feature has to be viewed before it can fail, KYC has to start
 * before it completes, a loan has to be applied for before it can be approved, a pro
 * feature has to be reached before it can be used. Until now that ordering lived
 * implicitly in the imperative structure of the generator (a `kycState` machine, an
 * `isPro` flag, day thresholds). This module lifts it into DATA so it can be reasoned
 * about, extended, and enforced.
 *
 * It is deliberately NOT a fourth entry in the taxonomy-dialect problem (CLAUDE.md
 * coupling point 2). Nothing here is a contract with the ingestion pipeline or the
 * read layer. It is an internal concern of the generator: it maps each *raw* name the
 * generator emits to the *canonical* name Phase 0 verified it resolves to (so the gate
 * can dedupe siblings that the two funnel namings produce), plus the route it belongs
 * to and its place in the journey graph. The catalog below is the single place that
 * knowledge lives, instead of being smeared across 50 `trackEvent` call sites.
 *
 * NO GROUND TRUTH
 * ---------------
 * Same rule as simulationBehavior.ts: which routes/events an operator targeted, and
 * whether the realism safeguard was on, are visible only in the API response echo.
 * This module never writes anything -- it only shapes which events the generator rolls
 * and, when a prerequisite is missing, back-fills it so the session stays a valid
 * journey. The back-filled events are real events that plausibly happened; nothing
 * records that they were back-filled.
 *
 * Phase 0 findings this is built on: docs/simulate_audit/PHASE_0_FINDINGS.md
 * (raw -> canonical -> route table, verified by running all three taxonomy dialects).
 */

export type SimEventKind =
  | "entry"
  | "page"
  | "action"
  | "outcome_success"
  | "outcome_failure"
  | "violation";

export interface SimEvent {
  /** The string the generator passes to trackEvent(). */
  raw: string;
  /** What that resolves to through enforceTaxonomy -> ingest -> canonicalize (Phase 0). */
  canonical: string;
  /** Physical route the event belongs to (resolve_page equivalent). */
  route: string;
  kind: SimEventKind;
  /** True when the event can only occur inside a pro/enterprise feature area. */
  proGated?: boolean;
  /** For a failure outcome, the canonical of its success/view sibling (same attempt). */
  failureSiblingOf?: string;
  /** Human label for the operator-facing target picker. */
  label: string;
}

// ── The catalog ────────────────────────────────────────────────────────────────
// One row per raw name the simulate route can emit. `canonical` is the value that
// actually lands in events_raw after all three dialects (verified in Phase 0); a
// handful are orphans that no chart reads (noted), which is fine -- the gate only
// needs them to be stable identifiers for "did this happen this session".

export const SIM_EVENTS: SimEvent[] = [
  // entry
  { raw: "free.auth.register.success", canonical: "register.auth.success", route: "/register", kind: "entry", label: "Register" },
  { raw: "free.auth.login.success", canonical: "login.auth.success", route: "/login", kind: "entry", label: "Login" },
  // dashboard / core
  { raw: "core.analytics.opt_in", canonical: "analytics.opt_in.action", route: "/dashboard", kind: "action", label: "Analytics opt-in" },
  { raw: "free.dashboard.view", canonical: "dashboard.page.view", route: "/dashboard", kind: "page", label: "Dashboard view" },
  { raw: "pro.dashboard.view", canonical: "dashboard.page.view", route: "/dashboard", kind: "page", label: "Pro dashboard view" },
  { raw: "free.accounts.view", canonical: "account.page.view", route: "/accounts", kind: "page", label: "Accounts view" },
  { raw: "free.transactions.view", canonical: "transaction.page.view", route: "/transactions", kind: "page", label: "Transactions view" },
  { raw: "payments.history.viewed", canonical: "payments.history.view", route: "/transactions", kind: "page", label: "Payment history view" },
  { raw: "core.profile.viewed", canonical: "profile.page.view", route: "/profile", kind: "page", label: "Profile view" },
  // payees
  { raw: "free.payees.view", canonical: "payee.page.view", route: "/payees", kind: "page", label: "Payees view" },
  { raw: "free.payees.add_success", canonical: "payee.add_payee.success", route: "/payees", kind: "outcome_success", label: "Payee added" },
  // payments (orphan canonicals -- no chart reads payment.*.action; see Phase 0)
  { raw: "free.payment.success", canonical: "payment.success.action", route: "/transactions", kind: "outcome_success", label: "Payment success" },
  { raw: "free.payment.failed", canonical: "payment.failed.action", route: "/transactions", kind: "outcome_failure", failureSiblingOf: "payment.success.action", label: "Payment failure" },
  // loan funnel (free naming + lending naming both land on the same canonicals)
  { raw: "free.loan.kyc_started", canonical: "loan.kyc_started.success", route: "/loans", kind: "action", label: "Loan KYC started" },
  { raw: "free.loan.kyc_completed", canonical: "loan.kyc_completed.success", route: "/loans", kind: "outcome_success", label: "Loan KYC completed" },
  { raw: "lending.loan.kyc_completed", canonical: "loan.kyc_completed.success", route: "/loans", kind: "outcome_success", label: "Loan KYC completed" },
  { raw: "free.loan.kyc_failed", canonical: "loan.kyc.failure", route: "/loans", kind: "outcome_failure", failureSiblingOf: "loan.kyc_completed.success", label: "Loan KYC failed" },
  { raw: "lending.loan.kyc_abandoned", canonical: "loan.kyc_abandoned.failure", route: "/loans", kind: "outcome_failure", failureSiblingOf: "loan.kyc_completed.success", label: "Loan KYC abandoned" },
  { raw: "lending.loans.viewed", canonical: "loan.page.view", route: "/loans", kind: "page", label: "Loans view" },
  { raw: "lending.loan.applied", canonical: "loan.applied.success", route: "/loans", kind: "outcome_success", label: "Loan applied" },
  { raw: "loan_approved", canonical: "loan.approved.success", route: "/loans", kind: "outcome_success", label: "Loan approved" },
  // pro area entry / unlock (orphan canonicals; see Phase 0)
  { raw: "pro.features.view", canonical: "features.view.action", route: "/pro-features", kind: "page", proGated: true, label: "Pro features view" },
  { raw: "pro.features.unlock_success", canonical: "features.unlock.success", route: "/pro-features", kind: "outcome_success", proGated: true, label: "Pro unlock success" },
  { raw: "pro.features.unlock_failed", canonical: "features.unlock.failed", route: "/pro-features", kind: "outcome_failure", proGated: true, failureSiblingOf: "features.unlock.success", label: "Pro unlock failure" },
  // crypto trading
  { raw: "crypto_trading.page.view", canonical: "crypto-trading.page.view", route: "/pro-feature?id=crypto-trading", kind: "page", proGated: true, label: "Crypto trading view" },
  { raw: "crypto_trading.price_feeds.view", canonical: "crypto-trading.price_feeds.view", route: "/pro-feature?id=crypto-trading", kind: "action", proGated: true, label: "Crypto price feeds view" },
  { raw: "crypto_trading.price_feeds.failure", canonical: "crypto-trading.price_feeds.failure", route: "/pro-feature?id=crypto-trading", kind: "outcome_failure", proGated: true, failureSiblingOf: "crypto-trading.price_feeds.view", label: "Crypto price feeds failure" },
  { raw: "crypto_trading.portfolio.view", canonical: "crypto-trading.portfolio.view", route: "/pro-feature?id=crypto-trading", kind: "action", proGated: true, label: "Crypto portfolio view" },
  { raw: "crypto_trading.trade_execution.success", canonical: "crypto-trading.trade_execution.success", route: "/pro-feature?id=crypto-trading", kind: "outcome_success", proGated: true, label: "Crypto trade success" },
  { raw: "crypto_trading.trade_execution.failure", canonical: "crypto-trading.trade_execution.failure", route: "/pro-feature?id=crypto-trading", kind: "outcome_failure", proGated: true, failureSiblingOf: "crypto-trading.trade_execution.success", label: "Crypto trade failure" },
  // wealth management
  { raw: "wealth_management_pro.insights.view", canonical: "wealth-management-pro.insights.view", route: "/pro-feature?id=wealth-management-pro", kind: "action", proGated: true, label: "Wealth insights view" },
  { raw: "wealth_management_pro.insights.failure", canonical: "wealth-management-pro.insights.failure", route: "/pro-feature?id=wealth-management-pro", kind: "outcome_failure", proGated: true, failureSiblingOf: "wealth-management-pro.insights.view", label: "Wealth insights failure" },
  { raw: "wealth_management_pro.rebalance.success", canonical: "wealth-management-pro.rebalance.success", route: "/pro-feature?id=wealth-management-pro", kind: "outcome_success", proGated: true, label: "Wealth rebalance success" },
  { raw: "wealth_management_pro.rebalance.failure", canonical: "wealth-management-pro.rebalance.failure", route: "/pro-feature?id=wealth-management-pro", kind: "outcome_failure", proGated: true, failureSiblingOf: "wealth-management-pro.rebalance.success", label: "Wealth rebalance failure" },
  // bulk payroll
  { raw: "bulk_payroll_processing.payees.view", canonical: "bulk-payroll-processing.payees.view", route: "/pro-feature?id=bulk-payroll-processing", kind: "action", proGated: true, label: "Payroll payees view" },
  { raw: "bulk_payroll_processing.search.success", canonical: "bulk-payroll-processing.search.success", route: "/pro-feature?id=bulk-payroll-processing", kind: "outcome_success", proGated: true, label: "Payroll search success" },
  { raw: "bulk_payroll_processing.search.failure", canonical: "bulk-payroll-processing.search.failure", route: "/pro-feature?id=bulk-payroll-processing", kind: "outcome_failure", proGated: true, failureSiblingOf: "bulk-payroll-processing.search.success", label: "Payroll search failure" },
  { raw: "bulk_payroll_processing.batch.success", canonical: "bulk-payroll-processing.batch.success", route: "/pro-feature?id=bulk-payroll-processing", kind: "outcome_success", proGated: true, label: "Payroll batch success" },
  { raw: "bulk_payroll_processing.batch.failure", canonical: "bulk-payroll-processing.batch.failure", route: "/pro-feature?id=bulk-payroll-processing", kind: "outcome_failure", proGated: true, failureSiblingOf: "bulk-payroll-processing.batch.success", label: "Payroll batch failure" },
  // ai insights
  { raw: "ai_insights.stats.view", canonical: "ai-insights.stats.view", route: "/pro-feature?id=ai-insights", kind: "action", proGated: true, label: "AI insights stats view" },
  { raw: "ai_insights.book.success", canonical: "ai-insights.book.success", route: "/pro-feature?id=ai-insights", kind: "outcome_success", proGated: true, label: "AI insights book success" },
  { raw: "ai_insights.book.failure", canonical: "ai-insights.book.failure", route: "/pro-feature?id=ai-insights", kind: "outcome_failure", proGated: true, failureSiblingOf: "ai-insights.book.success", label: "AI insights book failure" },
  // violation
  { raw: "auth.role.violation", canonical: "auth.role.violation", route: "/admin", kind: "violation", label: "Role violation" },
];

export const ENTRY_CANONICALS = ["login.auth.success", "register.auth.success"];

// First catalog row wins for a canonical with several raw forms; that raw is what
// back-fill emits when this canonical is a missing prerequisite.
const RAW_FOR_CANONICAL = new Map<string, string>();
const BY_CANONICAL = new Map<string, SimEvent>();
export const BY_RAW = new Map<string, SimEvent>();
for (const ev of SIM_EVENTS) {
  BY_RAW.set(ev.raw, ev);
  if (!BY_CANONICAL.has(ev.canonical)) BY_CANONICAL.set(ev.canonical, ev);
  if (!RAW_FOR_CANONICAL.has(ev.canonical)) RAW_FOR_CANONICAL.set(ev.canonical, ev.raw);
}

export function canonicalOf(raw: string): string {
  return BY_RAW.get(raw)?.canonical ?? raw;
}

export const KNOWN_ROUTES: string[] = Array.from(new Set(SIM_EVENTS.map((e) => e.route))).sort();

// ── The journey graph ─────────────────────────────────────────────────────────
//
// FUNNEL_PREREQS: hard, volume-carrying edges. Enforced by the gate AND used for
// proportional upstream scaling -- raising traffic on a funnel endpoint raises every
// step that feeds it. These are the edges that cannot be derived from the event name
// alone ("approved follows applied" is domain knowledge, not string structure).
const FUNNEL_PREREQS: Record<string, string[]> = {
  "loan.kyc_completed.success": ["loan.kyc_started.success"],
  "loan.applied.success": ["loan.kyc_completed.success"],
  "loan.approved.success": ["loan.applied.success"],
  "features.unlock.success": ["features.view.action"],
  "features.unlock.failed": ["features.view.action"],
};

// Transitive closure of FUNNEL_PREREQS, memoised.
const _ancestorCache = new Map<string, Set<string>>();
export function funnelAncestors(canonical: string): Set<string> {
  const cached = _ancestorCache.get(canonical);
  if (cached) return cached;
  const out = new Set<string>();
  const walk = (c: string) => {
    for (const p of FUNNEL_PREREQS[c] ?? []) {
      if (!out.has(p)) {
        out.add(p);
        walk(p);
      }
    }
  };
  walk(canonical);
  _ancestorCache.set(canonical, out);
  return out;
}

// CONTEXT_PREREQS: gate-only edges (back-filled when missing, never propagate
// volume). Rule-derived so a NEW event that follows the taxonomy inherits sensible
// prerequisites without editing this file:
//   - every non-entry event needs an entry (login OR register)
//   - a proGated event needs the pro area to have been reached
//   - a failure outcome that has a sibling *.view needs that view
// Returned as a list of "any-of" groups: the group is satisfied if the session has
// emitted any member.
const PRO_ACCESS_ANY_OF = [
  "features.view.action",
  "features.unlock.success",
  "crypto-trading.page.view",
];

export function contextPrereqGroups(canonical: string): string[][] {
  const ev = BY_CANONICAL.get(canonical);
  if (!ev || ev.kind === "entry") return [];

  const groups: string[][] = [ENTRY_CANONICALS.slice()];

  if (ev.proGated && !PRO_ACCESS_ANY_OF.includes(canonical)) {
    const anyOf = PRO_ACCESS_ANY_OF.slice();
    const ownPageView = SIM_EVENTS.find(
      (e) => e.route === ev.route && e.kind === "page"
    )?.canonical;
    if (ownPageView && !anyOf.includes(ownPageView)) anyOf.push(ownPageView);
    groups.push(anyOf);
  }

  if (ev.kind === "outcome_failure" && ev.failureSiblingOf) {
    const sib = BY_CANONICAL.get(ev.failureSiblingOf);
    // only require the sibling when it is itself a *.view (a real "viewed the
    // feature" step), not another outcome
    if (sib && (sib.kind === "action" || sib.kind === "page") &&
        sib.canonical.endsWith(".view")) {
      groups.push([sib.canonical]);
    }
  }

  return groups;
}

/** All direct prerequisite groups for a canonical: funnel edges (each a singleton
 *  group) plus context groups. */
export function prereqGroups(canonical: string): string[][] {
  const funnel = (FUNNEL_PREREQS[canonical] ?? []).map((c) => [c]);
  return [...funnel, ...contextPrereqGroups(canonical)];
}

// ── Operator targets ──────────────────────────────────────────────────────────

export interface ParsedTarget {
  kind: "event" | "route";
  id: string;
  /** Multiplier on how often the target (and, unless relaxed, its funnel) fires. */
  traffic: number;
  /** Multiplier on the failure rate of the target. */
  failure: number;
  /** Canonicals this target directly controls. */
  canonicals: string[];
}

const TRAFFIC_MIN = 0;
const TRAFFIC_MAX = 20;
const FAILURE_MIN = 0;
const FAILURE_MAX = 20;

function clampMul(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(n, hi));
}

/**
 * Parse an untrusted `targets` array. Drops anything that does not name a real
 * catalog event or a real route -- an operator (or a typo) cannot introduce a new
 * event/record identifier. Drops no-op targets (traffic == 1 and failure == 1).
 */
export function parseTargets(raw: unknown): ParsedTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedTarget[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const kind = e.kind === "route" ? "route" : e.kind === "event" ? "event" : null;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    if (!kind || !id) continue;

    let canonicals: string[];
    if (kind === "event") {
      if (!BY_CANONICAL.has(id)) continue;
      canonicals = [id];
    } else {
      if (!KNOWN_ROUTES.includes(id)) continue;
      canonicals = Array.from(
        new Set(SIM_EVENTS.filter((ev) => ev.route === id).map((ev) => ev.canonical))
      );
    }

    const dedupeKey = `${kind}:${id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const traffic = clampMul(e.traffic, TRAFFIC_MIN, TRAFFIC_MAX, 1);
    const failure = clampMul(e.failure, FAILURE_MIN, FAILURE_MAX, 1);
    if (traffic === 1 && failure === 1) continue;

    out.push({ kind, id, traffic, failure, canonicals });
  }
  return out;
}

export function describeTargets(targets: ParsedTarget[], relaxJourney: boolean): string[] {
  const lines: string[] = [];
  if (relaxJourney) {
    lines.push(
      "Journey realism safeguard OFF -- targeted routes/events move independently of " +
      "their prerequisites and dependents (anomaly / exploit-shaped run)."
    );
  }
  for (const t of targets) {
    const what = t.kind === "route" ? `route ${t.id}` : `event ${t.id}`;
    const parts: string[] = [];
    if (t.traffic !== 1) parts.push(`traffic x${t.traffic}`);
    if (t.failure !== 1) parts.push(`failure x${t.failure}`);
    lines.push(`Targeted ${what}: ${parts.join(", ")}`);
  }
  return lines;
}

// ── Runtime ───────────────────────────────────────────────────────────────────

export interface JourneyRuntimeOptions {
  targets: ParsedTarget[];
  relaxJourney: boolean;
}

export class JourneyRuntime {
  private readonly targets: ParsedTarget[];
  private readonly relaxJourney: boolean;
  /** Canonicals emitted in the session currently in progress. */
  private emitted = new Set<string>();
  private sessionId: string | null = null;
  /** Canonicals directly named by a target -- these are the ones the safeguard
   *  releases when relaxJourney is on. */
  private readonly relaxedCanonicals = new Set<string>();

  constructor(opts: JourneyRuntimeOptions) {
    this.targets = opts.targets;
    this.relaxJourney = opts.relaxJourney;
    if (this.relaxJourney) {
      for (const t of this.targets) for (const c of t.canonicals) this.relaxedCanonicals.add(c);
    }
  }

  /** Start (or continue) a session. Resets the emitted-set on a new session id.
   *  `seed` marks canonicals as already-satisfied (e.g. an implicit login for a
   *  live-pulse ping). */
  beginSession(sessionId: string, seed: string[] = []): void {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.emitted = new Set(seed);
  }

  has(canonical: string): boolean {
    return this.emitted.has(canonical);
  }

  record(canonical: string): void {
    this.emitted.add(canonical);
  }

  /** True when the safeguard is off AND this canonical is directly targeted. */
  isRelaxed(canonical: string): boolean {
    return this.relaxedCanonicals.has(canonical);
  }

  private targetMatches(t: ParsedTarget, canonical: string): boolean {
    return t.canonicals.includes(canonical);
  }

  /** The largest `traffic` value among targets that DIRECTLY name this canonical
   *  (or its route), or null when none do. */
  private directTraffic(canonical: string): number | null {
    let v: number | null = null;
    for (const t of this.targets) {
      if (t.traffic !== 1 && this.targetMatches(t, canonical)) {
        v = v === null ? t.traffic : Math.max(v, t.traffic);
      }
    }
    return v;
  }

  /**
   * Effective traffic multiplier for `canonical`.
   *  - direct hit: the target names this canonical (or its route)
   *  - upstream hit: this canonical is a FUNNEL ancestor of a targeted canonical
   *    whose traffic is being RAISED, and the safeguard is on -> raising a
   *    downstream target lifts its funnel proportionally (requirement C).
   *    A REDUCED target does not drag its upstream down: fewer people completing
   *    KYC does not mean fewer people started it -- the drop is at that step.
   *    Suppressed entirely when relaxJourney is on.
   * Boosts (>=1) combine by max; damps (<1) by min; the two are multiplied.
   */
  trafficMultiplier(canonical: string, active: boolean): number {
    if (!active || this.targets.length === 0) return 1;
    let boost = 1;
    let damp = 1;
    for (const t of this.targets) {
      if (t.traffic === 1) continue;
      const direct = this.targetMatches(t, canonical);
      let upstream = false;
      if (!this.relaxJourney && !direct && t.traffic > 1) {
        for (const tc of t.canonicals) {
          if (funnelAncestors(tc).has(canonical)) {
            upstream = true;
            break;
          }
        }
      }
      if (!direct && !upstream) continue;
      if (t.traffic >= 1) boost = Math.max(boost, t.traffic);
      else damp = Math.min(damp, t.traffic);
    }
    return boost * damp;
  }

  /**
   * Effective per-opportunity probability for `canonical` after the traffic knob.
   * A directly-targeted event with traffic > 1 can be INTRODUCED even when its
   * baseline propensity is ~0 (e.g. auth.role.violation, whose base rate is 0) --
   * "generate more traffic through this event" has to be able to create it, not
   * only amplify an existing tendency. Upstream (propagated) multipliers never
   * inject; they only scale what the generator already rolls.
   */
  private static readonly INJECT_FLOOR = 0.03;

  effectiveProbability(canonical: string, baseProb: number, active: boolean): number {
    const p = Math.max(0, Math.min(1, baseProb));
    if (!active || this.targets.length === 0) return p;
    const m = this.trafficMultiplier(canonical, active);
    const direct = this.directTraffic(canonical);
    if (direct !== null && direct > 1 && p < JourneyRuntime.INJECT_FLOOR) {
      return Math.min(1, direct * JourneyRuntime.INJECT_FLOOR);
    }
    return Math.max(0, Math.min(1, p * m));
  }

  /** Effective failure probability for a failure-outcome canonical. */
  failureProbability(canonical: string, baseProb: number, active: boolean): number {
    const p = Math.max(0, Math.min(1, baseProb));
    if (!active || this.targets.length === 0) return p;
    let mul = 1;
    for (const t of this.targets) {
      if (t.failure === 1) continue;
      if (this.targetMatches(t, canonical)) mul *= t.failure;
    }
    return Math.max(0, Math.min(1, p * mul));
  }

  /**
   * Raw event names to emit, in order, so `canonical` has its prerequisites in the
   * current session. Marks them satisfied so a later event in the same session does
   * not back-fill them again. No-op when the safeguard has released this canonical.
   */
  planBackfill(canonical: string): string[] {
    if (this.isRelaxed(canonical)) return [];
    const out: string[] = [];
    const visit = (c: string) => {
      for (const group of prereqGroups(c)) {
        if (group.some((g) => this.emitted.has(g))) continue;
        const rep = group.find((g) => RAW_FOR_CANONICAL.has(g));
        if (!rep) continue;
        this.emitted.add(rep); // optimistic: prevents a sibling re-backfilling it
        visit(rep);
        out.push(RAW_FOR_CANONICAL.get(rep)!);
      }
    };
    visit(canonical);
    return out;
  }
}

export function createJourneyRuntime(opts: JourneyRuntimeOptions): JourneyRuntime {
  return new JourneyRuntime(opts);
}

// ── Catalog payload for the operator UI ───────────────────────────────────────

export interface SimCatalog {
  routes: { id: string; label: string }[];
  events: { id: string; route: string; label: string; kind: SimEventKind; proGated: boolean }[];
}

const ROUTE_LABELS: Record<string, string> = {
  "/login": "Login",
  "/register": "Register",
  "/dashboard": "Dashboard",
  "/accounts": "Accounts",
  "/transactions": "Transactions",
  "/payees": "Payees",
  "/loans": "Loans",
  "/profile": "Profile",
  "/pro-features": "Pro features (hub)",
  "/pro-feature?id=crypto-trading": "Crypto Trading (pro)",
  "/pro-feature?id=wealth-management-pro": "Wealth Management (pro)",
  "/pro-feature?id=bulk-payroll-processing": "Bulk Payroll (pro)",
  "/pro-feature?id=ai-insights": "AI Insights (pro)",
  "/admin": "Admin scope",
};

export function buildCatalog(): SimCatalog {
  const seenCanon = new Set<string>();
  const events: SimCatalog["events"] = [];
  for (const ev of SIM_EVENTS) {
    if (seenCanon.has(ev.canonical)) continue;
    seenCanon.add(ev.canonical);
    events.push({
      id: ev.canonical,
      route: ev.route,
      label: ev.label,
      kind: ev.kind,
      proGated: Boolean(ev.proGated),
    });
  }
  events.sort((a, b) => (a.route + a.label).localeCompare(b.route + b.label));
  return {
    routes: KNOWN_ROUTES.map((id) => ({ id, label: ROUTE_LABELS[id] ?? id })),
    events,
  };
}
