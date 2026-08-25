'use client';

/**
 * Causal Impact page — Intelligence Layer Stage 4.
 * For campaign/feature-launch style questions ("did the festival sale actually cause the lift").
 * Features:
 * - Intervention picker (date range + affected segment)
 * - Observed vs. synthetic-control counterfactual chart with credible interval
 * - Causal rung ladder label (association → attribution → corroborated_cause → estimated_effect)
 */

import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDashboardData } from '@/hooks/useDashboard';
import { dashboardAPI } from '@/lib/api';
import ChartContainer from '@/components/ChartContainer';
import { TrustBadge } from '@/components/intelligence';
import { ChartSkeleton } from '@/components/Skeletons';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from 'recharts';
import {
  GitBranch,
  Calendar,
  Target,
  ArrowRight,
  TrendingUp,
  TrendingDown,
  Info,
} from 'lucide-react';
import type { CausalRung } from '@/types';

const rungLabels: Record<CausalRung, { label: string; bg: string; text: string; description: string }> = {
  association: {
    label: 'Association',
    bg: 'bg-gray-100',
    text: 'text-gray-600',
    description: 'Correlated but no causal claim — coincidence is possible.',
  },
  attribution: {
    label: 'Attribution',
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    description: 'Attributed via matching, but confounders may remain.',
  },
  corroborated_cause: {
    label: 'Corroborated Cause',
    bg: 'bg-teal-50',
    text: 'text-teal-700',
    description: 'Multiple evidence sources corroborate causation.',
  },
  estimated_effect: {
    label: 'Estimated Effect',
    bg: 'bg-emerald-50',
    text: 'text-emerald-700',
    description: 'Quantified causal effect with credible interval.',
  },
};

const rungOrder: CausalRung[] = ['association', 'attribution', 'corroborated_cause', 'estimated_effect'];

export default function CausalImpactPage() {
  const { tenantsParam, rangeParam } = useDashboardData();
  const [selectedIntervention, setSelectedIntervention] = useState<string | null>(null);

  // Fetch available interventions
  const { data: interventionsData } = useQuery({
    queryKey: ['intelligence', 'causalInterventions', tenantsParam, rangeParam],
    queryFn: () => dashboardAPI.getCausalInterventions(tenantsParam, rangeParam),
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });

  const interventions = interventionsData || [];

  // Fetch causal impact for selected intervention
  const { data: impact, isLoading: isImpactLoading } = useQuery({
    queryKey: ['intelligence', 'causalImpact', tenantsParam, selectedIntervention],
    queryFn: () => selectedIntervention ? dashboardAPI.getCausalImpact(tenantsParam, selectedIntervention) : null,
    enabled: !!selectedIntervention,
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });

  const rungConfig = impact ? rungLabels[impact.rung_label] : null;
  const currentRungIndex = impact ? rungOrder.indexOf(impact.rung_label) : -1;

  const isEmpty = !impact && !isImpactLoading;

  return (
    <div className="animate-in fade-in duration-500 space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-50 border border-blue-100">
            <GitBranch className="w-5 h-5 text-[#1a73e8]" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Causal Impact</h1>
            <p className="text-sm text-gray-500">Did the intervention actually cause the observed change?</p>
          </div>
        </div>
      </div>

      {/* Intervention Picker */}
      <ChartContainer title="Select Intervention" id="intervention-picker">
        {interventions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 p-8 text-center">
            <Calendar className="w-6 h-6 text-gray-400 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-600">No interventions available yet</p>
            <p className="text-xs text-gray-400 mt-1">
              Interventions (campaigns, feature launches, incidents) will appear here once the pipeline records them.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {interventions.map((intervention) => (
              <button
                key={intervention.id}
                onClick={() => setSelectedIntervention(intervention.id)}
                className={`text-left p-4 rounded-lg border transition-all cursor-pointer ${
                  selectedIntervention === intervention.id
                    ? 'border-[#1a73e8] bg-blue-50 shadow-sm'
                    : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
                }`}
              >
                <div className="text-sm font-medium text-gray-900">{intervention.label}</div>
                <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-500">
                  <Calendar className="w-3 h-3" />
                  <span>{intervention.start}</span>
                  <ArrowRight className="w-3 h-3" />
                  <span>{intervention.end}</span>
                </div>
                <div className="flex items-center gap-1.5 mt-1 text-xs text-gray-400">
                  <Target className="w-3 h-3" />
                  <span>{intervention.segment}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </ChartContainer>

      {/* Causal Impact Chart */}
      {isImpactLoading && <ChartSkeleton />}

      {impact && (
        <>
          {/* Rung Ladder */}
          <ChartContainer title="Evidence Level" id="causal-rung-ladder">
            <div className="flex items-center gap-2 mb-4">
              {rungOrder.map((rung, idx) => {
                const config = rungLabels[rung];
                const isActive = idx <= currentRungIndex;
                const isCurrent = rung === impact.rung_label;
                return (
                  <React.Fragment key={rung}>
                    <div
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        isCurrent
                          ? `${config.bg} ${config.text} border-current ring-2 ring-offset-1 ring-current/20`
                          : isActive
                            ? `${config.bg} ${config.text} border-transparent`
                            : 'bg-gray-50 text-gray-400 border-gray-100'
                      }`}
                      title={config.description}
                    >
                      {config.label}
                    </div>
                    {idx < rungOrder.length - 1 && (
                      <ArrowRight className={`w-3.5 h-3.5 ${isActive ? 'text-gray-400' : 'text-gray-200'}`} />
                    )}
                  </React.Fragment>
                );
              })}
            </div>

            {rungConfig && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-gray-50 border border-gray-100">
                <Info className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
                <p className="text-xs text-gray-600">{rungConfig.description}</p>
              </div>
            )}

            {impact.degraded && (
              <div className="mt-3 flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200">
                <Info className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-medium text-amber-700">Degraded estimate</p>
                  <p className="text-xs text-amber-600 mt-0.5">{impact.degraded_reason || 'Assumptions for a higher evidence rung were not met.'}</p>
                </div>
              </div>
            )}
          </ChartContainer>

          {/* Observed vs Counterfactual Chart */}
          <ChartContainer title={`${impact.metric_label} — Observed vs. Counterfactual`} id="causal-chart">
            <div className="flex items-center gap-4 mb-4 flex-wrap">
              <div className="flex items-center gap-2">
                {impact.lift >= 0 ? (
                  <TrendingUp className="w-4 h-4 text-teal-600" />
                ) : (
                  <TrendingDown className="w-4 h-4 text-rose-600" />
                )}
                <span className="text-sm font-semibold text-gray-900">
                  Lift: {impact.lift_pct >= 0 ? '+' : ''}{impact.lift_pct.toFixed(1)}%
                </span>
                <span className="text-xs text-gray-500">
                  ({impact.credible_interval_lo.toFixed(1)}% – {impact.credible_interval_hi.toFixed(1)}%)
                </span>
              </div>
              <span className="text-xs text-gray-400">
                Segment: {impact.affected_segment}
              </span>
            </div>

            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={impact.time_series} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#888' }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#888' }} tickLine={false} axisLine={false} width={60} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />

                {/* Counterfactual confidence band */}
                <Area
                  dataKey="counterfactual_hi"
                  stroke="none"
                  fill="#94a3b8"
                  fillOpacity={0.1}
                  name="Counterfactual upper"
                  legendType="none"
                />
                <Area
                  dataKey="counterfactual_lo"
                  stroke="none"
                  fill="#ffffff"
                  fillOpacity={1}
                  name="Counterfactual lower"
                  legendType="none"
                />

                {/* Counterfactual line */}
                <Line
                  dataKey="counterfactual"
                  stroke="#94a3b8"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  dot={false}
                  name="Counterfactual"
                />

                {/* Observed line */}
                <Line
                  dataKey="observed"
                  stroke="#1a73e8"
                  strokeWidth={2}
                  dot={{ r: 2, fill: '#1a73e8' }}
                  name="Observed"
                />

                {/* Intervention start marker */}
                <ReferenceLine
                  x={impact.intervention_start}
                  stroke="#ef4444"
                  strokeDasharray="4 4"
                  label={{ value: 'Intervention', position: 'top', fontSize: 10, fill: '#ef4444' }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartContainer>
        </>
      )}

      {/* Empty state */}
      {isEmpty && !interventions.length && (
        <ChartContainer title="Impact Analysis" id="causal-empty">
          <div className="rounded-xl border border-dashed border-gray-200 bg-white p-12 text-center">
            <GitBranch className="w-8 h-8 text-gray-300 mx-auto mb-4" />
            <p className="text-sm font-medium text-gray-600">Select an intervention to see its causal impact</p>
            <p className="text-xs text-gray-400 mt-1">
              The system compares observed outcomes against a synthetic counterfactual to estimate whether the intervention caused the change.
            </p>
          </div>
        </ChartContainer>
      )}
    </div>
  );
}
