import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import axios from "axios";
import { AsyncLocalStorage } from "async_hooks";
import { prisma } from "../prisma";

const INGESTION_API_URL = process.env.INGESTION_API_URL || "http://localhost:8000/events";

/**
 * P0-10. The forwarder used to swallow every failure, so a 403 (tracking disabled), a 422, a
 * timeout and a restart were indistinguishable from outside -- and the Trust Gate could not tell
 * "the KPI dropped" from "the forwarder broke". Counted here and exposed at /health/forwarder.
 */
export const forwarderStats = {
  attempted: 0,
  ok: 0,
  failed: 0,
  byStatus: {} as Record<string, number>,
  lastErrorAt: null as string | null,
  lastOkAt: null as string | null,
};

function recordForwardOutcome(status: string, ok: boolean): void {
  forwarderStats.attempted += 1;
  forwarderStats.byStatus[status] = (forwarderStats.byStatus[status] || 0) + 1;
  if (ok) {
    forwarderStats.ok += 1;
    forwarderStats.lastOkAt = new Date().toISOString();
  } else {
    forwarderStats.failed += 1;
    forwarderStats.lastErrorAt = new Date().toISOString();
  }
}

/**
 * Hashes a userId using SHA-256 for analytics privacy.
 */
export function hashUserId(userId: string): string {
  return crypto.createHash("sha256").update(userId).digest("hex");
}

/**
 * Maps the Prisma tenant id (`bank_a`) to the analytics tenant id (`nexabank`).
 * Round 2 is one bank.
 */
const TENANT_ANALYTICS_MAP: Record<string, string> = { bank_a: "nexabank" };

function resolveAnalyticsTenantId(prismaId: string): string {
  return TENANT_ANALYTICS_MAP[prismaId] || prismaId;
}

/* ═══════════════════════════════════════════════════════════════════
 * REALISTIC GLOBAL USER SIMULATION
 * Users from different regions use different devices, at different
 * times, and interact with different features at different rates.
 * ═══════════════════════════════════════════════════════════════════ */

interface GeoProfile {
  country: string;
  continent: string;
  city: string;
  weight: number;       // relative probability of being selected
  deviceBias: { desktop: number; mobile: number; tablet: number };
  channelBias: string[];
  peakHours: number[];  // UTC hours when this region is most active
}

interface SessionProfile {
  geo: GeoProfile;
  deviceType: string;
  channel: "web" | "mobile" | "api" | "batch";
  /** Last-seen epoch ms. FIFO eviction re-randomised a still-active session's dimensions,
   *  reintroducing the intra-session flip FOUNDATION-2 fixed. */
  lastSeen: number;
  /** Keys this profile invented, so the pipeline can refuse to localize on them (P0-8). */
  simulatedKeys: string[];
  /** Real browser-reported geo, captured at session creation only (see getSessionProfile). */
  realCountry?: string;
  realCity?: string;
  realContinent?: string;
}

interface RequestTelemetryContext {
  sessionId?: string;
}

const requestTelemetryContext = new AsyncLocalStorage<RequestTelemetryContext>();
const sessionProfiles = new Map<string, SessionProfile>();
const MAX_SESSION_PROFILES = 10000;

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function requestTelemetryMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const sessionId = firstHeaderValue(req.headers["x-session-id"]) || firstHeaderValue(req.headers["x-nexabank-session-id"]);
  requestTelemetryContext.run({ sessionId }, next);
}

const GEO_PROFILES: GeoProfile[] = [
  // Asia (high mobile, peak UTC 3-9)
  { country: "India", continent: "Asia", city: "Mumbai", weight: 18, deviceBias: { desktop: 25, mobile: 65, tablet: 10 }, channelBias: ["direct", "mobile_app", "social"], peakHours: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] },
  { country: "India", continent: "Asia", city: "Bangalore", weight: 12, deviceBias: { desktop: 40, mobile: 50, tablet: 10 }, channelBias: ["direct", "referral"], peakHours: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  { country: "Japan", continent: "Asia", city: "Tokyo", weight: 8, deviceBias: { desktop: 35, mobile: 55, tablet: 10 }, channelBias: ["direct", "organic"], peakHours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
  { country: "Singapore", continent: "Asia", city: "Singapore", weight: 5, deviceBias: { desktop: 45, mobile: 45, tablet: 10 }, channelBias: ["direct", "referral"], peakHours: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  { country: "UAE", continent: "Asia", city: "Dubai", weight: 4, deviceBias: { desktop: 40, mobile: 50, tablet: 10 }, channelBias: ["direct", "social"], peakHours: [4, 5, 6, 7, 8, 9, 10, 11, 12] },
  // North America (balanced, peak UTC 13-22)
  { country: "USA", continent: "North America", city: "New York", weight: 15, deviceBias: { desktop: 55, mobile: 35, tablet: 10 }, channelBias: ["direct", "organic", "email"], peakHours: [13, 14, 15, 16, 17, 18, 19, 20, 21, 22] },
  { country: "USA", continent: "North America", city: "San Francisco", weight: 8, deviceBias: { desktop: 60, mobile: 30, tablet: 10 }, channelBias: ["direct", "organic"], peakHours: [16, 17, 18, 19, 20, 21, 22, 23, 0, 1] },
  { country: "Canada", continent: "North America", city: "Toronto", weight: 5, deviceBias: { desktop: 50, mobile: 40, tablet: 10 }, channelBias: ["direct", "email"], peakHours: [13, 14, 15, 16, 17, 18, 19, 20, 21] },
  // Europe (desktop-heavy, peak UTC 7-16)
  { country: "United Kingdom", continent: "Europe", city: "London", weight: 10, deviceBias: { desktop: 55, mobile: 35, tablet: 10 }, channelBias: ["direct", "organic", "email"], peakHours: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16] },
  { country: "Germany", continent: "Europe", city: "Berlin", weight: 6, deviceBias: { desktop: 60, mobile: 30, tablet: 10 }, channelBias: ["direct", "organic"], peakHours: [7, 8, 9, 10, 11, 12, 13, 14, 15] },
  { country: "France", continent: "Europe", city: "Paris", weight: 4, deviceBias: { desktop: 50, mobile: 40, tablet: 10 }, channelBias: ["direct", "social"], peakHours: [7, 8, 9, 10, 11, 12, 13, 14, 15] },
  // South America (mobile-heavy, peak UTC 12-20)
  { country: "Brazil", continent: "South America", city: "São Paulo", weight: 6, deviceBias: { desktop: 30, mobile: 60, tablet: 10 }, channelBias: ["direct", "social", "mobile_app"], peakHours: [12, 13, 14, 15, 16, 17, 18, 19, 20] },
  // Africa (mobile dominant, peak UTC 6-14)
  { country: "Nigeria", continent: "Africa", city: "Lagos", weight: 3, deviceBias: { desktop: 20, mobile: 70, tablet: 10 }, channelBias: ["mobile_app", "social"], peakHours: [6, 7, 8, 9, 10, 11, 12, 13, 14] },
  { country: "South Africa", continent: "Africa", city: "Cape Town", weight: 2, deviceBias: { desktop: 40, mobile: 50, tablet: 10 }, channelBias: ["direct", "organic"], peakHours: [6, 7, 8, 9, 10, 11, 12, 13, 14] },
  // Oceania
  { country: "Australia", continent: "Oceania", city: "Sydney", weight: 4, deviceBias: { desktop: 50, mobile: 40, tablet: 10 }, channelBias: ["direct", "organic", "email"], peakHours: [21, 22, 23, 0, 1, 2, 3, 4, 5, 6] },
];

/**
 * Weighted random selection from geo profiles.
 */
function selectGeoProfile(): GeoProfile {
  const totalWeight = GEO_PROFILES.reduce((s, g) => s + g.weight, 0);
  let r = Math.random() * totalWeight;
  for (const profile of GEO_PROFILES) {
    r -= profile.weight;
    if (r <= 0) return profile;
  }
  return GEO_PROFILES[0];
}

/**
 * Select a device type based on the geo profile's device bias.
 */
function selectDevice(profile: GeoProfile): string {
  const r = Math.random() * 100;
  if (r < profile.deviceBias.desktop) return "desktop";
  if (r < profile.deviceBias.desktop + profile.deviceBias.mobile) return "mobile";
  return "tablet";
}

/**
 * Log-normal response time simulation.
 * Produces a natural distribution concentrated around ~55ms with a long tail to ~300ms.
 * Uses Box-Muller transform to generate normally distributed values,
 * then exponentiates to get log-normal distribution.
 */
function simulateResponseTime(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  // Box-Muller transform: generates N(0,1)
  const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
  // Log-normal: exp(mu + sigma * z), mu=4.0 (median ~55ms), sigma=0.7
  const raw = Math.exp(4.0 + z * 0.7);
  return Math.max(15, Math.min(300, Math.round(raw)));
}

/**
 * Normalizes simulated channel values to the ingestion API enum.
 */
function normalizeChannel(channel: unknown): "web" | "mobile" | "api" | "batch" {
  const value = String(channel || "").trim().toLowerCase();

  if (value === "mobile" || value === "mobile_app" || value === "app") {
    return "mobile";
  }

  if (value === "api" || value === "batch") {
    return value;
  }

  return "web";
}

function getSessionId(metadata: Record<string, unknown> | null | undefined): string {
  const safeMetadata = metadata || {};
  const fromMetadata = String(safeMetadata.session_id || safeMetadata.sessionId || "").trim();
  if (fromMetadata) return fromMetadata;

  const fromRequest = String(requestTelemetryContext.getStore()?.sessionId || "").trim();
  if (fromRequest) return fromRequest;

  return `server-${crypto.randomUUID()}`;
}

function getSessionProfile(sessionId: string, metadata: Record<string, unknown> | null | undefined): SessionProfile {
  const safeMetadata = metadata || {};
  // Resolved ONCE per session and never revised. Upgrading the profile when real geo shows
  // up later would still flip the value mid-session, which is the thing that has to not
  // happen: every dimension a session-grain KPI localizes on must be invariant within the
  // session (CLAUDE.md coupling point 6), or sum(cells) != total and the contribution shares
  // Localize produces are meaningless. Real geo arriving after the first event is therefore
  // deliberately discarded -- `location` on this path is simulated by design anyway.
  const existing = sessionProfiles.get(sessionId);
  if (existing) {
    existing.lastSeen = Date.now();
    return existing;
  }

  const geo = selectGeoProfile();
  const deviceType = String(safeMetadata.device_type || safeMetadata.device || selectDevice(geo));
  const channel = normalizeChannel((safeMetadata.channel as string) || geo.channelBias[Math.floor(Math.random() * geo.channelBias.length)]);
  // P0-8: a key is simulated only when THIS producer invented it. A value supplied by a real
  // signal (POST /events/location, or the simulate console's own per-session geo) is omitted,
  // so the marker stays honest per event rather than blanket.
  const simulatedKeys: string[] = [];
  if (!safeMetadata.country) simulatedKeys.push("location");
  if (!safeMetadata.city) simulatedKeys.push("city");
  if (!safeMetadata.continent) simulatedKeys.push("continent");
  if (!safeMetadata.device_type && !safeMetadata.device) simulatedKeys.push("device_type");
  if (!safeMetadata.channel) simulatedKeys.push("channel");

  const profile: SessionProfile = {
    geo,
    deviceType,
    channel,
    lastSeen: Date.now(),
    simulatedKeys,
    realCountry: safeMetadata.country ? String(safeMetadata.country) : undefined,
    realCity: safeMetadata.city ? String(safeMetadata.city) : undefined,
    realContinent: safeMetadata.continent ? String(safeMetadata.continent) : undefined,
  };

  if (sessionProfiles.size >= MAX_SESSION_PROFILES) {
    let oldestKey: string | undefined;
    let oldestSeen = Infinity;
    for (const [key, value] of sessionProfiles) {
      if (value.lastSeen < oldestSeen) {
        oldestSeen = value.lastSeen;
        oldestKey = key;
      }
    }
    if (oldestKey) sessionProfiles.delete(oldestKey);
  }
  sessionProfiles.set(sessionId, profile);
  return profile;
}

/**
 * Validates and auto-corrects event names to strict [page].[feature].[status] taxonomy.
 * Logs a warning when correction happens so developers can fix instrumentation.
 */
function enforceTaxonomy(eventName: string): string {
  const strictRegex = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
  const normalizePart = (part: string): string => part.replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "core";
  const normalizeStatus = (status: string): string => {
    if (status === "error" || status === "fail") return "failed";
    if (status === "viewed") return "view";
    if (status === "access") return "success";
    return status;
  };
  const splitFeatureStatus = (token: string): { feature: string; status: string } => {
    const t = normalizePart(token);
    const suffixMap: Array<[string, string]> = [
      ["_success", "success"],
      ["_failed", "failed"],
      ["_error", "failed"],
      ["_view", "view"],
      ["_access", "success"],
      ["_action", "action"],
    ];
    for (const [suffix, status] of suffixMap) {
      if (t.endsWith(suffix) && t.length > suffix.length) {
        return { feature: normalizePart(t.slice(0, -suffix.length)), status };
      }
    }
    return { feature: t, status: "action" };
  };

  const normalizedInput = String(eventName || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");

  if (strictRegex.test(normalizedInput)) {
    const [page, feature, status] = normalizedInput.split(".");
    if (["free", "pro", "core", "enterprise", "lending"].includes(page)) {
      const split = splitFeatureStatus(status);
      const candidate = `${normalizePart(feature)}.${split.feature}.${normalizeStatus(split.status)}`;
      if (strictRegex.test(candidate)) {
        return candidate;
      }
    }
    if (page === "auth" && (feature === "login" || feature === "register")) {
      return `${feature}.auth.${normalizeStatus(status)}`;
    }
    return `${page}.${feature}.${normalizeStatus(status)}`;
  }

  // Explicit legacy → canonical mappings
  const LEGACY_MAP: Record<string, string> = {
    'login': 'login.auth.success',
    'login_success': 'login.auth.success',
    'login_failed': 'login.auth.failed',
    'register': 'register.auth.success',
    'register_success': 'register.auth.success',
    'dashboard_view': 'dashboard.page.view',
    'accounts_view': 'accounts.page.view',
    'account_view': 'accounts.page.view',
    'transactions_view': 'transactions.page.view',
    'transaction_view': 'transactions.page.view',
    'payees_view': 'payees.page.view',
    'payee_added': 'payees.add_payee.success',
    'payee_edited': 'payees.edit_payee.success',
    'payee_deleted': 'payees.remove_payee.success',
    'payee_removed': 'payees.remove_payee.success',
    'payees': 'payees.page.view',
    'payment_completed': 'transactions.pay_now.success',
    'payment_failed': 'transactions.pay_now.failed',
    // Added during the NexaBank telemetry audit: transactionRoutes.ts's POST /transactions
    // handler was firing the untaxonomized literal "transfer_completed" for every TRANSFER
    // regardless of outcome. With no LEGACY_MAP entry it fell through to the generic fallback
    // (core.transfer_completed.action), which no contract references -- an invisible silent
    // zero, verified through the real chain. Mirrors the payment_* pair immediately above.
    'transfer_completed': 'transactions.transfer.success',
    'transfer_failed': 'transactions.transfer.failed',
    'loan_applied': 'loans.applied.success',
    'loan_approved': 'loans.approved.success',
    'loans_page_view': 'loans.page.view',
    'kyc_started': 'loans.kyc_started.success',
    'kyc_completed': 'loans.kyc_completed.success',
    'kyc_failed': 'loans.kyc_failed.failed',
    'kyc_abandoned': 'loans.kyc_abandoned.failed',
    'profile_view': 'profile.page.view',
    'profile_updated': 'profile.edit_details.success',
    'pro_unlocked': 'pro.features_unlock.success',
    'pro_license_unlocked': 'pro.features_unlock.success',
    'pro_feature_usage': 'dashboard.feature.view',
    'feature_view': 'dashboard.feature.view',
    'wealth_rebalance': 'wealth_management_pro.rebalance.success',
    'ai_insight_download': 'ai_insights.book.success',
    'crypto_trading': 'crypto_trading.page.view',
    'wealth_management_pro': 'wealth_management.page.view',
    'bulk_payroll_processing': 'bulk_payroll_processing.batch.success',
    'ai_insights': 'ai_insights.page.view',
    'page_view': 'dashboard.page.view',
    'location_captured': 'profile.location.success',
  };

  const mapped = LEGACY_MAP[normalizedInput];
  if (mapped) {
    console.warn(`[TAXONOMY] Auto-corrected "${eventName}" → "${mapped}"`);
    return mapped;
  }

  const parts = normalizedInput.split(".").filter(Boolean);
  while (parts.length >= 3 && ["free", "pro", "core", "enterprise", "lending"].includes(parts[0])) {
    parts.shift();
  }

  if (parts.length === 3 && parts[0] === "auth" && (parts[1] === "login" || parts[1] === "register")) {
    const candidate = `${parts[1]}.auth.${normalizeStatus(parts[2])}`;
    if (strictRegex.test(candidate)) {
      console.warn(`[TAXONOMY] Normalized "${eventName}" → "${candidate}"`);
      return candidate;
    }
  }

  if (parts.length === 2) {
    const page = normalizePart(parts[0]);
    const { feature, status } = splitFeatureStatus(parts[1]);
    const candidate = `${page}.${feature}.${normalizeStatus(status)}`;
    if (strictRegex.test(candidate)) {
      console.warn(`[TAXONOMY] Upgraded 2-part event "${eventName}" → "${candidate}"`);
      return candidate;
    }
  }

  if (parts.length >= 3) {
    const page = normalizePart(parts[0]);
    const status = normalizeStatus(normalizePart(parts[parts.length - 1]));
    const feature = normalizePart(parts.slice(1, -1).join("_")) || "action";
    const candidate = `${page}.${feature}.${status}`;
    if (strictRegex.test(candidate)) {
      console.warn(`[TAXONOMY] Normalized "${eventName}" → "${candidate}"`);
      return candidate;
    }
  }

  // Generic fallback: wrap unknown events so they still have 3 segments
  const safe = `core.${normalizePart(normalizedInput)}.action`;
  console.warn(`[TAXONOMY] Unknown event "${eventName}" → "${safe}"`);
  return safe;
}

/**
 * Derive metadata.path from the mapped event name.
 * Covers all NexaBank pages.
 */
function derivePathFromEvent(eventName: string): string {
  const normalized = String(eventName || "").trim().toLowerCase();
  const [page] = normalized.split(".");

  const pageMap: Record<string, string> = {
    login: "/login",
    register: "/register",
    dashboard: "/dashboard",
    accounts: "/accounts",
    transactions: "/transactions",
    payees: "/payees",
    loans: "/loans",
    profile: "/profile",
    crypto_trading: "/pro-feature?id=crypto-trading",
    wealth_management: "/pro-feature?id=wealth-management-pro",
    payroll: "/pro-feature?id=bulk-payroll-processing",
    ai_insights: "/pro-feature?id=ai-insights",
  };

  if (page && pageMap[page]) {
    return pageMap[page];
  }

  // Auth
  if (normalized.startsWith('auth.login')) return '/login';
  if (normalized.startsWith('auth.register') || normalized.startsWith('auth.registration')) return '/register';
  // Core pages
  if (normalized.startsWith('core.dashboard')) return '/dashboard';
  if (normalized.startsWith('core.accounts')) return '/accounts';
  if (normalized.startsWith('core.payees') || normalized.includes('payee')) return '/payees';
  if (normalized.startsWith('core.profile')) return '/profile';
  if (normalized.startsWith('core.transfers')) return '/transfers';
  if (normalized.startsWith('core.approvals')) return '/approvals';
  if (normalized.startsWith('core.cards')) return '/cards';
  // Payments / transactions
  if (normalized.startsWith('payments.history') || normalized.startsWith('core.transactions') || normalized.includes('payment')) return '/transactions';
  // Lending
  if (normalized.startsWith('lending.') || normalized.startsWith('loans')) return '/loans';
  // Pro features
  if (normalized.startsWith('pro.')) return '/pro-features';
  // Legacy
  if (normalized === 'dashboard_view' || normalized === 'page_view') return '/dashboard';
  if (normalized === 'accounts_view') return '/accounts';
  if (normalized === 'transactions_view') return '/transactions';
  if (normalized === 'payees_view' || normalized === 'payees') return '/payees';
  if (normalized === 'loan_applied' || normalized === 'loans_page_view') return '/loans';
  if (normalized === 'profile_view') return '/profile';
  // Generic background or cross-page features map to dashboard
  if (normalized.includes('.location') || normalized.includes('.stats') || normalized.includes('.features_unlock')) return '/dashboard';
  
  // Derive from second segment, fallback to /dashboard if unexpected segment length
  const parts = normalized.split('.');
  if (parts.length >= 2) {
      // Map known sub-spaces back to their major pages to avoid fragment paths
      const sub = parts[1];
      if (sub === 'loan') return '/loans';
      if (sub === 'payment' || sub === 'history' || sub === 'transactions') return '/transactions';
      if (sub === 'profile' || sub === 'dashboard') return `/${sub}`;
      if (sub === 'payees') return '/payees';
      if (sub === 'crypto_portfolio' || sub === 'crypto_trade_execution') return '/pro-features';
      if (sub.includes('wealth')) return '/pro-features';
      if (sub.includes('payroll')) return '/pro-features';
      if (sub.includes('finance_library')) return '/pro-features';
      
      // otherwise, default to dashboard
      return '/dashboard';
  }
  return '/dashboard';
}

/** Keys the CALLER declares it fabricated, via `metadata._simulated`. */
function declaredSimulatedKeys(metadata: Record<string, unknown>): string[] {
  const raw = (metadata as { _simulated?: unknown })._simulated;
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
}

/**
 * Forwards an event to the Pathway ingestion API (Kafka → ClickHouse)
 * so the analytics dashboard can visualize NexaBank data.
 * Fire-and-forget — analytics should never break the primary app.
 */
async function forwardToIngestionAPI(
  eventName: string,
  userId: string,
  tenantId: string,
  metadata: Record<string, unknown> = {},
  timestampOverride?: number,
  tier?: string,
  eventId?: string
): Promise<void> {
  // Enforce taxonomy
  const mappedEventName = enforceTaxonomy(eventName);

  const sessionId = getSessionId(metadata);
  const sessionProfile = getSessionProfile(sessionId, metadata);
  const geo = sessionProfile.geo;
  const deviceType = String(metadata.device_type || sessionProfile.deviceType);
  const simTime = simulateResponseTime();
  const channel = normalizeChannel((metadata.channel as string) || sessionProfile.channel);

  const rawMeasured = metadata.response_time_ms ?? (metadata as Record<string, unknown>).responseTime;
  const measuredResponseTime =
    typeof rawMeasured === "number" && Number.isFinite(rawMeasured) ? rawMeasured : undefined;

  const simulatedKeys = [...sessionProfile.simulatedKeys];
  if (measuredResponseTime === undefined) simulatedKeys.push("response_time_ms");
  // A caller that fabricated a value declares it here, and we union it in. getSessionProfile can
  // only mark what THIS module invented, and it reads "the caller supplied the key" as "a real
  // signal supplied it" -- true for POST /events/location, false for the simulate console, which
  // invents geo, device, channel and latency of its own. Without this union those keys reach
  // events_raw indistinguishable from measured ones, Localize happily slices a dice roll
  // (CLAUDE.md rule 13), and the Avg Response Time honesty badge can never fire.
  for (const key of declaredSimulatedKeys(metadata)) {
    if (!simulatedKeys.includes(key)) simulatedKeys.push(key);
  }

  try {
    const analyticsTenantId = resolveAnalyticsTenantId(tenantId);
    await axios.post(INGESTION_API_URL, {
      event_id: eventId || crypto.randomUUID(),
      session_id: sessionId,
      event_name: mappedEventName,
      tenant_id: analyticsTenantId,
      user_id: userId,
      timestamp: timestampOverride || Date.now() / 1000,
      channel: channel,
      metadata: {
        ...metadata,
        session_id: sessionId,
        source_tenant: tenantId,
        role: metadata.role || "user",
        device_type: deviceType,
        // Geographic context for continent-level analytics.
        // Resolved from the SESSION profile, never per event. Previously this read
        // `metadata.country || geo.country`, so an event that happened to carry a real
        // country (only /events/location does) used it while its siblings fell back to the
        // session's simulated geo -- one session then reported two different locations.
        // Observed: a single session carrying ['', 'India', 'Germany'].
        location: sessionProfile.realCountry || geo.country,
        continent: sessionProfile.realContinent || geo.continent,
        city: sessionProfile.realCity || geo.city,
        // P0-9. The frontend measures real latency but wrote it as `responseTime` (camelCase)
        // while this read `response_time_ms`, so the names never matched and the simulated value
        // won every time. Both spellings are accepted now, and the field is marked simulated
        // only when neither was supplied.
        response_time_ms: measuredResponseTime !== undefined ? measuredResponseTime : simTime,
        _simulated: simulatedKeys,
        // Page-level path for Top Pages aggregation
        path: metadata.path || derivePathFromEvent(mappedEventName),
        tier: tier || metadata.tier
      },
    }, { timeout: 3000 });
    recordForwardOutcome("202", true);
  } catch (err: unknown) {
    // Still swallowed -- telemetry must never break banking (CLAUDE.md rule 7) -- but no longer
    // silent: the outcome is counted so absence of data is observable.
    const status = (err as { response?: { status?: number } })?.response?.status;
    const code = (err as { code?: string })?.code;
    recordForwardOutcome(status ? String(status) : (code || "network_error"), false);
  }
}

export interface BatchedEvent {
  eventName: string;
  customerId: string | null;
  tenantId: string;
  metadata?: Record<string, unknown>;
  timestampOverride?: number;
  tier?: "free" | "pro" | "enterprise";
}

/**
 * The batched twin of `trackEvent`, for generators that emit many events at once.
 *
 * WHY THIS EXISTS. `trackEvent` does one `prisma.event.create` per event and awaits it. Postgres
 * is remote (measured: ~350ms per round trip), so a simulate run spent most of its wall clock
 * waiting on sequential inserts of rows it already had in hand. One `createMany` replaces N of
 * them.
 *
 * It keeps every guarantee the single-event path has:
 *  - `event_id` is minted here rather than by the database default, so it is still stable and
 *    still what reaches events_raw (FOUNDATION-1). createMany cannot return generated ids, and
 *    forwarding needs one -- minting up front is what makes the batch possible at all.
 *  - anonymous traffic is still keyed on the session, never a shared "anonymous" (NB-4).
 *  - forwarding stays fire-and-forget, so telemetry cannot block banking (CLAUDE.md rule 7).
 *
 * Ordering within the batch is preserved: rows carry their own timestamps, and the forwards are
 * issued in array order.
 */
export async function trackEventsBatch(events: BatchedEvent[]): Promise<void> {
  if (!events.length) return;
  const prepared = events.map((e) => {
    const metadata = e.metadata || {};
    const sessionId = getSessionId(metadata);
    const hashedUserId = e.customerId
      ? hashUserId(e.customerId)
      : `anon_${hashUserId(sessionId).slice(0, 32)}`;
    return {
      id: crypto.randomUUID(),
      ev: e,
      sessionId,
      hashedUserId,
      metadataWithSession: { ...metadata, session_id: sessionId } as Record<string, unknown>,
    };
  });

  try {
    await prisma.event.createMany({
      data: prepared.map((p) => ({
        id: p.id,
        eventName: p.ev.eventName,
        tenantId: p.ev.tenantId,
        userId: p.hashedUserId,
        customerId: p.ev.customerId || null,
        metadata: { ...p.metadataWithSession, tier: p.ev.tier } as any,
        timestamp: p.ev.timestampOverride
          ? new Date(p.ev.timestampOverride * 1000)
          : new Date(),
      })),
      skipDuplicates: true,
    });
  } catch (err) {
    console.error("[EVENT_TRACKER] Failed to store event batch:", err);
    return;
  }

  for (const p of prepared) {
    forwardToIngestionAPI(p.ev.eventName, p.hashedUserId, p.ev.tenantId, p.metadataWithSession,
                          p.ev.timestampOverride, p.ev.tier, p.id).catch(() => { });
  }

  // Same in-process broadcast the single-event path does. Dropping it would silently break the
  // simulate route's REAL-TIME PULSE section, whose whole purpose is to make a simulated user
  // appear on the live dashboard.
  try {
    const { broadcastEvent } = require("../server");
    if (broadcastEvent) {
      for (const p of prepared) {
        broadcastEvent("event", {
          eventName: p.ev.eventName,
          tenantId: p.ev.tenantId,
          userId: p.hashedUserId,
          metadata: {
            session_id: p.sessionId,
            country: p.metadataWithSession.country,
            city: p.metadataWithSession.city,
            continent: p.metadataWithSession.continent,
            device_type: p.metadataWithSession.device_type,
          },
        });
      }
    }
  } catch {
    // broadcastEvent not available yet during startup -- safe to ignore
  }
}

/**
 * Tracks an analytics event to the DB and forwards to Pathway ingestion API.
 * Also broadcasts via WebSocket for real-time dashboard updates.
 */
export async function trackEvent(
  eventName: string,
  customerId: string | null,
  tenantId: string,
  metadata: Record<string, unknown> = {},
  timestampOverride?: number,
  tier?: 'free' | 'pro' | 'enterprise'
): Promise<void> {
  try {
    // NB-4. Every logged-out visitor used to collapse into one user_id of "anonymous", so
    // windowFunnel GROUP BY user_id saw a single row that had performed every step of every
    // funnel -- any funnel with a pre-login stage reported near-100% conversion. Anonymous
    // traffic is now keyed on the session, which is the grain the contracts declare.
    const anonSessionId = getSessionId(metadata);
    const hashedUserId = customerId ? hashUserId(customerId) : `anon_${hashUserId(anonSessionId).slice(0, 32)}`;
    const sessionId = getSessionId(metadata);
    const metadataWithSession: Record<string, unknown> = { ...metadata, session_id: sessionId };
    const row = await prisma.event.create({
      data: {
        eventName,
        tenantId,
        userId: hashedUserId,
        customerId: customerId || null,
        metadata: { ...metadataWithSession, tier } as any,
        timestamp: timestampOverride ? new Date(timestampOverride * 1000) : undefined,
      },
    });

    // Forward to the Pathway analytics pipeline (fire-and-forget)
    forwardToIngestionAPI(eventName, hashedUserId, tenantId, metadataWithSession, timestampOverride, tier, row.id).catch(() => { });

    // Broadcast via WebSocket for real-time updates (lazy import to avoid circular deps)
    try {
      const { broadcastEvent } = require("../server");
      if (broadcastEvent) {
        broadcastEvent("event", {
          eventName,
          tenantId,
          userId: hashedUserId,
          metadata: {
            session_id: sessionId,
            country: metadataWithSession.country,
            city: metadataWithSession.city,
            continent: metadataWithSession.continent,
            device_type: metadataWithSession.device_type,
          },
        });
      }
    } catch {
      // broadcastEvent not available yet during startup — safe to ignore
    }
  } catch (err) {
    console.error("[EVENT_TRACKER] Failed to store event:", err);
  }
}

/**
 * API call tracking middleware — logs every request's method, path, status, and duration.
 */
export function apiTrackingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  const originalEnd = res.end.bind(res);

  // @ts-ignore
  res.end = function (...args: any[]) {
    const duration = Date.now() - startTime;
    const logEntry = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: duration,
      timestamp: new Date().toISOString(),
      ip: req.ip,
      userAgent: req.headers["user-agent"]?.substring(0, 100) ?? "unknown",
    };

    // Skip health check route logging
    if (req.path !== "/") {
      console.log(`[API] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
    }

    // Store significant events (errors + slow requests) to DB async
    if (res.statusCode >= 400 || duration > 2000) {
      prisma.event.create({
        data: {
          eventName: "api_call",
          tenantId: "system",
          userId: "system",
          metadata: { ...logEntry, response_time_ms: duration },
        },
      }).catch(() => { });
    }

    return originalEnd(...args);
  };

  next();
}
