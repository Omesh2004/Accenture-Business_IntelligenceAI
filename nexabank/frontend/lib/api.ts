import axios from "axios";

const rawBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000/api";
export const API_BASE_URL = rawBaseUrl.replace(/\/$/, "");
const SESSION_STORAGE_KEY = "nexabank_session_id";

function makeSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getNexaBankSessionId(): string {
  if (typeof window === "undefined") return "";

  const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (existing) return existing;

  const sessionId = makeSessionId();
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  return sessionId;
}

/**
 * Real browser-derived context, cached once per session by useGeoLocation.
 *
 * The direct-to-ingestion path (lib/tracker.ts) bypasses the backend, so it never received
 * the geo/device enrichment forwardToIngestionAPI adds. Events from it landed with no
 * `location` and no `continent`, which makes them unlocalizable. Caching what
 * useGeoLocation already resolved lets that path carry real values instead of none.
 *
 * `continent` is deliberately absent: it cannot be derived from a country in the browser
 * without shipping a lookup table, and guessing it would fabricate a dimension.
 */
const BROWSER_CONTEXT_KEY = "nexabank_browser_context";

export interface BrowserContext {
  location?: string;   // country -- matches the physical metadata key used everywhere else
  city?: string;
  device_type?: string;
}

export function setBrowserContext(context: BrowserContext): void {
  if (typeof window === "undefined") return;
  try {
    const merged = { ...getBrowserContext(), ...context };
    window.sessionStorage.setItem(BROWSER_CONTEXT_KEY, JSON.stringify(merged));
  } catch {
    // sessionStorage can throw in private mode -- telemetry must never break the app
  }
}

export function getBrowserContext(): BrowserContext {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.sessionStorage.getItem(BROWSER_CONTEXT_KEY) || "{}");
  } catch {
    return {};
  }
}

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
});

const INGESTION_URL = process.env.NEXT_PUBLIC_INGESTION_URL ?? "http://localhost:8000/events";

/**
 * True when a request targets NexaBank's own backend or the ingestion API.
 * The session id identifies a browser session, so it must never be attached to
 * a third-party host -- scope every attachment through this check.
 */
function isFirstPartyRequest(url: string | undefined, baseURL: string | undefined): boolean {
  const target = `${baseURL ?? ""}${url ?? ""}`;
  if (!target) return false;
  if (target.startsWith("/")) return true; // same-origin relative path
  return target.startsWith(API_BASE_URL) || target.startsWith(INGESTION_URL);
}

function attachSessionHeader<T extends { url?: string; baseURL?: string; headers?: unknown }>(config: T): T {
  if (!isFirstPartyRequest(config.url, config.baseURL)) return config;

  const sessionId = getNexaBankSessionId();
  if (sessionId) {
    config.headers = config.headers ?? {};
    (config.headers as Record<string, string>)["x-session-id"] = sessionId;
  }
  return config;
}

apiClient.interceptors.request.use(attachSessionHeader);

// FOUNDATION-2. `apiClient` is not the instance the app actually uses -- all 56 call sites
// import the bare `axios` default. Registering here too is what makes the session id reach
// eventTracker.ts's AsyncLocalStorage; without it getSessionId() falls through to a fresh
// `server-<uuid>` per event, which also defeats the per-session geo/device profile cache.
// Guarded so Next.js fast-refresh cannot stack duplicate interceptors.
declare global {
  // eslint-disable-next-line no-var
  var __nexabankSessionInterceptor: number | undefined;
}

if (globalThis.__nexabankSessionInterceptor === undefined) {
  globalThis.__nexabankSessionInterceptor = axios.interceptors.request.use(attachSessionHeader);
}
