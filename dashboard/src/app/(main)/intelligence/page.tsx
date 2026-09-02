'use client';

/**
 * Intelligence report, the read surface of the agentic investigation pipeline.
 *
 * Rebuilt around one decision: this page is a REPORT, not a monitoring surface. Everywhere else in
 * the dashboard, panels display state and the reader draws the conclusion. Here the system draws
 * the conclusion, so the page has to carry the weight of a claim, an editorial hero, one metric's
 * real path, and the attribution behind it, and it has to keep the audit within reach without
 * letting audit furniture outrank the finding.
 *
 * WHAT MOVED, AND WHY:
 *
 *   * A page-scoped ink/indigo palette (components/intel/theme.ts). The dashboard's blue means
 *     "a chart"; here a single warm accent is reserved for movement, so colour carries meaning
 *     rather than decoration.
 *   * The metric's REAL 30-day path from /intelligence/series, read through the Metric Layer -
 *     the same code that produced the narrative's numbers, so the line and the sentence cannot
 *     disagree. Nothing else on this page showed the shape of a movement.
 *   * Assurance, Recommended actions and Provenance moved into one "Audit trail" disclosure.
 *     They are evidence for a reader who is checking the finding, not the finding itself, and as
 *     four equal-weight stacked sections they buried it. Folded, not deleted: every figure they
 *     carry is still one click away.
 */

import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, FileSearch } from 'lucide-react';
import { dashboardAPI } from '@/lib/api';
import { useDashboardData } from '@/hooks/useDashboard';
import IntelligenceEvidence from '@/components/IntelligenceEvidence';
import SourceHealthPanel from '@/components/SourceHealthPanel';
import IntelligenceAsk from '@/components/IntelligenceAsk';
import { BarGauge, Panel, SourceChip, TimeSeriesPanel } from '@/components/intel/panels';
import { EASE, FONT, INK, RANK_SCALE, compact, step } from '@/components/intel/theme';
import { ChartSkeleton } from '@/components/Skeletons';

const VERDICT_TONE: Record<string, { fg: string; bg: string }> = {
  pass: { fg: INK.positive, bg: INK.positiveSoft },
  fail: { fg: INK.danger, bg: INK.dangerSoft },
  ambiguous: { fg: INK.caution, bg: INK.cautionSoft },
};

const FACTOR_HINT: Record<string, string> = {
  price: 'Average value per unit',
  volume: 'Number of units transacted',
  mix: 'Shift in segment weighting',
  entry_exit: 'Segments present in only one period',
};

function titleCase(id: string) {
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="text-[10.5px] tracking-[0.22em] uppercase"
      style={{ color: INK.textFaint, fontFamily: FONT.sans }}
    >
      {children}
    </p>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="max-w-3xl">
      <h2 className="text-[24px] leading-tight" style={{ color: INK.text, fontFamily: FONT.display }}>
        {title}
      </h2>
      <p className="mt-1.5 text-[13.5px] leading-[1.65]" style={{ color: INK.textSoft }}>
        {description}
      </p>
    </div>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: { fg: string; bg: string } }) {
  return (
    <span
      className="rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-[0.14em] uppercase"
      style={{
        color: tone?.fg || INK.textSoft,
        background: tone?.bg || INK.sunken,
        border: `1px solid ${tone ? 'transparent' : INK.hairline}`,
      }}
    >
      {children}
    </span>
  );
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border ${className}`}
      style={{ borderColor: INK.hairline, background: INK.surface }}
    >
      {children}
    </div>
  );
}

/** A ranked contribution row. One shared component so segments and factors read identically. */
function ContributionRow({
  label,
  sub,
  value,
  index,
}: {
  label: string;
  sub: string;
  value: number;
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: step(index, 70), duration: 0.4, ease: EASE }}
      className="py-3"
      style={{ borderTop: index === 0 ? 'none' : `1px solid ${INK.hairline}` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-medium" style={{ color: INK.text }}>
            {label}
          </p>
          <p
            className="mt-0.5 text-[10.5px] tracking-[0.14em] uppercase"
            style={{ color: INK.textFaint }}
          >
            {sub}
          </p>
        </div>
        <span
          className="shrink-0 text-[17px]"
          style={{ color: INK.text, fontFamily: FONT.mono, fontVariantNumeric: 'tabular-nums' }}
        >
          {(value * 100).toFixed(1)}%
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: INK.sunken }}>
        <motion.div
          className="h-full rounded-full"
          style={{ background: RANK_SCALE[index % RANK_SCALE.length] }}
          initial={{ width: 0 }}
          animate={{ width: `${Math.min(Math.abs(value) * 100, 100)}%` }}
          transition={{ delay: step(index, 70) + 0.1, duration: 0.7, ease: EASE }}
        />
      </div>
    </motion.div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="rounded-xl border border-dashed px-4 py-8 text-center text-[13px]"
      style={{ borderColor: INK.hairline, color: INK.textFaint }}
    >
      {children}
    </p>
  );
}

export default function IntelligencePage() {
  const { tenantsParam, timeRange } = useDashboardData();
  // The header range is the agent's default period, until a question names its own.
  const rangeDays = Number(String(timeRange).replace(/[^0-9]/g, '')) || 7;
  // Empty means "whatever the server resolves from my role"; a switch only ever narrows.
  const [persona, setPersona] = useState('');
  const [auditOpen, setAuditOpen] = useState(false);

  const { data: insight, isLoading } = useQuery({
    queryKey: ['intelligenceInsight', tenantsParam, persona],
    queryFn: () => dashboardAPI.getIntelligenceInsight(tenantsParam, undefined, persona || undefined),
    staleTime: 30 * 1000,
    retry: 1,
  });

  // The metric's real daily path. Keyed on the KPI so switching personas -- which can change which
  // metric is on screen -- refetches rather than showing the previous metric's line.
  const { data: series } = useQuery({
    queryKey: ['intelligenceSeries', tenantsParam, insight?.kpi_id],
    queryFn: () => dashboardAPI.getKpiSeries(tenantsParam, insight!.kpi_id, 30),
    enabled: Boolean(insight?.kpi_id),
    staleTime: 60 * 1000,
    retry: 1,
  });

  const { data: sources = [] } = useQuery({
    queryKey: ['intelligenceSources', tenantsParam],
    queryFn: () => dashboardAPI.getIntelligenceSources(tenantsParam),
    staleTime: 60 * 1000,
    retry: 1,
  });

  const { data: telemetry } = useQuery({
    queryKey: ['intelligenceTelemetry', tenantsParam],
    queryFn: () => dashboardAPI.getIntelligenceTelemetry(tenantsParam),
    staleTime: 60 * 1000,
    retry: 1,
  });

  const { data: recommendations = [] } = useQuery({
    queryKey: ['intelligenceRecommendations', tenantsParam],
    queryFn: () => dashboardAPI.getIntelligenceRecommendations(tenantsParam),
    staleTime: 60 * 1000,
    retry: 1,
  });

  // Same key as the ask panel, so this shares one fetch. The label belongs to the registry, not
  // to a title-cased id -- "Ops Manager" in the header beside "Operations Manager" in the panel
  // is the page disagreeing with itself.
  const { data: personaChoices } = useQuery({
    queryKey: ['intelligencePersonas', tenantsParam],
    queryFn: () => dashboardAPI.getIntelligencePersonas(tenantsParam),
    staleTime: 5 * 60 * 1000,
    retry: 3,
  });

  // Only recommendations for the anomaly on screen; the endpoint returns them tenant-wide.
  const relevantRecs = useMemo(
    () => recommendations.filter((r) => !insight?.anomaly_id || r.anomaly_id === insight.anomaly_id),
    [recommendations, insight?.anomaly_id],
  );

  if (isLoading) {
    return (
      <div className="space-y-8">
        <ChartSkeleton />
        <ChartSkeleton />
      </div>
    );
  }

  if (!insight) {
    return (
      <div className="space-y-8" style={{ background: INK.canvas }}>
        <motion.section {...{ initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 } }}>
          <Card className="p-7">
            <Eyebrow>Decision intelligence</Eyebrow>
            <h1
              className="mt-2 text-[34px] leading-tight"
              style={{ color: INK.text, fontFamily: FONT.display }}
            >
              Investigation Report
            </h1>
            <p className="mt-3 max-w-3xl text-[14px] leading-[1.7]" style={{ color: INK.textSoft }}>
              An investigation is opened only when a governed KPI moves beyond its forecast band. No
              such movement has been recorded for the selected portfolio, which is itself a finding:
              the monitored metrics are operating within expectation.
            </p>
          </Card>
        </motion.section>
        <IntelligenceAsk tenants={tenantsParam} persona={persona} onPersonaChange={setPersona}
                         days={rangeDays} />
      </div>
    );
  }

  const movementLabel = insight.anomaly_id ? 'Material movement detected' : 'Within expectation';
  const personaLabel =
    personaChoices?.personas.find((p) => p.id === insight.persona)?.label ||
    titleCase(insight.persona);

  return (
    <div className="space-y-10 pb-4" style={{ background: INK.canvas }}>
      {/* ── Executive summary ─────────────────────────────────────────────────────────── */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE }}
      >
        <Card className="overflow-hidden">
          <div className="flex flex-col gap-7 p-7 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <Eyebrow>Decision intelligence · {personaLabel} view</Eyebrow>
              <h1
                className="mt-3"
                style={{ color: INK.text, fontFamily: FONT.display,
                         fontSize: 'var(--step-3)', fontWeight: 700,
                         letterSpacing: '-0.026em', lineHeight: 1.14 }}
              >
                {insight.headline}
              </h1>
              {/* The narrative is the one passage on this page a reader reads rather than scans,
                  so it takes the serif and a size that invites reading. */}
              <p className="mt-4 max-w-[62ch]"
                 style={{ color: INK.textSoft, fontFamily: FONT.prose,
                          fontSize: 'var(--step-0)', lineHeight: 1.62 }}>
                {insight.narrative}
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <Pill>{(insight.kpi_id || 'metric').replace(/_/g, ' ')}</Pill>
                <Pill tone={VERDICT_TONE[insight.trust_verdict] || VERDICT_TONE.ambiguous}>
                  Trust {insight.trust_verdict}
                </Pill>
                <Pill
                  tone={
                    insight.anomaly_id ? { fg: INK.signal, bg: INK.signalSoft } : undefined
                  }
                >
                  {movementLabel}
                </Pill>
                {insight.simulated === 1 && (
                  <Pill tone={{ fg: INK.caution, bg: INK.cautionSoft }}>Modelled metric</Pill>
                )}
                {insight.abstained === 1 && <Pill>Abstained</Pill>}
              </div>
            </div>

            <div className="grid shrink-0 grid-cols-2 gap-3 lg:w-64 lg:grid-cols-1">
              <div
                className="rounded-2xl p-4"
                style={{ background: INK.sunken, border: `1px solid ${INK.hairline}` }}
              >
                <Eyebrow>Confidence</Eyebrow>
                <p
                  className="mt-2 text-[30px] leading-none"
                  style={{ color: INK.text, fontFamily: FONT.mono, fontVariantNumeric: 'tabular-nums' }}
                >
                  {(insight.confidence * 100).toFixed(0)}%
                </p>
                <div
                  className="mt-3 h-1.5 overflow-hidden rounded-full"
                  style={{ background: INK.hairline }}
                >
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: INK.accent }}
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.min(insight.confidence * 100, 100)}%` }}
                    transition={{ duration: 0.85, ease: EASE, delay: 0.25 }}
                  />
                </div>
              </div>
              <div
                className="rounded-2xl p-4"
                style={{ background: INK.surface, border: `1px solid ${INK.hairline}` }}
              >
                {/* `generated_at` is pinned to the END OF THE SCORED WINDOW, not to the moment
                    the sweep ran -- that is deliberate, so every finding in one sweep shares a
                    timestamp and ordering is reproducible. Rendered with a clock it therefore
                    read "12:00:00 AM" every single time, which looks like a broken date and is
                    really a window boundary. Shown as the date it is. */}
                <Eyebrow>Covers up to</Eyebrow>
                <p className="mt-2 text-[13px] font-semibold" style={{ color: INK.text }}>
                  {new Date(insight.generated_at).toLocaleDateString(undefined, {
                    day: 'numeric', month: 'long', year: 'numeric',
                  })}
                </p>
                <p
                  className="mt-1 break-all text-[10.5px]"
                  style={{ color: INK.textFaint, fontFamily: FONT.mono }}
                >
                  Ref {insight.investigation_id}
                </p>
              </div>
            </div>
          </div>
        </Card>
      </motion.section>

      {/* ── Ask the analyst ───────────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <SectionHeader
          title="Ask the analyst"
          description="The agent reads the question, chooses which pipeline stages to run, and answers only from recorded findings. Where the evidence does not support an answer, it abstains rather than estimating."
        />
        <IntelligenceAsk tenants={tenantsParam} persona={persona} onPersonaChange={setPersona}
                         days={rangeDays} />
      </section>

      {/* ── Attribution ───────────────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <SectionHeader
          title="Attribution"
          description="The metric's own path, then where the movement concentrated and which factor of the identity carried it. Contributions are computed on additive fundamentals, never on rates."
        />

        {series && series.points?.length > 0 && (
          <TimeSeriesPanel
            title={series.name}
            subtitle={`${series.days}-day path · ${
              series.unit === 'ratio' ? 'rate' : `counting ${series.measure || 'events'}`
            } · one point per UTC day`}
            points={series.points}
            isRate={series.unit === 'ratio'}
            band={series.forecast}
            bandWithheld={series.forecast_withheld}
            source={series.source}
            height={230}
          />
        )}

        {/* Bar gauges on a shared scale rather than a percentage per card. Per-card bars made
            rank 1 and rank 5 look equally important until the figure was read; one axis makes the
            ordering visible first, and the threshold colour states the judgement outright. */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Panel
            title="Segment concentration"
            subtitle="share of the movement, ranked"
            right={<Pill>{insight.causes.length} ranked</Pill>}
            footer={<SourceChip source="root_causes" />}
          >
            {insight.causes.length > 0 ? (
              <BarGauge
                rows={insight.causes.map((cause) => ({
                  label: Object.entries(cause.dimensions)
                    .map(([k, v]) => `${titleCase(k)}: ${v}`)
                    .join(' · '),
                  sub: `${cause.fundamental.replace(/_/g, ' ')} · ${cause.method}`,
                  value: cause.contribution * 100,
                }))}
              />
            ) : (
              <div className="p-4">
                <Empty>
                  No single segment accounts for this result; the effect is distributed across the
                  cube.
                </Empty>
              </div>
            )}
          </Panel>

          <Panel
            title="Factor decomposition"
            subtitle="price, volume, mix and entry/exit"
            right={<Pill>{insight.factors.length} factors</Pill>}
            footer={<SourceChip source="insights" />}
          >
            {insight.factors.length > 0 ? (
              <BarGauge
                rows={insight.factors.map((factor) => ({
                  label: titleCase(factor.factor),
                  sub: FACTOR_HINT[factor.factor] || 'Declared factor',
                  value: factor.contribution * 100,
                }))}
              />
            ) : (
              <div className="p-4">
                <Empty>
                  This metric declares no factor identity, so no decomposition is published.
                </Empty>
              </div>
            )}
          </Panel>
        </div>
      </section>

      {/* ── Audit trail ───────────────────────────────────────────────────────────────────
          Assurance, recommendations and provenance are evidence FOR the finding, not the finding.
          As four equal-weight stacked sections they outranked it, so they fold behind one
          disclosure, reachable in a click, never competing for the first read. */}
      <section>
        <motion.button
          onClick={() => setAuditOpen((v) => !v)}
          whileHover={{ y: -1 }}
          className="flex w-full cursor-pointer items-center gap-3 rounded-2xl border px-5 py-4 text-left"
          style={{ borderColor: INK.hairline, background: INK.surface }}
        >
          <FileSearch className="h-4 w-4 shrink-0" style={{ color: INK.accent }} />
          <div className="min-w-0">
            <h2 className="text-[17px] leading-tight" style={{ color: INK.text, fontFamily: FONT.display }}>
              Audit trail
            </h2>
            <p className="mt-0.5 text-[12.5px]" style={{ color: INK.textSoft }}>
              Every figure traced to a stored claim, the levers proposed against it, and the sources
              and runtime cost behind the whole investigation.
            </p>
          </div>
          <span
            className="ml-auto flex shrink-0 items-center gap-2 text-[11px]"
            style={{ color: INK.textFaint, fontFamily: FONT.mono }}
          >
            {insight.evidence.length} claims · {relevantRecs.length} actions · {sources.length} sources
            <ChevronDown
              className={`h-4 w-4 transition-transform duration-300 ${auditOpen ? 'rotate-180' : ''}`}
            />
          </span>
        </motion.button>

        <AnimatePresence initial={false}>
          {auditOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.4, ease: EASE }}
              className="overflow-hidden"
            >
              <div className="space-y-8 pt-6">
                <div className="space-y-3">
                  <SectionHeader
                    title="Assurance"
                    description="Every figure in the narrative traces to a stored claim, and every trust check is recorded whether it passed or failed."
                  />
                  <IntelligenceEvidence
                    evidence={insight.evidence}
                    trust={insight.trust}
                    engine={insight.engine_breakdown}
                    verifierPass={insight.verifier_pass}
                  />
                </div>

                <div className="space-y-3">
                  <SectionHeader
                    title="Recommended actions"
                    description="Drawn from the levers declared in the metric contract. Nothing is executed automatically; each item requires an accountable owner to authorise it."
                  />
                  <Card>
                    {relevantRecs.map((rec, i) => (
                      <motion.div
                        key={rec.rec_id}
                        initial={{ opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: step(i, 60), duration: 0.36, ease: EASE }}
                        className="flex flex-wrap items-start justify-between gap-3 p-5"
                        style={{ borderTop: i === 0 ? 'none' : `1px solid ${INK.hairline}` }}
                      >
                        <div className="min-w-0">
                          <p className="text-[14px] font-medium" style={{ color: INK.text }}>
                            {rec.action}
                          </p>
                          <p
                            className="mt-1 text-[10.5px] tracking-[0.14em] uppercase"
                            style={{ color: INK.textFaint }}
                          >
                            Lever {rec.lever} · Owner {rec.owner_role}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Pill>{rec.status}</Pill>
                          <span
                            className="rounded-full px-2.5 py-1 text-[11px]"
                            style={{
                              background: INK.signalSoft,
                              color: INK.signal,
                              fontFamily: FONT.mono,
                            }}
                          >
                            up to {compact(rec.expected_impact.high)}
                          </span>
                        </div>
                      </motion.div>
                    ))}
                    {relevantRecs.length === 0 && (
                      <div className="p-5">
                        <Empty>
                          No action is proposed. The contract&apos;s lever list offers nothing that
                          applies to this result.
                        </Empty>
                      </div>
                    )}
                  </Card>
                </div>

                <div className="space-y-3">
                  <SectionHeader
                    title="Provenance and cost"
                    description="The sources that fed this investigation, their delivery cadence against SLA, and the runtime cost of each pipeline stage."
                  />
                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                    <SourceHealthPanel sources={sources.length ? sources : insight.sources} />
                    <Card className="p-5">
                      <div className="flex items-center justify-between gap-3">
                        <h3
                          className="text-[15px]"
                          style={{ color: INK.text, fontFamily: FONT.display }}
                        >
                          Runtime by stage
                        </h3>
                        <Pill
                          tone={
                            (telemetry?.total_cost_usd ?? 0) === 0
                              ? { fg: INK.positive, bg: INK.positiveSoft }
                              : undefined
                          }
                        >
                          {telemetry?.total_runs ?? 0} runs ·{' '}
                          {(telemetry?.total_cost_usd ?? 0) === 0
                            ? 'no model spend'
                            : `$${(telemetry?.total_cost_usd ?? 0).toFixed(4)}`}
                        </Pill>
                      </div>
                      <div className="mt-4 max-h-80 overflow-auto">
                        <table className="w-full">
                          <thead className="sticky top-0" style={{ background: INK.sunken }}>
                            <tr>
                              {['Stage', 'Engine', 'Runs', 'Latency', 'Tokens'].map((h, i) => (
                                <th
                                  key={h}
                                  className={`px-3 py-2 text-[10px] tracking-[0.14em] uppercase ${
                                    i > 1 ? 'text-right' : 'text-left'
                                  }`}
                                  style={{ color: INK.textFaint }}
                                >
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {(telemetry?.by_stage ?? []).map((row) => (
                              // A stage appears ONCE PER ENGINE: `narrate` is listed for both
                              // `rule` and `llm`, which is the LLM-vs-deterministic breakdown the
                              // panel exists to show. Keying on the stage alone collided the
                              // moment the model came online, and React may drop or duplicate a
                              // row when two siblings share a key.
                              <tr
                                key={`${row.stage}-${row.engine_type}`}
                                style={{ borderTop: `1px solid ${INK.hairline}` }}
                              >
                                <td className="px-3 py-2 text-[13px]" style={{ color: INK.text }}>
                                  {titleCase(row.stage)}
                                </td>
                                <td className="px-3 py-2">
                                  <Pill>{row.engine_type}</Pill>
                                </td>
                                {[row.runs, `${row.latency_ms} ms`].map((v, i) => (
                                  <td
                                    key={i}
                                    className="px-3 py-2 text-right text-[13px]"
                                    style={{
                                      color: INK.textSoft,
                                      fontFamily: FONT.mono,
                                      fontVariantNumeric: 'tabular-nums',
                                    }}
                                  >
                                    {v}
                                  </td>
                                ))}
                                {/* A bare "0" in a Tokens column reads as a measurement that
                                    failed. It is the opposite: this stage reached its answer
                                    without a model, which is the guarantee the platform makes.
                                    Say that instead of printing a zero. */}
                                <td className="px-3 py-2 text-right">
                                  {row.tokens_in + row.tokens_out > 0 ? (
                                    <span
                                      className="text-[13px]"
                                      style={{
                                        color: INK.textSoft,
                                        fontFamily: FONT.mono,
                                        fontVariantNumeric: 'tabular-nums',
                                      }}
                                    >
                                      {(row.tokens_in + row.tokens_out).toLocaleString()}
                                    </span>
                                  ) : (
                                    <span
                                      title="This stage is deterministic. It produced its result from stored rows and arithmetic, with no language model in the path."
                                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap"
                                      style={{ background: INK.positiveSoft, color: INK.positive }}
                                    >
                                      no LLM needed
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                            {!(telemetry?.by_stage ?? []).length && (
                              <tr>
                                <td colSpan={5} className="px-3 py-8 text-center text-[13px]" style={{ color: INK.textFaint }}>
                                  No stage has been executed for this portfolio yet.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </Card>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}
