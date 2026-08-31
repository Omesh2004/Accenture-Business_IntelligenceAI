/**
 * Core type definitions for the analytics dashboard.
 * All data models, component props, and API response types are defined here
 * to enforce strict typing across the application.
 * No `any` types, strict TypeScript throughout.
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
 * (single tenant).
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

/** Provenance of one metadata dimension: measured by a client, or invented by a producer. */
export interface DimensionProvenance {
  simulated_events: number;
  total_events: number;
  simulated_pct: number;
  /** True when ANY event declared this key fabricated. A partly-invented dimension cannot
   *  carry a contribution share honestly, so there is no threshold below which it is fine. */
  simulated: boolean;
}

/** Response of GET /metrics/dimension_provenance, keyed by metadata dimension. */
export interface DimensionProvenanceResponse {
  tenant_id: string;
  time_range: string;
  total_events: number;
  dimensions: Record<string, DimensionProvenance>;
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

/* ─────────────── Intelligence Layer ─────────────── */

export interface EvidenceClaim {
  claim_id: string;
  label: string;
  source: string;
  unit: string;
  value: number;
}

export interface TrustCheck {
  check_id: string;
  verdict: 'pass' | 'fail' | 'ambiguous';
  fingerprint: string;
  cheapest_check: string;
  blocks_narrative: number;
  observed: Record<string, number>;
}

export interface RootCause {
  rank: number;
  dimensions: Record<string, string>;
  fundamental: string;
  contribution: number;
  explained_pct: number;
  method: string;
}

/** A root cause tagged with which factor of the identity moved (price / volume / mix). */
export interface FactorContribution extends RootCause {
  factor: string;
}

export interface EngineBreakdown {
  by_engine: Record<string, { runs: number; latency_ms: number; tokens: number }>;
  total_runs: number;
  llm_runs: number;
  non_llm_runs: number;
  llm_share_pct: number;
}

export interface SourceHealth {
  source_id: string;
  grain: string;
  cadence: string;
  sla_minutes: number;
  last_loaded_at: string;
  max_source_ts: string;
  rows_loaded: number;
  load_status: string;
  minutes_behind: number | null;
  within_sla: boolean;
}

export interface IntelligenceInsight {
  insight_id: string;
  investigation_id: string;
  tenant_id: string;
  kpi_id: string;
  anomaly_id: string;
  persona: string;
  generated_at: string;
  trust_verdict: 'pass' | 'fail' | 'ambiguous';
  headline: string;
  narrative: string;
  evidence: EvidenceClaim[];
  llm_breakdown: Record<string, number>;
  confidence: number;
  simulated: number;
  abstained: number;
  verifier_pass: number;
  engine_breakdown: EngineBreakdown;
  trust: { checks: TrustCheck[]; passed: number; failed: number; ambiguous: number };
  causes: RootCause[];
  factors: FactorContribution[];
  sources: SourceHealth[];
}

export interface TelemetryStage {
  stage: string;
  engine_type: string;
  runs: number;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

export interface RuntimeTelemetry {
  by_stage: TelemetryStage[];
  total_runs: number;
  llm_runs: number;
  non_llm_runs: number;
  llm_share_pct: number;
  total_latency_ms: number;
  total_tokens: number;
  total_cost_usd: number;
}

export interface IntelligenceRecommendation {
  rec_id: string;
  anomaly_id: string;
  action: string;
  lever: string;
  owner_role: string;
  expected_impact: { low: number; high: number };
  status: string;
}

/** Answer from the persona query agent. Every figure traces to a Signal Store row. */
/** One step of the agent loop: reason, act, observe, validate or synthesize. */
export interface AgentStep {
  n: number;
  label: string;
  tool: string;
  detail: string;
  status: 'ok' | 'skipped' | 'abstained' | 'failed';
  ms: number;
  kind: 'reason' | 'act' | 'observe' | 'validate' | 'synthesize';
  /** Pipeline gate this step answered for; empty for infrastructure steps. */
  gate: string;
  /** The numbers this step read, each carrying the table it came from. */
  evidence: EvidenceClaim[];
  citation: string;
  why: string;
}

/** One stage of the pipeline, with what it decided on this run, or why it did not run. */
export interface AgentGate {
  id: string;
  label: string;
  question: string;
  engine: string;
  status: 'idle' | 'engaged' | 'skipped' | 'failed' | 'restricted';
  detail: string;
  tools: string[];
  claims: number;
}

/** Where a figure came from: the capability that produced it and the table it read. */
export interface AgentCitation {
  tool: string;
  source: string;
}

export interface AgentAnswer {
  question: string;
  persona: string;
  persona_label: string;
  intent: string;
  intents: string[];
  kpi_id: string;
  answer: string;
  evidence: EvidenceClaim[];
  abstained: number;
  reason: string;
  verifier_pass: number;
  engine_type: string;
  investigation_id: string;
  sources: SourceHealth[];
  query_id: string;
  trace: AgentStep[];
  suggestions: string[];
  citations: AgentCitation[];
  tools_used: string[];
  issues: string[];
  escalate: number;
  rounds: number;
  /** One block per capability that contributed, so a reader can see which question each part
   *  of the answer belongs to. `answer` remains the same text, flattened. */
  sections: AgentSection[];
  confidence: number;
  uncertainty: string[];
  /** Every pipeline gate with its outcome, including the ones that did not run and why. */
  rail: AgentGate[];
  /** Charts built from the observations the agent already read, never from a second query. */
  visuals: AgentVisual[];
  /** The result sets behind the narrative, the rows the prose is speaking from. */
  datasets: AgentDataset[];
}

/** A metric's real daily path, read through the Metric Layer. */
export interface KpiSeries {
  kpi_id: string;
  name: string;
  /** 'ratio' when the rate itself was charted; 'count' when it fell back to the numerator. */
  unit: 'ratio' | 'count';
  measure: string;
  points: { date: string; value: number }[];
  days: number;
  source: string;
  /** The stored band. Flat by construction, one row, no per-day path. */
  forecast?: {
    point: number;
    lower: number;
    upper: number;
    method: string;
    horizon_days: number;
    flat: boolean;
  };
  /** Set instead of `forecast` when the stored band is not on this series' scale. */
  forecast_withheld?: string;
  detail?: string;
}

/** One result set, as the workspace displays it. */
export interface AgentDataset {
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
  source: string;
  tool: string;
}

/** A chart the run can honestly draw. `source` is the table its numbers were read from. */
export interface AgentVisual {
  kind: 'bars' | 'delta';
  title: string;
  subtitle: string;
  unit: string;
  series: { label: string; value: number; severity?: string }[];
  pct_change?: number;
  source: string;
  gate: string;
  tool: string;
}

/** A labelled part of an answer, named after the intent the capability behind it serves. */
export interface AgentSection {
  label: string;
  text: string;
  tool: string;
  source: string;
  /** 'findings' renders as a bulleted list; 'prose' renders as a paragraph. A greeting split into
   *  five bullets under a heading reads as five findings, which is what it looked like. */
  kind?: 'findings' | 'prose';
  slot?: string;
}

/** A persona view the signed-in role may switch to. The list is server-authored. */
export interface PersonaOption {
  id: string;
  label: string;
  remit: string;
  intents: string[];
  examples: string[];
}

export interface PersonaChoices {
  resolved: string;
  personas: PersonaOption[];
}
