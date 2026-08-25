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

/* ═══════════════════════════════════════════════════════════════════════════
   Intelligence Layer — Types for the 9-stage reasoning pipeline
   ═══════════════════════════════════════════════════════════════════════════ */

/* ─────────────── Trust Gate (Stage 0) ─────────────── */

/** The three visual states a Trust Badge can render */
export type TrustBadgeStatus = 'pass' | 'flagged' | 'quarantined';

/** Types of checks the Trust Gate performs */
export type TrustCheckType =
  | 'schema'
  | 'distribution'
  | 'hard_invariant'
  | 'soft_invariant'
  | 'reconciliation'
  | 'upstream_corroboration'
  | 'coincident_change'
  | 'freshness'
  | 'range'
  | 'readiness';

/** Trust Gate verdict for a single metric/window */
export interface TrustVerdict {
  id: string;
  tenant_id: string;
  metric_id: string;
  window_start: string;
  window_end: string;
  verdict: 'pass' | 'flag' | 'halt';
  failing_check: TrustCheckType | null;
  failing_detail: string | null;
  quarantined: boolean;
  quarantined_since: string | null;
  checked_at: string;
}

/* ─────────────── Detect (Stage 1) ─────────────── */

/** Anomaly status lifecycle */
export type AnomalyStatus = 'fired' | 'suppressed' | 'provisional';

/** Anomaly deviation type */
export type DeviationType = 'spike' | 'dip' | 'level_shift' | 'trend_change';

/** Output of the Detect stage — a single detected anomaly */
export interface Anomaly {
  id: string;
  tenant_id: string;
  metric_id: string;
  metric_label: string;
  window_start: string;
  window_end: string;
  deviation_type: DeviationType;
  z_score: number;
  effect_size: number;
  persistence_count: number;
  status: AnomalyStatus;
  detected_at: string;
  /** Trust verdict for this metric at time of detection */
  trust_status?: TrustBadgeStatus;
}

/* ─────────────── Localize (Stage 2) ─────────────── */

/** Method used by the Localize stage */
export type LocalizeMethod = 'psqueeze' | 'squeeze' | 'hotspot' | 'greedy_topdown';

/** A single dimension candidate from the Localize stage */
export interface RootCauseCandidate {
  dimensions: Record<string, string>;  // e.g. { region: "US", device: "mobile" }
  contribution_share: number;          // 0–1, should sum to ~1 across candidates
  method: LocalizeMethod;
}

/** Root cause output for an anomaly */
export interface RootCause {
  anomaly_id: string;
  fundamental: string;                 // "numerator" | "denominator" | metric name
  candidates: RootCauseCandidate[];
  contributions_sum: number;           // validation: should be ~1.0
  created_at: string;
}

/* ─────────────── Forecast (Stage 3) ─────────────── */

/** A single forecast data point for charting */
export interface ForecastPoint {
  date: string;
  actual?: number;
  forecast: number;
  lo: number;
  hi: number;
}

/** Forecast stage output for a single metric */
export interface Forecast {
  metric_id: string;
  metric_label: string;
  tenant_id: string;
  horizon: string;               // e.g. "7d", "30d"
  points: ForecastPoint[];       // time series with intervals
  mase: number | null;           // backtest score vs seasonal-naive
  crps: number | null;           // continuous ranked probability score
  beat_naive: boolean;           // false = fell back to classical model
  model_used: string;            // e.g. "chronos-2", "seasonal_naive"
  fallback_reason?: string;      // why classical model was used
  created_at: string;
}

/* ─────────────── Causal Impact (Stage 4) ─────────────── */

/** The causal inference rung — level of evidence */
export type CausalRung =
  | 'association'
  | 'attribution'
  | 'corroborated_cause'
  | 'estimated_effect';

/** A single point in the observed/counterfactual time series */
export interface CausalTimePoint {
  date: string;
  observed: number;
  counterfactual: number;
  counterfactual_lo?: number;
  counterfactual_hi?: number;
}

/** Causal Impact stage output */
export interface CausalImpactResult {
  id: string;
  tenant_id: string;
  intervention_id: string;
  intervention_label: string;
  intervention_start: string;
  intervention_end: string;
  affected_segment: string;
  metric_id: string;
  metric_label: string;
  time_series: CausalTimePoint[];
  lift: number;
  lift_pct: number;
  credible_interval_lo: number;
  credible_interval_hi: number;
  rung_label: CausalRung;
  degraded: boolean;
  degraded_reason?: string;
  created_at: string;
}

/* ─────────────── Decide (Stage 5) ─────────────── */

/** Recommendation category */
export type RecommendationCategory = 'business' | 'engineering';

/** Recommendation lifecycle status */
export type RecommendationStatus = 'proposed' | 'approved' | 'rejected' | 'executed';

/** Output of the Decide stage — a single recommendation */
export interface Recommendation {
  id: string;
  tenant_id: string;
  anomaly_id: string | null;
  context: string;
  action: string;
  category: RecommendationCategory;
  predicted_uplift: number;
  predicted_uplift_lo: number;
  predicted_uplift_hi: number;
  cost: number | null;
  rank: number;
  status: RecommendationStatus;
  owner_role: string;
  approved_by?: string;
  approved_at?: string;
  rejection_reason?: string;
  created_at: string;
}

/** Payload for approving or rejecting a recommendation */
export interface RecommendationAction {
  action: 'approve' | 'reject';
  comment: string;
}

/* ─────────────── Narrate (Stage 6) ─────────────── */

/** A single verified figure within a narrative */
export interface NarrativeFigure {
  value: string;
  label: string;
  signal_store_ref: string;     // FK to signal store row
  signal_store_table: string;   // "anomalies" | "forecasts" | "root_causes" etc.
  verified: boolean;
  qualifier?: string;           // e.g. "simulated", narrative_qualifier from contract
}

/** Evidence item linked to the narrative */
export interface NarrativeEvidence {
  stage: string;                // "detect" | "localize" | "forecast" etc.
  record_id: string;
  summary: string;
}

/** Structured, verified narrative output */
export interface StructuredNarrative {
  report_id: string;
  tenant_id: string;
  persona: string;              // "cfo" | "ops_manager"
  narrative: string;            // The rendered text
  figures: NarrativeFigure[];   // Every number in the narrative
  evidence: NarrativeEvidence[];
  trust_verdict: TrustBadgeStatus;
  confidence: number;           // 0–1
  degraded_mode: boolean;       // true = using template fallback
  simulated: boolean;
  abstained: boolean;
  verifier_pass: boolean;
  created_at: string;
}

/* ─────────────── Observe (Stage 7) — Closed Loop ─────────────── */

/** Outcome of an executed recommendation */
export interface Outcome {
  id: string;
  recommendation_id: string;
  realized_effect: number;
  predicted_effect: number;
  matched_prediction: boolean;
  measured_at: string;
}

/* ─────────────── Model Observability ─────────────── */

/** Engine type tag for every computation */
export type EngineType = 'sql' | 'stats' | 'ml' | 'rule' | 'llm';

/** Pipeline stage identifier */
export type PipelineStage =
  | 'trust_gate'
  | 'detect'
  | 'localize'
  | 'forecast'
  | 'causal'
  | 'decide'
  | 'narrate'
  | 'observe';

/** Single model/specialist run audit row */
export interface ModelRun {
  id: string;
  stage: PipelineStage;
  engine_type: EngineType;
  model: string;
  inputs_hash: string;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number;
  cost_est_usd: number | null;
  verifier_pass: boolean | null;
  tenant_id: string;
  created_at: string;
}

/** Golden set evaluation result */
export interface GoldenSetResult {
  scenario_id: string;
  scenario_label: string;
  detection_fpr: number | null;
  localization_hit_rate_at_1: number | null;
  forecast_mase: number | null;
  entitlement_leaks: number;
  unverified_numbers: number;
  passed: boolean;
  evaluated_at: string;
}

/** Rollout maturity per capability */
export type RolloutStage = 'shadow' | 'assist' | 'approve' | 'autonomous';

export interface RolloutLadderStatus {
  capability: PipelineStage;
  capability_label: string;
  stage: RolloutStage;
  updated_at: string;
}

/** Per-stage health metric for the observability dashboard */
export interface StageHealthMetric {
  stage: PipelineStage;
  stage_label: string;
  metric_name: string;          // e.g. "false_positive_rate", "hit_rate_at_k"
  metric_label: string;
  value: number;
  pass_bar: number;
  passing: boolean;
  measured_at: string;
}
