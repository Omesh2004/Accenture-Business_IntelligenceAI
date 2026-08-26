/**
 * Core type definitions for the analytics dashboard.
 * All data models, component props, and API response types are defined here
 * to enforce strict typing across the application.
 * No `any` types — strict TypeScript throughout.
 */

/* ─────────────── Data Models ─────────────── */

/** Represents a single analytics event tracked in the system */
export interface AnalyticsEvent {
  id: string;
  feature: string;
  usage: number;
  timestamp: string;
  tenantId: string;
  category: 'interaction' | 'navigation' | 'transaction' | 'system';
}

/** Represents a feature in the product being tracked */
export interface Feature {
  id: string;
  name: string;
  totalUsage: number;
  trend: number; // percentage change
  category: string;
}

/** Represents a tenant (customer organization) in the SaaS platform */
export interface Tenant {
  id: string;
  name: string;
  featureUsage: number;
  errors: number;
  adoptionRate: number;
  plan: 'free' | 'pro' | 'enterprise';
}

/** Represents an available tenant from the dynamic catalog */
export interface AvailableTenant {
  id: string;
  name: string;
  eventCount: number;
  uniqueUsers: number;
}

/* ─────────────── KPI Types ─────────────── */

/** Key performance indicator card data */
export interface KPIMetric {
  id: string;
  label: string;
  value: string;
  change: number; // percentage change from previous period
  changeDirection: 'up' | 'down';
  icon: string;
  /**
   * True when any part of this figure is modelled rather than measured. Response time, geo
   * and device are synthesised in the forwarding layer, and there is no money field anywhere
   * in events_raw. CLAUDE.md requires such figures to be labelled in the UI, never shown bare.
   */
  simulated?: boolean;
  /** Human-readable reason shown alongside the simulated badge. */
  simulatedNote?: string;
}

/* ─────────────── Chart Data Types ─────────────── */

/**
 * Data point for time-series line/area charts.
 * Supports both single-tenant (visitors, pageViews)
 * and multi-tenant pivoted keys (nexabank_visitors, safexbank_pageViews, …).
 */
export type TimeSeriesDataPoint = {
  date: string;
} & Record<string, string | number>;

/**
 * Data point for feature usage line chart.
 * Supports both single-tenant (usage) and multi-tenant pivoted keys.
 */
export type FeatureUsageDataPoint = {
  date: string;
} & Record<string, string | number>;

/** Data point for horizontal bar charts (top features, acquisition, etc.) */
export interface BarDataPoint {
  name: string;
  value: number;
  color?: string;
}

/** Data point for the pages-per-minute bar chart */
export interface PagesPerMinuteDataPoint {
  hour: string;
  value: number;
}

/** Funnel step in user journey */
export interface FunnelStep {
  label: string;
  value: number;
  dropOff: number; // percentage drop from previous step
  color: string;
}

/** Heatmap cell data */
export interface HeatmapCell {
  feature: string;
  day: string;
  intensity: number; // 0-100 scale
}

/** Feature activity heatmap row */
export interface FeatureActivityRow {
  feature: string;
  segments: { color: string; width: number }[];
  level: 'High' | 'Med' | 'Low';
}

/** User acquisition channel data for horizontal bar chart */
export interface AcquisitionChannel {
  name: string;
  value: number;
  formattedValue: string;
}

/** Device breakdown data for donut/pie chart */
export interface DeviceBreakdown {
  name: string;
  value: number;
  color: string;
}

/** A single feature event grouped under a page */
export interface PageFeature {
  feature: string;
  /** Human-readable display name e.g. "Payee Added" */
  displayName: string;
  count: number;
  /** % of this feature's events within its parent page (0–100) */
  inPagePct: number;
}

/** A page entry in the Top Pages widget */
export interface TopPage {
  /** URL path, e.g. "/dashboard" */
  pageUrl: string;
  /** Total events across all features on this page */
  totalEvents: number;
  /** Features that fired on this page */
  features: PageFeature[];
  /** % share of this page vs all pages combined (0–100) */
  comparisonPct: number;
  /** Rank position (1 = most popular) */
  rank: number;
}

/** Location data for geography section */
export interface LocationData {
  country: string;
  visits: number;
}

/* ─────────────── AI Insights ─────────────── */

/** AI-generated insight */
export interface AIInsight {
  id: string;
  title: string;
  message: string;
  type: 'warning' | 'info' | 'success';
  priority: 'high' | 'medium' | 'low';
  confidence?: 'High' | 'Medium' | 'Low';
  impact?: string;
  actionRequired?: boolean;
}

/* ─────────────── Configuration & Governance ─────────────── */

/** Audit Log Entry */
export interface AuditLog {
  id: string;
  user: string;
  action: string;
  resource: string;
  timestamp: string;
  details: string;
}

/** Feature Route Mapping */
export interface FeatureConfig {
  id: string;
  pattern: string;
  featureName: string;
  category: string;
  isActive: boolean;
}

/** Retention & Cohort Data */
export interface RetentionData {
  cohort: string;
  users: number;
  month1: number;
  month2: number;
  month3: number;
}

/* ─────────────── Dashboard State ─────────────── */

/** Time range filter options */
export type TimeRange = 'Last 7 Days' | 'Last 30 Days' | 'Last 90 Days';

/** Deployment mode toggle */
export type DeploymentMode = 'cloud' | 'on-prem';

/** Sidebar navigation items */
export interface NavItem {
  id: string;
  label: string;
  icon: string;
  href: string;
  active?: boolean;
}

export interface DashboardState {
  timeRange: TimeRange;
  selectedTenants: string[];
  deploymentMode: DeploymentMode;
  sidebarCollapsed: boolean;
  kpiMetrics: KPIMetric[];
  realTimeUsers: number;
  realTimeUsersTimestampIST: string | null;
}

/* ─────────────── License vs Usage ─────────────── */

export interface LicenseFeature {
  feature_name: string;
  plan_tier: string;
  is_used: boolean;
  usage_count: number;
  unique_users: number;
}

export interface LicenseUsageResponse {
  tenant_id: string;
  summary: {
    total_licensed: number;
    total_used: number;
    total_used_licensed: number;
    waste_pct: number;
  };
  licensed: LicenseFeature[];
  unused_licensed: LicenseFeature[];
  unlicensed_used: { feature_name: string; usage_count: number }[];
}

/* ─────────────── Tracking Toggle ─────────────── */

export interface TrackingToggle {
  feature_name: string;
  is_enabled: boolean;
  changed_by: string;
  changed_at: string;
}

/* ─────────────── Config Audit Log ─────────────── */

export interface ConfigAuditEntry {
  actor: string;
  action: string;
  target: string;
  old_value: string;
  new_value: string;
  timestamp: string;
}

/* ─────────────── User Journey ─────────────── */

export interface JourneyEvent {
  event_name: string;
  channel: string;
  timestamp: string;
  metadata: string;
}

export interface UserJourneyResponse {
  tenant_id: string;
  user_id: string;
  total_events: number;
  total_sessions: number;
  events: JourneyEvent[];
  sessions: JourneyEvent[][];
  last_event: string | null;
}

export interface JourneyUser {
  user_id: string;
  event_count: number;
  first_seen: string;
  last_seen: string;
}

/* ─────────────── Predictive Adoption ─────────────── */

export interface PredictiveFeature {
  feature_name: string;
  score: number;
  trend_score: number;
  users_pct: number;
  frequency_score: number;
  recent_7d: number;
  prev_7d: number;
  status: 'High Adoption' | 'Growing' | 'At Risk';
}

/* ─────────────── Segmentation ─────────────── */

export interface SegmentData {
  tier: string;
  features: number;
  total_usage: number;
  unique_users: number;
}
