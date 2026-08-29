'use client';

/**
 * Intelligence page — the read surface of the agentic investigation pipeline.
 *
 * Shows the persona narrative alongside everything needed to audit it: which cells moved, which
 * factor of the identity moved, which sources fed it, what the trust gate decided, and how much of
 * the work was done by an LLM versus a deterministic engine.
 */

import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { dashboardAPI } from '@/lib/api';
import { useDashboardData } from '@/hooks/useDashboard';
import IntelligenceEvidence from '@/components/IntelligenceEvidence';
import SourceHealthPanel from '@/components/SourceHealthPanel';
import IntelligenceAsk from '@/components/IntelligenceAsk';
import { ChartSkeleton } from '@/components/Skeletons';

const VERDICT_TONE: Record<string, string> = {
  pass: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  fail: 'border-red-200 bg-red-50 text-red-700',
  ambiguous: 'border-amber-200 bg-amber-50 text-amber-700',
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

/** Matches the section rhythm used across the dashboard: title, then a one-line rationale. */
function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">{description}</p>
      </div>
    </div>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <span
      className={`rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${
        tone || 'border-slate-200 bg-slate-50 text-slate-600'
      }`}
    >
      {children}
    </span>
  );
}

export default function IntelligencePage() {
  const { tenantsParam } = useDashboardData();
  // Empty means "whatever the server resolves from my role"; a switch only ever narrows.
  const [persona, setPersona] = useState('');

  const { data: insight, isLoading } = useQuery({
    queryKey: ['intelligenceInsight', tenantsParam, persona],
    queryFn: () => dashboardAPI.getIntelligenceInsight(tenantsParam, undefined, persona || undefined),
    staleTime: 30 * 1000,
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
      <div className="space-y-8 animate-in fade-in duration-500">
        <section className="rounded-4xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-slate-400">
            Decision intelligence
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
            Investigation Report
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-500">
            An investigation is opened only when a governed KPI moves beyond its forecast band. No
            such movement has been recorded for the selected portfolio, which is itself a finding:
            the monitored metrics are operating within expectation.
          </p>
        </section>
        <IntelligenceAsk tenants={tenantsParam} persona={persona}
                         onPersonaChange={setPersona} />
      </div>
    );
  }

  const movementLabel = insight.anomaly_id ? 'Material movement detected' : 'Within expectation';

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Executive summary */}
      <section className="rounded-4xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-slate-400">
              Decision intelligence ·{' '}
              {personaChoices?.personas.find((p) => p.id === insight.persona)?.label ||
                titleCase(insight.persona)}{' '}
              view
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
              {insight.headline}
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">{insight.narrative}</p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Pill>{insight.kpi_id.replace(/_/g, ' ')}</Pill>
              <Pill tone={VERDICT_TONE[insight.trust_verdict] || VERDICT_TONE.ambiguous}>
                Trust {insight.trust_verdict}
              </Pill>
              <Pill
                tone={
                  insight.anomaly_id
                    ? 'border-[#1a73e8]/30 bg-[#1a73e8]/5 text-[#1a73e8]'
                    : undefined
                }
              >
                {movementLabel}
              </Pill>
              {insight.simulated === 1 && (
                <Pill tone="border-amber-200 bg-amber-50 text-amber-700">Modelled metric</Pill>
              )}
              {insight.abstained === 1 && <Pill>Abstained</Pill>}
            </div>
          </div>

          <div className="grid shrink-0 grid-cols-2 gap-3 lg:w-72 lg:grid-cols-1">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Confidence
              </p>
              <p className="mt-2 text-3xl font-semibold text-slate-900">
                {(insight.confidence * 100).toFixed(0)}%
              </p>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full bg-[#1a73e8]"
                  style={{ width: `${Math.min(insight.confidence * 100, 100)}%` }}
                />
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Issued
              </p>
              <p className="mt-2 text-sm font-semibold text-slate-900">
                {new Date(insight.generated_at).toLocaleString()}
              </p>
              <p className="mt-1 break-all text-[11px] text-slate-400">
                Ref {insight.investigation_id}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="Ask the analyst"
          description="Questions are answered from recorded findings only. Where the evidence does not support an answer, the response abstains rather than estimating."
        />
        <IntelligenceAsk tenants={tenantsParam} persona={persona}
                         onPersonaChange={setPersona} />
      </section>

      {/* Attribution */}
      <section className="space-y-4">
        <SectionHeader
          title="Attribution"
          description="Where the movement concentrated, and which factor of the metric identity carried it. Contributions are computed on additive fundamentals, never on rates."
        />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-700">Segment concentration</h3>
              <Pill>{insight.causes.length} ranked</Pill>
            </div>
            <div className="mt-4 space-y-3">
              {insight.causes.map((cause) => (
                <div
                  key={`${cause.rank}-${cause.fundamental}-${JSON.stringify(cause.dimensions)}`}
                  className="rounded-xl border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">
                        {Object.entries(cause.dimensions)
                          .map(([k, v]) => `${titleCase(k)}: ${v}`)
                          .join(' · ')}
                      </p>
                      <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-slate-400">
                        {cause.fundamental.replace(/_/g, ' ')} · {cause.method}
                      </p>
                    </div>
                    <span className="shrink-0 text-lg font-semibold text-slate-900">
                      {(cause.contribution * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full bg-[#1a73e8]"
                      style={{ width: `${Math.min(Math.abs(cause.contribution) * 100, 100)}%` }}
                    />
                  </div>
                </div>
              ))}
              {insight.causes.length === 0 && (
                <p className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
                  No single segment accounts for this result; the effect is distributed across the
                  cube.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-700">Factor decomposition</h3>
              <Pill>{insight.factors.length} factors</Pill>
            </div>
            <div className="mt-4 space-y-3">
              {insight.factors.map((factor) => (
                <div key={factor.factor} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold capitalize text-slate-900">
                        {factor.factor.replace(/_/g, ' ')}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        {FACTOR_HINT[factor.factor] || 'Declared factor'}
                      </p>
                    </div>
                    <span className="shrink-0 text-lg font-semibold text-slate-900">
                      {(factor.contribution * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full bg-[#1a73e8]"
                      style={{ width: `${Math.min(Math.abs(factor.contribution) * 100, 100)}%` }}
                    />
                  </div>
                </div>
              ))}
              {insight.factors.length === 0 && (
                <p className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
                  This metric declares no factor identity, so no decomposition is published.
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Assurance */}
      <section className="space-y-4">
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
      </section>

      {/* Recommendations */}
      <section className="space-y-4">
        <SectionHeader
          title="Recommended actions"
          description="Drawn from the levers declared in the metric contract. Nothing is executed automatically; each item requires an accountable owner to authorise it."
        />
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="space-y-3">
            {relevantRecs.map((rec) => (
              <div key={rec.rec_id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900">{rec.action}</p>
                    <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-slate-400">
                      Lever {rec.lever.replace(/_/g, ' ')} · Owner{' '}
                      {rec.owner_role.replace(/_/g, ' ')}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Pill>{rec.status.replace(/_/g, ' ')}</Pill>
                    <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold text-slate-700">
                      Impact up to {rec.expected_impact.high.toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
            ))}
            {relevantRecs.length === 0 && (
              <p className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
                No action is proposed. The contract&apos;s lever list offers nothing that applies to
                this result.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Provenance */}
      <section className="space-y-4">
        <SectionHeader
          title="Provenance and cost"
          description="The sources that fed this investigation, their delivery cadence against SLA, and the runtime cost of each pipeline stage."
        />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <SourceHealthPanel sources={sources.length ? sources : insight.sources} />

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-700">Runtime by stage</h3>
              {telemetry && (
                <Pill>
                  {telemetry.total_runs} runs · ${telemetry.total_cost_usd.toFixed(4)}
                </Pill>
              )}
            </div>
            <div className="mt-4 max-h-80 overflow-y-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    <th className="pb-3 pr-4">Stage</th>
                    <th className="pb-3 pr-4">Engine</th>
                    <th className="pb-3 pr-4 text-right">Runs</th>
                    <th className="pb-3 pr-4 text-right">Latency</th>
                    <th className="pb-3 text-right">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {(telemetry?.by_stage || []).map((stage) => (
                    <tr
                      key={`${stage.stage}-${stage.engine_type}`}
                      className="border-b border-slate-100 last:border-0"
                    >
                      <td className="py-3 pr-4 text-sm capitalize text-slate-900">
                        {stage.stage.replace(/_/g, ' ')}
                      </td>
                      <td className="py-3 pr-4">
                        <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                          {stage.engine_type}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-right text-sm text-slate-700">{stage.runs}</td>
                      <td className="py-3 pr-4 text-right text-sm text-slate-700">
                        {stage.latency_ms.toLocaleString()} ms
                      </td>
                      <td className="py-3 text-right text-sm text-slate-700">
                        {(stage.tokens_in + stage.tokens_out).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                  {!telemetry?.by_stage?.length && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-sm text-slate-400">
                        No stage has been executed for this portfolio yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
