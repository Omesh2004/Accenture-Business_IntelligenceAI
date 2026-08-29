/**
 * Axios API client abstraction.
 * Provides a configured axios instance and typed API methods.
 * All data is fetched from the backend — no mock fallbacks.
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
  AcquisitionChannel,
  LocationData,
  AuditLog,
  FeatureConfig,
  RetentionData,
  AvailableTenant,
  UserJourneyResponse,
  JourneyUser,
  JourneyEvent,
} from '@/types';
import { TENANT_TO_APP, resolveAppIdFromPathname, resolvePrimaryAppIdFromAdminApps } from './feature-map';

/** Base API configuration */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8001';

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

// Request interceptor for auth tokens
apiClient.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    try {
      const session = await getCachedSession();
      if (session?.user) {
        const appAliasMap: Record<string, string> = { ...TENANT_TO_APP };
        if (session.user.email) {
          setRequestHeader(config, 'X-User-Email', session.user.email);
        }
        if (session.user.role) {
          setRequestHeader(config, 'X-User-Role', session.user.role);
        }
        if (session.user.adminApps) {
          const adminApps = session.user.adminApps as string[];
          const normalizedApps = Array.from(
            new Set(
              adminApps
                .map((app) => appAliasMap[String(app).toLowerCase()] || String(app).toLowerCase())
            )
          );
          setRequestHeader(config, 'X-Admin-Apps', normalizedApps.join(','));

          const routeAppId =
            typeof window !== 'undefined'
              ? resolveAppIdFromPathname(window.location.pathname)
              : null;
          const activeAppId = routeAppId || resolvePrimaryAppIdFromAdminApps(adminApps);
          if (activeAppId) {
            setRequestHeader(config, 'X-Active-App', activeAppId);
          }
        }
      }
    } catch {
      // Ignore if called in non-browser context
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

export const dashboardAPI = {
  /** Fetch KPI metrics for the dashboard header */
  async getKPIMetrics(tenants: string[], range: string): Promise<KPIMetric[]> {
    try {
      const response = await apiClient.get<KPIMetric[]>(`/metrics/kpi?tenants=${tenants.join(',')}&range=${range}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch KPI metrics', error);
      return [];
    }
  },

  /** Fetch Secondary KPI metrics */
  async getSecondaryKPIMetrics(tenants: string[], range: string): Promise<KPIMetric[]> {
    try {
      const response = await apiClient.get<KPIMetric[]>(`/metrics/secondary_kpi?tenants=${tenants.join(',')}&range=${range}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch Secondary KPI metrics', error);
      return [];
    }
  },

  /** Fetch traffic overview time series data */
  async getTrafficData(tenants: string[], range: string): Promise<TimeSeriesDataPoint[]> {
    try {
      const response = await apiClient.get<Record<string, string | number>[]>(`/metrics/traffic?tenants=${tenants.join(',')}&range=${range}`);
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

  /** Fetch feature usage over time data */
  async getFeatureUsageData(tenants: string[], range: string): Promise<FeatureUsageDataPoint[]> {
    try {
      const response = await apiClient.get<Record<string, string | number>[]>(`/metrics/feature_usage_series?tenants=${tenants.join(',')}&range=${range}`);
      return response.data.map((r: Record<string, string | number>) => {
        const point: Record<string, string | number> = { date: String(r.date) };
        for (const key of Object.keys(r)) {
          if (key !== 'date') {
            point[key] = Number(r[key]) || 0;
          }
        }
        return point as unknown as FeatureUsageDataPoint;
      });
    } catch (error) {
      console.error('Failed to fetch feature usage', error);
      return [];
    }
  },

  /** Fetch top features ranking using backend /features/usage endpoint */
  async getTopFeatures(tenants: string[], range: string): Promise<BarDataPoint[]> {
    try {
      const response = await apiClient.get<{ usage: BackendFeatureUsageItem[] }>(`/features/usage?tenants=${tenants.join(',')}&range=${range}`);
      const backendUsage = response.data.usage || [];
      return backendUsage.map((item: BackendFeatureUsageItem) => ({
        name: item.event_name,
        value: item.total_interactions,
      }));
    } catch (error) {
      console.error('Failed to fetch top features from backend', error);
      return [];
    }
  },

  /** Fetch user journey funnel data using backend /funnels endpoint */
  async getFunnelData(tenants: string[], range: string): Promise<FunnelStep[]> {
    try {
      const { APP_REGISTRY } = await import('./feature-map');
      const canonicalStepMap: Record<string, string> = {
        login: 'login.auth.success',
        'login.auth.success': 'login.auth.success',
        dashboard_view: 'dashboard.page.view',
        'dashboard.page.view': 'dashboard.page.view',
        transfer_started: 'transaction.pay_now.success',
        transfer_completed: 'transaction.pay_now.success',
        'transaction.pay_now.success': 'transaction.pay_now.success',
        loan_applied: 'loan.applied.success',
        'loan.applied.success': 'loan.applied.success',
        kyc_started: 'loan.kyc_started.success',
        kyc_completed: 'loan.kyc_completed.success',
        'loan.kyc_started.success': 'loan.kyc_started.success',
        'loan.kyc_completed.success': 'loan.kyc_completed.success',
        authorizer_approved: 'transaction.pay_now.success',
      };

      const normalizeStepToken = (step: string): string =>
        String(step || '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '_');

      const toCanonicalStep = (step: string): string => {
        const normalized = normalizeStepToken(step);
        return canonicalStepMap[normalized] || normalized;
      };

      const selectedConfigs = tenants
        .map((tenantId) => APP_REGISTRY[tenantId])
        .filter(Boolean);

      const fallbackSteps = ['login.auth.success', 'dashboard.page.view', 'transaction.pay_now.success', 'loan.applied.success'];
      const mergedSteps = selectedConfigs.length > 0
        ? Array.from(
            new Set(
              selectedConfigs
                .flatMap((cfg) => cfg.funnelSteps || [])
                .map((step) => toCanonicalStep(step))
                .filter(Boolean)
            )
          )
        : fallbackSteps;

      const steps = mergedSteps.length >= 2 ? mergedSteps.join(',') : fallbackSteps.join(',');
      
      const response = await apiClient.get<{ funnel: BackendFunnelStep[] }>(`/funnels?tenants=${encodeURIComponent(tenants.join(','))}&steps=${encodeURIComponent(steps)}&window_minutes=60&range=${range}`);
      const funnel = response.data.funnel || [];
      
      return funnel.map((step: BackendFunnelStep) => ({
        step: step.step,
        label: step.event_name,
        value: step.users_completed,
        dropOff: step.drop_off_pct,
        timeToNextStep: '-',
        color: '#1a73e8',
      }));
    } catch (error) {
      console.error('Failed to fetch funnel from backend', error);
      return [];
    }
  },

  /** Fetch feature activity heatmap data */
  async getFeatureActivity(tenants: string[], range: string): Promise<FeatureActivityRow[]> {
    try {
      const response = await apiClient.get<BackendActivityRow[]>(`/features/activity?tenants=${tenants.join(',')}&range=${range}`);
      return response.data.map((row: BackendActivityRow) => ({
        feature: row.feature,
        segments: row.segments,
        level: row.level as 'High' | 'Med' | 'Low',
      }));
    } catch {
      return [];
    }
  },

  /** Fetch grid-based heatmap matrix for multi-tenant or time-based single tenant */
  async getFeatureHeatmap(tenants: string[], range: string): Promise<{ is_compare: boolean; groups: string[]; group_labels?: string[]; activities: unknown[] }> {
    try {
      const response = await apiClient.get(`/features/heatmap?tenants=${tenants.join(',')}&range=${range}`);
      return response.data;
    } catch {
      return {
        is_compare: false,
        groups: ['Error'],
        activities: []
      };
    }
  },

  /** Fetch tenant comparison data */
  async getTenants(tenants?: string[], range: string = '7d'): Promise<Tenant[]> {
    try {
      const params = tenants && tenants.length > 0 ? `?tenants=${tenants.join(',')}&range=${range}` : `?range=${range}`;
      const response = await apiClient.get<Tenant[]>(`/tenants${params}`);
      return response.data;
    } catch {
      return [];
    }
  },

  async getAvailableTenants(range: string = '90d'): Promise<AvailableTenant[]> {
    try {
      const response = await apiClient.get<AvailableTenant[]>(`/tenants/available?range=${range}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch available tenants', error);
      return [
        { id: "nexabank", name: "NexaBank", eventCount: 0, uniqueUsers: 0 },
        { id: "safexbank", name: "SafexBank", eventCount: 0, uniqueUsers: 0 },
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
          `/insights?tenants=${tenants.join(',')}&range=${range}`,
          { timeout: 15000 }
        );
        
        const insights = response.data.insights ?? [];
        
        // Cache cleared on success
        delete aiInsightsErrorCache[cacheKey];
        
        return insights.map((insight: BackendInsight, ix: number) => ({
          id: `ai-${ix}`,
          type: insight.severity === 'high' ? 'warning' as const : insight.severity === 'medium' ? 'info' as const : 'success' as const,
          title: insight.type || 'Backend Insight',
          message: insight.message || String(insight),
          impact: insight.severity === 'high' ? 'High' : 'Medium',
          priority: insight.severity,
          confidence: normalizeConfidenceLabel(insight.confidence) || confidenceFromSeverity(insight.severity),
          actionRequired: insight.severity === 'high',
        }));
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

  /** Fetch real-time active user count (returns count + IST timestamp) */
  async getRealTimeUsers(tenants: string[]): Promise<{ count: number; timestampIST: string | null }> {
    try {
      const response = await apiClient.get<{ count: number; timestamp_ist: string | null; timezone: string }>(`/metrics/realtime_users?tenants=${tenants.join(',')}`);
      return {
        count: response.data.count ?? 0,
        timestampIST: response.data.timestamp_ist ?? null,
      };
    } catch {
      return { count: 0, timestampIST: null };
    }
  },

  /** Fetch pages per minute data */
  async getPagesPerMinute(tenants: string[]): Promise<PagesPerMinuteDataPoint[]> {
    try {
      const response = await apiClient.get<BackendPPMRow[]>(`/metrics/pages_per_minute?tenants=${tenants.join(',')}`);
      return response.data;
    } catch {
      return [];
    }
  },

  /** Fetch top pages data — returns page-grouped entries with nested features */
  async getTopPages(tenants: string[], range: string): Promise<TopPage[]> {
    try {
      const response = await apiClient.get<BackendTopPageRow[]>(`/metrics/top_pages?tenants=${tenants.join(',')}&range=${range}`);
      return response.data.map((row: BackendTopPageRow) => ({
        pageUrl: row.pageUrl,
        totalEvents: row.totalEvents,
        comparisonPct: row.comparisonPct ?? 0,
        rank: row.rank ?? 0,
        features: (row.features || []).map(f => ({
          feature: f.feature,
          displayName: f.displayName || f.feature,
          count: f.count,
          inPagePct: f.inPagePct ?? 0,
        })),
      }));
    } catch {
      return [];
    }
  },

  /** Fetch device breakdown data */
  async getDeviceBreakdown(tenants: string[], range: string): Promise<DeviceBreakdown[]> {
    try {
      const response = await apiClient.get<DeviceBreakdown[]>(`/metrics/devices?tenants=${tenants.join(',')}&range=${range}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch device breakdown', error);
      return [];
    }
  },

  /** Fetch user acquisition channel breakdown */
  async getAcquisitionChannels(tenants: string[], range: string): Promise<AcquisitionChannel[]> {
    try {
      const response = await apiClient.get<BackendChannelRow[]>(`/metrics/channels?tenants=${tenants.join(',')}&range=${range}`);
      return (response.data || []).map((row: BackendChannelRow) => ({
        name: row.name,
        value: row.value,
        formattedValue: row.formattedValue || row.value.toLocaleString(),
      }));
    } catch (error) {
      console.error('Failed to fetch acquisition channels', error);
      return [];
    }
  },

  /** Fetch top locations data from backend */
  async getLocations(tenants: string[], range: string): Promise<LocationData[]> {
    try {
      const response = await apiClient.get<LocationData[]>(`/locations?tenants=${tenants.join(',')}&range=${range}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch Locations', error);
      return [];
    }
  },

  /** Fetch audit logs from backend */
  async getAuditLogs(tenants: string[], range: string): Promise<AuditLog[]> {
    try {
      const response = await apiClient.get<AuditLog[]>(`/audit_logs?tenants=${tenants.join(',')}&range=${range}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch AuditLogs:', error instanceof Error ? error.message : String(error));
      return [];
    }
  },

  /** Fetch top feature configs using backend data */
  async getFeatureConfigs(tenants: string[], range: string): Promise<FeatureConfig[]> {
    try {
      const response = await apiClient.get<FeatureConfig[]>(`/features/configs?tenants=${tenants.join(',')}&range=${range}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch feature configs', error);
      return [];
    }
  },

  /** Fetch retention data */
  async getRetentionData(tenants: string[], range: string): Promise<RetentionData[]> {
    try {
      const response = await apiClient.get<RetentionData[]>(`/metrics/retention?tenants=${tenants.join(',')}&range=${range}`);
      return response.data;
    } catch {
      return [];
    }
  },

  /** ─────────────── Deployment & Admin APIs ─────────────── */

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

  /** Fetch transparency info showing what data goes to the cloud */
  async getTransparencyInfo(tenants: string[] | string): Promise<TransparencyResponse | null> {
    try {
      const tenantsStr = Array.isArray(tenants) ? tenants.join(',') : tenants;
      const response = await apiClient.get<TransparencyResponse>(`/transparency/cloud-data?tenants=${tenantsStr}`);
      return response.data;
    } catch (error) {
      console.warn('Failed to fetch transparency info', error);
      return null;
    }
  },

  /* ─────────────── Pro Users Metrics ─────────────── */

  async getProUsers(tenants: string[], range: string): Promise<{ pro_users: number; total_users: number; pro_adoption_pct: number }> {
    try {
      const response = await apiClient.get<{ pro_users: number; total_users: number; pro_adoption_pct: number }>(`/metrics/pro_users?tenants=${tenants.join(',')}&range=${range}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch pro users', error);
      return { pro_users: 0, total_users: 0, pro_adoption_pct: 0 };
    }
  },

  /* ─────────────── License vs Usage ─────────────── */

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

  async getTrackingToggles(
    tenants: string[],
    auth?: { role?: string; email?: string }
  ): Promise<TrackingToggleResponse> {
    try {
      const headers: Record<string, string> = {};
      if (auth?.role) headers['X-User-Role'] = auth.role;
      if (auth?.email) headers['X-User-Email'] = auth.email;
      const response = await apiClient.get<TrackingToggleResponse>(`/tracking/toggles?tenants=${tenants.join(',')}`, {
        headers,
      });
      return response.data;
    } catch (error) {
      console.warn('Failed to fetch tracking toggles', error);
      return { toggles: [] };
    }
  },

  async setTrackingToggle(
    tenants: string[],
    featureName: string,
    isEnabled: boolean,
    actorEmail: string,
    auth?: { role?: string; email?: string }
  ): Promise<{ status: string; feature_name?: string; is_enabled?: boolean; changed_by?: string; changed_at?: string }> {
    try {
      const headers: Record<string, string> = {};
      if (auth?.role) headers['X-User-Role'] = auth.role;
      if (auth?.email) headers['X-User-Email'] = auth.email;
      const tenantParam = encodeURIComponent(tenants.join(','));
      const response = await apiClient.post<{ status: string; feature_name?: string; is_enabled?: boolean; changed_by?: string; changed_at?: string }>(`/tracking/toggles?tenants=${tenantParam}`, {
        tenant_id: tenants.join(','),
        feature_name: featureName,
        is_enabled: isEnabled,
        actor_email: actorEmail,
      }, {
        headers,
      });
      return response.data;
    } catch (error) {
      console.error('Failed to set tracking toggle', error);
      return { status: 'error' };
    }
  },

  /* ─────────────── User Journey ─────────────── */

  async getUserJourney(tenants: string[], userId: string, range: string): Promise<UserJourneyResponse> {
    try {
      const response = await apiClient.get<UserJourneyResponse>(`/journey/user?tenants=${encodeURIComponent(tenants.join(','))}&user_id=${encodeURIComponent(userId)}&range=${range}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch user journey', error);
      return { tenant_id: '', user_id: userId, total_events: 0, total_sessions: 0, events: [], sessions: [], last_event: null };
    }
  },

  async getJourneyUsers(tenants: string[], range: string): Promise<JourneyUsersResponse> {
    try {
      const response = await apiClient.get<JourneyUsersResponse>(`/journey/users?tenants=${encodeURIComponent(tenants.join(','))}&range=${range}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch journey users', error);
      return { users: [] };
    }
  },

  /* ─────────────── Segmentation ─────────────── */

  async getSegmentationComparison(tenants: string[]): Promise<SegmentationResponse> {
    try {
      const response = await apiClient.get<SegmentationResponse>(`/segmentation/compare?tenants=${tenants.join(',')}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch segmentation', error);
      return { segments: [] };
    }
  },

  /* ─────────────── Predictive Adoption ─────────────── */

  async getPredictiveAdoption(tenants: string[], range: string): Promise<PredictiveResponse> {
    try {
      const response = await apiClient.get<PredictiveResponse>(`/predictive/adoption?tenants=${tenants.join(',')}&range=${range}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch predictive adoption', error);
      return { predictions: [], total_users: 0 };
    }
  },

  /* ─────────────── Tenant Comparison ─────────────── */

  async getTenantComparison(tenants: string[], range: string): Promise<{ tenants: Array<{ id: string; name: string; total_events: number; unique_users: number; active_features: number; growth_rate: number; conversion_rate: number; trend: Array<{ date: string; events: number }> }> }> {
    try {
      const response = await apiClient.get(`/tenants/compare?tenants=${tenants.join(',')}&range=${range}`);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch tenant comparison', error);
      return { tenants: [] };
    }
  },
};

export default apiClient;
