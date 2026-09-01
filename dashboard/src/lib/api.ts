/**
 * Axios API client abstraction.
 * Provides a configured axios instance and typed API methods.
 * All data is fetched from the backend, no mock fallbacks.
 */

import axios, { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { toast } from 'sonner';
import {
  KPIMetric,
  TimeSeriesDataPoint,
  FeatureUsageDataPoint,
  BarDataPoint,
  FunnelStep,
  FeatureActivityRow,
  Tenant,
  AIInsight,
  PagesPerMinuteDataPoint,
  TopPage,
  DeviceBreakdown,
  LocationData,
  AuditLog,
  FeatureConfig,
  RetentionData,
  AvailableTenant,
  UserJourneyResponse,
  JourneyUser,
  JourneyEvent,
  AgentAnswer,
  AgentDataset,
  AgentGate,
  AgentStep,
  AgentVisual,
  KpiSeries,
  PersonaChoices,
  DimensionProvenance,
  DimensionProvenanceResponse,
  IntelligenceInsight,
  IntelligenceRecommendation,
  RuntimeTelemetry,
  SourceHealth,
} from '@/types';
import { TENANT_TO_APP, resolveAppIdFromPathname, resolvePrimaryAppIdFromAdminApps } from './feature-map';

/**
 * One place that decides how a failed fetch is reported.
 *
 * A 403 is the server working correctly -- this role is not permitted here -- and logging it at
 * `error` put red entries in the console for a policy decision. A transport failure is a real
 * fault and stays an error. Both still resolve to an empty result so one panel cannot take the
 * dashboard down.
 */
function logFetchFailure(what: string, error: unknown): void {
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 403 || status === 401) {
    console.info(`${what}: not permitted for this role (${status})`);
    return;
  }
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Failed to fetch ${what}: ${detail}`);
}

/** Base API configuration */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8001';

/** Configured axios instance with interceptors */
const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

function setRequestHeader(config: InternalAxiosRequestConfig, key: string, value: string) {
  const headers = config.headers as unknown;
  if (headers && typeof (headers as { set?: unknown }).set === 'function') {
    (headers as { set: (k: string, v: string) => void }).set(key, value);
    return;
  }

  // Fallback for environments where Axios headers are plain objects.
  config.headers = {
    ...(config.headers || {}),
    [key]: value,
  } as InternalAxiosRequestConfig['headers'];
}

type SessionShape = {
  user?: {
    email?: string;
    role?: string;
    adminApps?: string[];
  };
};

const SESSION_CACHE_TTL_MS = 15000;
let cachedSession: SessionShape | null = null;
let cachedSessionAt = 0;
let inFlightSessionPromise: Promise<SessionShape | null> | null = null;

async function getCachedSession(): Promise<SessionShape | null> {
  const now = Date.now();
  if (cachedSession && now - cachedSessionAt < SESSION_CACHE_TTL_MS) {
    return cachedSession;
  }

  if (inFlightSessionPromise) {
    return inFlightSessionPromise;
  }

  inFlightSessionPromise = (async () => {
    try {
      const { getSession } = await import('next-auth/react');
      const session = (await getSession()) as SessionShape | null;
      cachedSession = session;
      cachedSessionAt = Date.now();
      return session;
    } catch {
      return null;
    } finally {
      inFlightSessionPromise = null;
    }
  })();

  return inFlightSessionPromise;
}

/**
 * The RBAC header set for the signed-in session.
 *
 * Extracted so the axios interceptor and the SSE stream below build it the SAME way. These headers
 * and `RBACMiddleware` are a matched pair; a second, hand-rolled copy for the streaming route is
 * exactly how the two sides drift and everything 403s.
 */
export async function rbacHeaders(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const session = await getCachedSession();
    if (!session?.user) return out;
    const appAliasMap: Record<string, string> = { ...TENANT_TO_APP };
    if (session.user.email) out['X-User-Email'] = session.user.email;
    if (session.user.role) out['X-User-Role'] = session.user.role;
    if (session.user.adminApps) {
      const adminApps = session.user.adminApps as string[];
      out['X-Admin-Apps'] = Array.from(
        new Set(
          adminApps.map((app) => appAliasMap[String(app).toLowerCase()] || String(app).toLowerCase())
        )
      ).join(',');

      const routeAppId =
        typeof window !== 'undefined'
          ? resolveAppIdFromPathname(window.location.pathname)
          : null;
      const activeAppId = routeAppId || resolvePrimaryAppIdFromAdminApps(adminApps);
      if (activeAppId) out['X-Active-App'] = activeAppId;
    }
  } catch {
    // Ignore if called in non-browser context
  }
  return out;
}

// Request interceptor for auth tokens
apiClient.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    const headers = await rbacHeaders();
    for (const [key, value] of Object.entries(headers)) {
      setRequestHeader(config, key, value);
    }
    return config;
  },
  (error: Error) => Promise.reject(error)
);

// Response interceptor for error handling
apiClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error: Error & { response?: { status: number; data?: { detail?: string } }; config?: { url?: string } }) => {
    const status = error.response?.status;
    const url = error.config?.url || 'unknown';
    const detail = error.response?.data?.detail || error.message;
    
    // Only show toast for non-403 errors (403 = RBAC restriction, expected)
    if (status === 403) {
      console.warn(`[RBAC] Access denied for ${url}`);
    } else if (status === 500) {
      toast.error(`Server error`, { description: detail, duration: 4000 });
    } else if (status && status >= 400) {
      toast.error(`Request failed (${status})`, { description: detail, duration: 3000 });
    }
    
    return Promise.reject(error);
  }
);

/* ─────────────── Helper Types ─────────────── */

interface BackendFeatureUsageItem {
  event_name: string;
  total_interactions: number;
  unique_users: number;
}

interface BackendFunnelStep {
  step: number;
  event_name: string;
  users_completed: number;
  drop_off_pct: number;
}

interface BackendInsight {
  type: string;
  message: string;
  severity: 'high' | 'medium' | 'low';
  confidence?: number | string;
}

interface BackendAIReportResponse {
  tenant_id: string;
  report: string;
  cached?: boolean;
  generated_at?: string | null;
  time_range?: string;
  insights?: BackendInsight[];
}

interface AIReportPayload {
  tenant_id: string;
  report: string;
  cached?: boolean;
  generated_at?: string | null;
  time_range?: string;
  insights: AIInsight[];
}

interface BackendTrafficRow {
  date: string;
  visitors: number;
  pageViews: number;
}

interface BackendFeatureUsageRow {
  date: string;
  usage: number;
}

interface BackendDeviceRow {
  device: string;
  value: number;
}

interface BackendChannelRow {
  name: string;
  value: number;
  formattedValue: string;
}

interface BackendTopPageRow {
  pageUrl: string;
  totalEvents: number;
  comparisonPct: number;
  rank: number;
  features: { feature: string; displayName: string; count: number; inPagePct: number }[];
}

interface BackendPPMRow {
  hour: string;
  value: number;
}

interface BackendActivityRow {
  feature: string;
  segments: { color: string; width: number }[];
  level: string;
}

export interface DeploymentInfoResponse {
  mode: string;
  is_cloud: boolean;
  is_on_prem: boolean;
  local_tenant: string | null;
}

interface AdminSummaryResponse {
  total_tenants: number;
  total_events: number;
  top_tenants: Array<{ id: string; name: string; events: number }>;
  time_range?: string;
  available?: boolean;
}

interface AdminAppSummaryResponse {
  kpi: KPIMetric[];
  insights: BackendInsight[];
}

interface TransparencyCategory {
  category: string;
  is_synced: boolean;
  details: string;
}

interface TransparencyResponse {
  message: string;
  visible_categories: TransparencyCategory[];
}

interface LicenseUsageResponse {
  summary: {
    total_licensed: number;
    total_used: number;
    total_used_licensed?: number;
    waste_pct: number;
    pro_users?: number;
    total_users?: number;
    pro_adoption_pct?: number;
    estimated_revenue?: number;
    wow_change?: number;
  };
  licensed: Array<{ feature_name: string; plan_tier: string; is_used: boolean; usage_count: number; unique_users: number; usage_pct: number; trend: Array<{ date: string; count: number }> }>;
  unused_licensed: Array<{ feature_name: string; plan_tier: string; is_used: boolean; usage_count: number; unique_users: number; usage_pct: number; trend: Array<{ date: string; count: number }> }>;
  unlicensed_used: Array<{ feature_name: string; usage_count: number; unique_users: number; usage_pct: number }>;
  nexabank_context?: {
    last_event_at?: string | null;
    pro_events_30d?: number;
    pro_feature_catalog?: Array<{ feature_id: string; title: string }>;
    top_relevant_features?: Array<{ feature_name: string; usage_count: number }>;
  };
}

interface TrackingToggleResponse {
  toggles: Array<{
    feature_name: string;
    display_name?: string;
    category?: string;
    is_enabled: boolean;
    changed_by: string;
    changed_at: string;
  }>;
}

interface JourneyUsersResponse {
  users: JourneyUser[];
}

interface SegmentationResponse {
  segments: Array<{ segment: string; users: number }>;
}

interface PredictiveResponse {
  predictions: Array<{
    feature_name: string;
    score: number;
    trend_score: number;
    users_pct: number;
    frequency_score: number;
    recent_7d: number;
    prev_7d: number;
    status: string;
    growth_rate?: number;
    projected_next_7d?: number;
    anomaly?: boolean;
  }>;
  total_users: number;
}

/* ─────────────── Error Caching for Resilient AI Insights ─────────────── */
// Cache recent failures to avoid hammering backend when service is down
const aiInsightsErrorCache: Record<string, { timestamp: number; error: string }> = {};
const INSIGHTS_CACHE_TIMEOUT = 30000; // 30 seconds

function normalizeConfidenceLabel(value?: number | string): 'High' | 'Medium' | 'Low' | undefined {
  if (typeof value === 'number') {
    if (value >= 0.75) return 'High';
    if (value >= 0.5) return 'Medium';
    return 'Low';
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'high') return 'High';
    if (v === 'medium') return 'Medium';
    if (v === 'low') return 'Low';
  }
  return undefined;
}

function confidenceFromSeverity(severity: BackendInsight['severity']): 'High' | 'Medium' | 'Low' {
  if (severity === 'high') return 'High';
  if (severity === 'medium') return 'Medium';
  return 'Low';
}

/* ─────────────── API Methods ─────────────── */


// ─── KPI cards ───────────────────────────────────────────────────────────────
interface KpiFromApi {
  kpi_id: string;
  name?: string;
  kind: 'count' | 'rate' | 'money';
  fundamentals: Record<string, number>;
  rate: number | null;
  previous?: { fundamentals: Record<string, number>; rate: number | null };
}
interface KpiEnvelope { tenant: string; persona: string; days: number; kpis: KpiFromApi[] }

const KPI_ICON: Record<string, string> = {
  signups: 'users',
  kyc_completion_rate: 'shield-check',
  loan_approval_volume: 'landmark',
  revenue: 'banknote',
  transaction_failure_rate: 'shield-alert',
};

/** A money KPI is the sum of its lines; a count is its first fundamental. */
function kpiAmount(k: { kind: string; fundamentals: Record<string, number>; rate: number | null }): number {
  if (k.kind === 'rate') return k.rate ?? 0;
  const values = Object.values(k.fundamentals || {});
  if (k.kind === 'money') return values.reduce((a, b) => a + b, 0);
  return values[0] ?? 0;
}

function formatKpi(kind: string, amount: number): string {
  if (kind === 'rate') return `${(amount * 100).toFixed(1)}%`;
  if (kind === 'money') return `$${Math.round(amount).toLocaleString()}`;
  return Math.round(amount).toLocaleString();
}

function toKpiCard(k: KpiFromApi): KPIMetric {
  const now = kpiAmount(k);
  const before = k.previous ? kpiAmount({ ...k, ...k.previous }) : 0;
  const change = before ? ((now - before) / before) * 100 : 0;
  return {
    id: k.kpi_id,
    label: k.name || k.kpi_id,
    value: formatKpi(k.kind, now),
    change: Math.abs(Number(change.toFixed(1))),
    changeDirection: change >= 0 ? 'up' : 'down',
    icon: KPI_ICON[k.kpi_id] || 'activity',
    // Two of revenue's three lines are modelled, so the whole figure is labelled.
    ...(k.kpi_id === 'revenue'
      ? { simulated: true,
          simulatedNote: 'Interchange and accrued interest are modelled, not settled.' }
      : {}),
  };
}


/** Track B returns envelopes, not arrays. Adapt at the boundary so no component sees the shape. */
interface TrafficEnvelope { dates?: string[]; txn_total?: number[]; txn_failed?: number[] }

function toAvailableTenants(data: unknown): AvailableTenant[] {
  if (Array.isArray(data)) return data as AvailableTenant[];
  const ids = (data as { tenants?: unknown })?.tenants;
  if (!Array.isArray(ids)) return [];
  return ids.map((t) =>
    typeof t === 'string'
      ? { id: t, name: t, eventCount: 0, uniqueUsers: 0 }
      : (t as AvailableTenant));
}

function toTrafficRows(data: unknown): Record<string, string | number>[] {
  if (Array.isArray(data)) return data as Record<string, string | number>[];
  const e = (data || {}) as TrafficEnvelope;
  const dates = Array.isArray(e.dates) ? e.dates : [];
  return dates.map((d, i) => ({
    date: d,
    total: Number(e.txn_total?.[i] ?? 0),
    failed: Number(e.txn_failed?.[i] ?? 0),
  }));
}


/** kyc_completion_rate -> KYC Completion Rate. */
function prettyKpi(id: string): string {
  if (!id) return 'Finding';
  return id.split('_').map((w) => (w === 'kyc' ? 'KYC' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** The window the engine actually scored, so a chart marks it rather than guessing. */
export interface MovedWindow {
  start: string; end: string; direction: number; severity: string;
  /** The expected range the movement was scored against, when one was recorded. */
  lower?: number; upper?: number;
}

interface RawInsightWindow {
  kpi_id: string; anomaly_id?: string; window_start?: string; window_end?: string;
  direction?: number; severity?: string; band_lower?: number; band_upper?: number;
}

export const dashboardAPI = {
  /** Fetch KPI metrics for the dashboard header */
  /** The five governed KPIs. The API returns fundamentals; the card shape is built here. */
  async getKPIMetrics(tenants: string[], range: string, persona?: string): Promise<KPIMetric[]> {
    const days = Number(String(range).replace(/[^0-9]/g, '')) || 30;
    const p = persona ? `&persona=${encodeURIComponent(persona)}` : '';
    try {
      const response = await apiClient.get<KpiEnvelope>(
        `/metrics/kpi?tenants=${tenants.join(',')}&days=${days}${p}`);
      return (response.data?.kpis || []).map(toKpiCard);
    } catch (error) {
      console.error('Failed to fetch KPI metrics', error);
      return [];
    }
  },
  async getTrafficData(tenants: string[], range: string): Promise<TimeSeriesDataPoint[]> {
    try {
      const days = Number(String(range).replace(/[^0-9]/g, '')) || 30;
      const raw = await apiClient.get<TrafficEnvelope | Record<string, string | number>[]>(
        `/metrics/traffic?tenants=${tenants.join(',')}&days=${days}`);
      const response = { data: toTrafficRows(raw.data) };
      return response.data.map((r: Record<string, string | number>) => {
        const point: Record<string, string | number> = { date: String(r.date) };
        for (const key of Object.keys(r)) {
          if (key !== 'date') {
            point[key] = Number(r[key]) || 0;
          }
        }
        return point as unknown as TimeSeriesDataPoint;
      });
    } catch (error) {
      console.error('Failed to fetch traffic data', error);
      return [];
    }
  },
  /** The KYC funnel from gold.funnel_daily: stage, order, entered. */
  async getFunnelData(tenants: string[], range: string): Promise<FunnelStep[]> {
    const days = Number(String(range).replace(/[^0-9]/g, '')) || 30;
    const COLORS = ['#a100ff', '#8b19e8', '#7500c0', '#5d1a94', '#460073'];
    try {
      const response = await apiClient.get<{
        stages?: { stage: string; order: number; entered: number }[];
      }>(`/funnels?tenants=${encodeURIComponent(tenants.join(','))}&days=${days}&funnel_id=kyc_funnel`);
      const stages = [...(response.data?.stages || [])].sort((a, b) => a.order - b.order);
      return stages.map((st, i) => {
        const value = Number(st.entered || 0);
        const prev = i === 0 ? value : Number(stages[i - 1].entered || 0);
        // Drop-off is measured against the stage before it, so the first stage never leaks.
        const dropOff = i === 0 || prev <= 0 ? 0 : Math.round(((prev - value) / prev) * 100);
        return {
          label: String(st.stage || '').replace(/_/g, ' '),
          value,
          dropOff,
          color: COLORS[i % COLORS.length],
        };
      });
    } catch (error) {
      console.error('Failed to fetch funnel data', error);
      return [];
    }
  },


  async getTenants(tenants?: string[], range: string = '7d'): Promise<Tenant[]> {
    try {
      const params = tenants && tenants.length > 0 ? `?tenants=${tenants.join(',')}&range=${range}` : `?range=${range}`;
      const response = await apiClient.get<{ tenants?: string[] } | Tenant[]>(`/tenants${params}`);
      const list = toAvailableTenants(response.data);
      return list as unknown as Tenant[];
    } catch {
      return [];
    }
  },

  async getAvailableTenants(range: string = '90d'): Promise<AvailableTenant[]> {
    try {
      const response = await apiClient.get<{ tenants?: string[] } | AvailableTenant[]>(
        `/tenants/available?range=${range}`);
      return toAvailableTenants(response.data);
    } catch (error) {
      console.error('Failed to fetch available tenants', error);
      return [
        { id: "nexabank", name: "NexaBank", eventCount: 0, uniqueUsers: 0 },
      ];
    }
  },

  // ─── Cache for AI Insights failures to avoid hammering backend ───

  /** Fetch AI-generated insights using backend /insights endpoint */
  async getAIInsights(tenants: string[], range: string): Promise<AIInsight[]> {
    const cacheKey = `${tenants.join(',')}-${range}`;
    
    // Check if we recently failed for this key (avoid retry spam)
    const cached = aiInsightsErrorCache[cacheKey];
    if (cached && Date.now() - cached.timestamp < INSIGHTS_CACHE_TIMEOUT) {
      console.debug(`[AI Insights] Using cached error response for ${cacheKey}`);
      return dashboardAPI.getAIInsightsFallback('Retrying automatically...');
    }

    // Exponential backoff: 1s, 3s
    const delays = [1000, 3000];
    
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await apiClient.get<{ insights: BackendInsight[] }>(
          `/intelligence/insights?tenants=${encodeURIComponent(tenants.join(','))}`,
          { timeout: 15000 }
        );
        
        const insights = response.data.insights ?? [];
        
        // Cache cleared on success
        delete aiInsightsErrorCache[cacheKey];
        
        // Signal Store rows: headline, kpi_id, trust_verdict, confidence. The old mapping read
        // severity/message, which do not exist, so every card rendered "[object Object]".
        type StoredInsight = {
          insight_id?: string; kpi_id?: string; headline?: string; narrative?: string;
          trust_verdict?: string; confidence?: number; abstained?: number; simulated?: number;
        };
        return (insights as unknown as StoredInsight[]).map((row, ix) => {
          const conf = Number(row.confidence ?? 0);
          const quarantined = row.trust_verdict && row.trust_verdict !== 'pass';
          const abstained = Boolean(row.abstained);
          return {
            id: row.insight_id || `insight-${ix}`,
            type: (quarantined ? 'warning' : abstained ? 'info' : 'success') as
              'warning' | 'info' | 'success',
            title: prettyKpi(row.kpi_id || ''),
            message: row.headline || row.narrative || 'No finding recorded for this metric.',
            impact: conf >= 0.7 ? 'High' : conf >= 0.4 ? 'Medium' : 'Low',
            priority: (conf >= 0.7 ? 'high' : conf >= 0.4 ? 'medium' : 'low') as
              'high' | 'medium' | 'low',
            confidence: (conf >= 0.7 ? 'High' : conf >= 0.4 ? 'Medium' : 'Low') as
              'High' | 'Medium' | 'Low',
            actionRequired: Boolean(quarantined),
          };
        });
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        const message = (err as { message?: string })?.message || String(err);
        const isTimeout = message.includes('timeout') || (err as { code?: string })?.code === 'ECONNABORTED';
        const isNetworkError = message.includes('ECONNREFUSED') || message.includes('ERR_');
        
        // Log with context for debugging
        console.warn(
          `[AI Insights] Attempt ${attempt + 1}/2 failed | ` +
          `Status: ${status ?? 'N/A'} | ` +
          `Timeout: ${isTimeout} | ` +
          `Network: ${isNetworkError} | ` +
          `Tenants: ${tenants.join(',')} | ` +
          `Range: ${range}`
        );
        
        // Don't retry on auth (403) or permission (404) issues
        if (status === 403 || status === 404) {
          aiInsightsErrorCache[cacheKey] = { timestamp: Date.now(), error: `${status}: ${message}` };
          break;
        }
        
        // Wait before retry with exponential backoff
        if (attempt < delays.length) {
          await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        }
      }
    }
    
    // Cache the failure to prevent hammering
    aiInsightsErrorCache[cacheKey] = { timestamp: Date.now(), error: 'Max retries exceeded' };
    
    // Return informative fallback insights
    return dashboardAPI.getAIInsightsFallback('AI insights service is temporarily unavailable');
  },

  /** Generate fallback insights when backend is unavailable */
  getAIInsightsFallback(subtitle: string): AIInsight[] {
    return [{
      id: 'ai-fallback-0',
      type: 'info' as const,
      title: 'Insights Engine Unavailable',
      message: `${subtitle}. Insights will appear automatically once the backend is ready. Try refreshing in a few moments.`,
      impact: 'Low',
      priority: 'low',
      confidence: 'Low',
      actionRequired: false,
    }];
  },

  /** Fetch AI Summarization Report */
  async getAIReport(tenants: string[], range: string = '30d'): Promise<string> {
    try {
      const response = await apiClient.get<BackendAIReportResponse>(
        `/ai_report?tenants=${tenants.join(',')}&range=${range}`,
        { timeout: 120000 } // 120 seconds for report generation
      );
      return response.data.report || '';
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const message = (err as { message?: string })?.message || String(err);
      console.warn(`[AI Report] Failed to fetch | Status: ${status ?? 'N/A'} | Tenants: ${tenants.join(',')}`);
      
      if (status === 403 || status === 404) {
        return '# Access Denied\n\nYou do not have permission to view AI reports for the selected tenants.';
      }
      
      return '# AI Report Temporarily Unavailable\n\nThe report generation system is currently processing or unavailable. Please try again in a few moments.';
    }
  },

  /** Fetch the latest stored AI report snapshot */
  async getLatestAIReport(tenants: string[], range: string = '30d'): Promise<AIReportPayload> {
    try {
      const response = await apiClient.get<BackendAIReportResponse>(
        `/ai_report?tenants=${tenants.join(',')}&range=${range}`,
        { timeout: 30000 } // 30 seconds for cached reports
      );
      const insights: AIInsight[] = (response.data.insights || []).map((ins: BackendInsight, i: number) => ({
        id: `ai-${i}`,
        title: ins.type || 'Insight',
        message: ins.message || String(ins),
        type: ins.severity === 'high' ? 'warning' : ins.severity === 'medium' ? 'info' : 'success',
        priority: ins.severity,
        impact: ins.severity === 'high' ? 'High' : 'Medium',
        actionRequired: ins.severity === 'high',
      }));
      return { ...response.data, insights };
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      console.debug(`[AI Report Latest] Failed to fetch | Status: ${status ?? 'N/A'} | Tenants: ${tenants.join(',')}`);
      return {
        tenant_id: tenants.join(','),
        report: '',
        cached: true,
        generated_at: null,
        insights: [],
      };
    }
  },

  /** Generate a fresh AI report on demand */
  async generateAIReport(tenants: string[], range: string = '30d'): Promise<AIReportPayload> {
    try {
      const response = await apiClient.get<BackendAIReportResponse>(
        `/ai_report?tenants=${tenants.join(',')}&range=${range}&force_refresh=true`,
        { timeout: 300000 } // 300 seconds for report generation
      );
      const insights: AIInsight[] = (response.data.insights || []).map((ins: BackendInsight, i: number) => ({
        id: `ai-${i}`,
        title: ins.type || 'Insight',
        message: ins.message || String(ins),
        type: ins.severity === 'high' ? 'warning' : ins.severity === 'medium' ? 'info' : 'success',
        priority: ins.severity,
        impact: ins.severity === 'high' ? 'High' : 'Medium',
        actionRequired: ins.severity === 'high',
      }));
      return { ...response.data, insights };
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const fallbackSource = status === 404 ? 'latest snapshot unavailable' : 'generation failed';
      console.warn(`[AI Report Generate] Failed | Status: ${status ?? 'N/A'} | Tenants: ${tenants.join(',')} | ${fallbackSource}`);

      if (status === 404) {
        try {
          return await dashboardAPI.getLatestAIReport(tenants, range);
        } catch {
          // Fall through to the empty fallback below.
        }
      }
      
      return {
        tenant_id: tenants.join(','),
        report: '',
        cached: false,
        generated_at: null,
        time_range: range,
        insights: [],
      };
    }
  },

  async getDeploymentInfo(): Promise<DeploymentInfoResponse> {
    try {
      const response = await apiClient.get<DeploymentInfoResponse>('/deployment/info');
      return response.data;
    } catch (error) {
      console.warn('Failed to fetch deployment info, assuming CLOUD mode', error);
      return { mode: 'CLOUD', is_cloud: true, is_on_prem: false, local_tenant: null };
    }
  },

  async getAdminSummary(range: string = '30d'): Promise<AdminSummaryResponse> {
    try {
      const response = await apiClient.get<AdminSummaryResponse>(`/admin/summary?range=${range}`);
      return response.data;
    } catch (error) {
      console.warn(`Failed to fetch admin summary for range ${range}`, error);
      return { total_tenants: 0, total_events: 0, top_tenants: [], time_range: range, available: false };
    }
  },

  async getAdminAppSummary(tenants: string[]): Promise<{ kpi: KPIMetric[]; insights: AIInsight[] }> {
    try {
      const response = await apiClient.get<AdminAppSummaryResponse>(`/admin/app/${tenants.join(',')}/summary`);
      const payload = response.data;
      
      const insights: AIInsight[] = (payload.insights || []).map((insight: BackendInsight, ix: number) => ({
        id: `ai-${ix}`,
        type: insight.severity === 'high' ? 'warning' as const : insight.severity === 'medium' ? 'info' as const : 'success' as const,
        title: insight.type || 'Backend Insight',
        message: insight.message || String(insight),
        priority: insight.severity,
        impact: insight.severity === 'high' ? 'High' : 'Medium',
        actionRequired: insight.severity === 'high',
      }));

      return { kpi: payload.kpi || [], insights };
    } catch (error) {
      console.error('Failed to fetch admin app summary', error);
      return { kpi: [], insights: [] };
    }
  },

  /** Pro-feature adoption. Pro unlocks are a revenue line, so this stays. */
  async getProUsers(tenants: string[], range: string): Promise<{ pro_users: number; total_users: number; pro_adoption_pct: number }> {
    try {
      const response = await apiClient.get<{ pro_users: number; total_users: number; pro_adoption_pct: number }>(`/metrics/pro_users?tenants=${tenants.join(',')}&range=${range}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch pro users', error);
      return { pro_users: 0, total_users: 0, pro_adoption_pct: 0 };
    }
  },

  /** Daily series for one KPI, straight off the Metric API (gold rollups). */
  async getMetricSeries(tenant: string, kpiId: string, days: number): Promise<{
    kind: string; dates: string[]; fundamentals: Record<string, number[]>;
  } | null> {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    try {
      const r = await apiClient.get(
        `/metric/kpi/series?tenant=${tenant}&kpi_id=${kpiId}&start=${iso(start)}&end=${iso(end)}`);
      return r.data;
    } catch (error) {
      console.error(`Failed to fetch series for ${kpiId}`, error);
      return null;
    }
  },

  /** KPI ids the engine recorded an anomaly for, so a chart can mark a real movement. */
  async getMovedKpis(tenants: string[], days?: number): Promise<Record<string, MovedWindow>> {
    try {
      // The window must be the one scored over the range on screen, or the shading marks a
      // period the chart is not even showing.
      const r = await apiClient.get<{ insights?: RawInsightWindow[] }>(
        `/intelligence/insights?tenants=${encodeURIComponent(tenants.join(','))}`
        + (days ? `&days=${days}` : ''));
      const out: Record<string, MovedWindow> = {};
      for (const i of r.data?.insights || []) {
        if (!i.anomaly_id || !i.window_start) continue;
        out[i.kpi_id] = {
          // Dates only. The series is day-grain, so a timestamp would never match a tick.
          start: String(i.window_start).slice(0, 10),
          end: String(i.window_end || '').slice(0, 10),
          direction: Number(i.direction ?? 0),
          severity: String(i.severity || ''),
          lower: i.band_lower == null ? undefined : Number(i.band_lower),
          upper: i.band_upper == null ? undefined : Number(i.band_upper),
        };
      }
      return out;
    } catch {
      return {};
    }
  },

  /** KPI ids this persona may see. Hidden ones are never requested. */
  async getVisibleKpis(tenants: string[], days: number, persona: string): Promise<string[]> {
    try {
      const r = await apiClient.get<KpiEnvelope>(
        `/metrics/kpi?tenants=${tenants.join(',')}&days=${days}&persona=${encodeURIComponent(persona)}`);
      return (r.data?.kpis || []).map((k) => k.kpi_id);
    } catch {
      return [];
    }
  },

  async getLicenseUsage(tenants: string[], range: string): Promise<LicenseUsageResponse> {
    try {
      const response = await apiClient.get<LicenseUsageResponse>(`/license/usage?tenants=${tenants.join(',')}&range=${range}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch license usage', error);
      return { summary: { total_licensed: 0, total_used: 0, waste_pct: 0 }, licensed: [], unused_licensed: [], unlicensed_used: [] };
    }
  },

  async syncLicenses(tenants: string[], features: { feature_name: string; plan_tier: string; is_licensed?: boolean }[]): Promise<{ status: string }> {
    try {
      const response = await apiClient.post<{ status: string }>('/license/sync', { tenant_id: tenants.join(','), features });
      return response.data;
    } catch (error) {
      console.error('Failed to sync licenses', error);
      return { status: 'error' };
    }
  },

  /* ─────────────── Tracking Toggles ─────────────── */
  async getDimensionProvenance(
    tenants: string[],
    range: string,
  ): Promise<Record<string, DimensionProvenance>> {
    try {
      const response = await apiClient.get<DimensionProvenanceResponse>(
        `/metrics/dimension_provenance?tenants=${tenants.join(',')}&range=${range}`);
      return response.data?.dimensions ?? {};
    } catch (error) {
      logFetchFailure('Dimension provenance', error);
      // An empty map means "unknown", and the charts fall back to showing no badge. That is the
      // right failure direction: a missing badge is a smaller lie than a badge we cannot justify.
      return {};
    }
  },

  /* ─────────────── Intelligence Layer ─────────────── */

  /** Latest persona narrative with its evidence card. Persona is resolved server-side. */
  async getIntelligenceInsight(
    tenants: string[], kpiId?: string, persona?: string,
  ): Promise<IntelligenceInsight | null> {
    try {
      const kpi = kpiId ? `&kpi_id=${encodeURIComponent(kpiId)}` : '';
      // The server still resolves the persona; sending one can only narrow, never widen.
      const view = persona ? `&persona=${encodeURIComponent(persona)}` : '';
      const response = await apiClient.get<{ insight: IntelligenceInsight | null }>(
        `/intelligence/insight?tenants=${encodeURIComponent(tenants.join(','))}${kpi}${view}`);
      return response.data.insight ?? null;
    } catch (error) {
      console.error('Failed to fetch intelligence insight', error);
      return null;
    }
  },

  async getIntelligenceInsights(tenants: string[], limit = 20): Promise<IntelligenceInsight[]> {
    try {
      const response = await apiClient.get<{ insights: IntelligenceInsight[] }>(
        `/intelligence/insights?tenants=${encodeURIComponent(tenants.join(','))}&limit=${limit}`);
      return response.data.insights || [];
    } catch (error) {
      console.error('Failed to fetch intelligence insights', error);
      return [];
    }
  },

  /** Per-source freshness: grain, cadence and SLA for every connected source. */
  async getIntelligenceSources(tenants: string[]): Promise<SourceHealth[]> {
    try {
      const response = await apiClient.get<{ sources: SourceHealth[] }>(
        `/intelligence/sources?tenants=${encodeURIComponent(tenants.join(','))}`);
      return response.data.sources || [];
    } catch (error) {
      console.error('Failed to fetch intelligence sources', error);
      return [];
    }
  },

  async getIntelligenceTelemetry(tenants: string[]): Promise<RuntimeTelemetry | null> {
    try {
      const response = await apiClient.get<{ telemetry: RuntimeTelemetry }>(
        `/intelligence/telemetry?tenants=${encodeURIComponent(tenants.join(','))}`);
      return response.data.telemetry ?? null;
    } catch (error) {
      console.error('Failed to fetch intelligence telemetry', error);
      return null;
    }
  },

  async getIntelligenceRecommendations(tenants: string[], limit = 20): Promise<IntelligenceRecommendation[]> {
    try {
      const response = await apiClient.get<{ recommendations: IntelligenceRecommendation[] }>(
        `/intelligence/recommendations?tenants=${encodeURIComponent(tenants.join(','))}&limit=${limit}`);
      return response.data.recommendations || [];
    } catch (error) {
      console.error('Failed to fetch recommendations', error);
      return [];
    }
  },

  /** Ask the agent a question. Persona is resolved server-side; tenant scoping is a query param
   *  because RBACMiddleware reads tenant from the query string, not the body. */
  async askIntelligence(
    tenants: string[], question: string, persona?: string, days?: number,
  ): Promise<AgentAnswer | null> {
    try {
      const response = await apiClient.post<AgentAnswer>(
        `/intelligence/ask?tenants=${encodeURIComponent(tenants.join(','))}`,
        { question, ...(persona ? { persona } : {}), ...(days ? { days } : {}) });
      return response.data;
    } catch (error) {
      console.error('Failed to ask the intelligence agent', error);
      return null;
    }
  },

  /** A governed metric's real daily path, for the report's only time-series chart. */
  async getKpiSeries(
    tenants: string[], kpiId: string, days = 30,
  ): Promise<KpiSeries | null> {
    try {
      const response = await apiClient.get<KpiSeries>(
        `/intelligence/series?tenants=${encodeURIComponent(tenants.join(','))}` +
        `&kpi_id=${encodeURIComponent(kpiId)}&days=${days}`);
      return response.data;
    } catch (error) {
      console.warn('Failed to load the KPI series', error);
      return null;
    }
  },

  /**
   * The same answer, delivered step by step as the agent reasons.
   *
   * `EventSource` cannot be used: it is GET-only and carries no custom headers, and the question
   * is a POST body behind the RBAC header trio. So this reads the SSE frames off a fetch stream by
   * hand. Falls back to nothing, the caller keeps the batch route for that.
   */
  async streamIntelligence(
    tenants: string[],
    question: string,
    persona: string | undefined,
    handlers: {
      onRail?: (gates: AgentGate[]) => void;
      onStep?: (step: AgentStep) => void;
      /** Result tables and charts, published as each capability returns rather than at the end. */
      onResult?: (payload: { datasets: AgentDataset[]; visuals: AgentVisual[] }) => void;
      /** Capabilities about to run, announced before they are executed. */
      onPending?: (payload: { tools: { tool: string; gate: string; label: string }[] }) => void;
      onAnswer?: (answer: AgentAnswer) => void;
      onError?: (detail: string) => void;
    },
    signal?: AbortSignal,
    days?: number,
  ): Promise<void> {
    const headers = { 'Content-Type': 'application/json', ...(await rbacHeaders()) };
    const url =
      `${API_BASE_URL}/intelligence/ask/stream?tenants=${encodeURIComponent(tenants.join(','))}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(
        { question, ...(persona ? { persona } : {}), ...(days ? { days } : {}) }),
      signal,
    });
    if (!response.ok || !response.body) {
      handlers.onError?.(`the agent could not be reached (${response.status})`);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; a partial frame stays in the buffer.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const kind = /^event: (.+)$/m.exec(frame)?.[1];
        const raw = /^data: (.+)$/m.exec(frame)?.[1];
        if (!kind || !raw) continue;
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          continue;
        }
        if (kind === 'rail') {
          handlers.onRail?.((payload as { gates: AgentGate[] }).gates);
        } else if (kind === 'step') {
          handlers.onStep?.(payload as AgentStep);
        } else if (kind === 'result') {
          handlers.onResult?.(payload as { datasets: AgentDataset[]; visuals: AgentVisual[] });
        } else if (kind === 'pending') {
          handlers.onPending?.(payload as { tools: { tool: string; gate: string; label: string }[] });
        } else if (kind === 'answer') {
          handlers.onAnswer?.(payload as AgentAnswer);
        } else if (kind === 'error') {
          handlers.onError?.((payload as { detail: string }).detail);
        }
      }
    }
  },

  /**
   * Persona views this role may switch between. Server-authored; the client never widens it.
   *
   * Rethrows rather than returning an empty list: react-query caches a returned value as a
   * SUCCESS, so one transient failure hid the persona switcher for the whole `staleTime`. An
   * error is retried; an empty success is not.
   */
  async getIntelligencePersonas(tenants: string[]): Promise<PersonaChoices> {
    // An app_admin is scoped from the query string; without it the request is refused.
    const response = await apiClient.get<PersonaChoices>(
      `/intelligence/personas?tenants=${encodeURIComponent(tenants.join(','))}`);
    return response.data;
  },

  /** Human feedback on an insight. Phase 1 executes nothing automatically. */
  async recordIntelligenceOutcome(payload: {
    investigation_id: string; insight_id: string; tenant_id: string;
    signal: string; value: number; actor: string;
  }): Promise<{ status: string }> {
    try {
      const response = await apiClient.post<{ status: string }>('/intelligence/outcome', payload);
      return response.data;
    } catch (error) {
      console.error('Failed to record outcome', error);
      return { status: 'error' };
    }
  },
};

export default apiClient;
