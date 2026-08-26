'use client';

/**
 * Model Observability page — Intelligence Layer Stage 7 (Observe).
 * Supports the close-the-loop stage:
 * - Per-stage health metrics (detection FPR, localization hit-rate@k, forecast MASE, etc.)
 * - Rollout ladder indicator per capability (shadow → assist → approve → autonomous)
 * - Model run trace list from model_runs table
 * - Golden set evaluation results
 */

import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { dashboardAPI } from '@/lib/api';
import ChartContainer from '@/components/ChartContainer';
import { ChartSkeleton } from '@/components/Skeletons';
import {
  Activity,
  CheckCircle2,
  XCircle,
  Clock,
  Cpu,
  Database,
  Brain,
  Code,
  Gauge,
  ArrowRight,
  Filter,
} from 'lucide-react';
import type { PipelineStage, RolloutStage, ModelRun } from '@/types';

const stageLabels: Record<PipelineStage, { label: string; icon: React.ElementType }> = {
  trust_gate: { label: 'Trust Gate', icon: Database },
  detect: { label: 'Detect', icon: Activity },
  localize: { label: 'Localize', icon: Gauge },
  forecast: { label: 'Forecast', icon: Activity },
  causal: { label: 'Causal', icon: Activity },
  decide: { label: 'Decide', icon: Brain },
  narrate: { label: 'Narrate', icon: Code },
  observe: { label: 'Observe', icon: Activity },
};

const rolloutColors: Record<RolloutStage, { bg: string; text: string; border: string }> = {
  shadow: { bg: 'bg-gray-100', text: 'text-gray-600', border: 'border-gray-200' },
  assist: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
  approve: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
  autonomous: { bg: 'bg-teal-50', text: 'text-teal-700', border: 'border-teal-200' },
};

const rolloutOrder: RolloutStage[] = ['shadow', 'assist', 'approve', 'autonomous'];

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  } catch {
    return dateStr;
  }
}

export default function ObservabilityPage() {
  const [stageFilter, setStageFilter] = useState<PipelineStage | 'all'>('all');

  // Fetch stage health
  const { data: healthData = [], isLoading: isHealthLoading } = useQuery({
    queryKey: ['intelligence', 'stageHealth'],
    queryFn: () => dashboardAPI.getStageHealth(),
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });

  // Fetch rollout ladder
  const { data: rolloutData = [], isLoading: isRolloutLoading } = useQuery({
    queryKey: ['intelligence', 'rolloutLadder'],
    queryFn: () => dashboardAPI.getRolloutLadder(),
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });

  // Fetch model runs
  const { data: modelRuns = [], isLoading: isRunsLoading } = useQuery({
    queryKey: ['intelligence', 'modelRuns', stageFilter],
    queryFn: () => dashboardAPI.getModelRuns(stageFilter === 'all' ? undefined : stageFilter, '7d'),
    staleTime: 60 * 1000,
    retry: 0,
  });

  // Fetch golden set results
  const { data: goldenResults = [], isLoading: isGoldenLoading } = useQuery({
    queryKey: ['intelligence', 'goldenSetResults'],
    queryFn: () => dashboardAPI.getGoldenSetResults(),
    staleTime: 10 * 60 * 1000,
    retry: 0,
  });

  const filteredRuns = useMemo(() => {
    return stageFilter === 'all'
      ? modelRuns
      : modelRuns.filter((r: ModelRun) => r.stage === stageFilter);
  }, [modelRuns, stageFilter]);

  const hasData = healthData.length > 0 || rolloutData.length > 0 || modelRuns.length > 0 || goldenResults.length > 0;

  return (
    <div className="animate-in fade-in duration-500 space-y-6">
      {/* Page Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-violet-50 border border-violet-100">
          <Activity className="w-5 h-5 text-violet-600" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Model Observability</h1>
          <p className="text-sm text-gray-500">Pipeline health, rollout status, and audit trail</p>
        </div>
      </div>

      {/* Rollout Ladder */}
      <ChartContainer title="Rollout Ladder" id="rollout-ladder">
        {isRolloutLoading ? (
          <div className="animate-pulse space-y-3">
            {[1, 2, 3].map((i) => <div key={i} className="h-10 bg-gray-100 rounded" />)}
          </div>
        ) : rolloutData.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 p-6 text-center">
            <p className="text-sm text-gray-500">Rollout ladder data will appear once stages report their maturity level.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {rolloutData.map((item) => {
              const currentIndex = rolloutOrder.indexOf(item.stage);
              return (
                <div key={item.capability} className="flex items-center gap-4">
                  <span className="text-sm font-medium text-gray-700 w-28 shrink-0">
                    {item.capability_label}
                  </span>
                  <div className="flex items-center gap-1.5 flex-1">
                    {rolloutOrder.map((stage, idx) => {
                      const isActive = idx <= currentIndex;
                      const isCurrent = stage === item.stage;
                      const colors = rolloutColors[stage];
                      return (
                        <React.Fragment key={stage}>
                          <div
                            className={`px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wider border transition-colors ${
                              isCurrent
                                ? `${colors.bg} ${colors.text} ${colors.border} ring-1 ring-offset-1 ring-current/20`
                                : isActive
                                  ? `${colors.bg} ${colors.text} border-transparent opacity-60`
                                  : 'bg-gray-50 text-gray-300 border-gray-100'
                            }`}
                          >
                            {stage}
                          </div>
                          {idx < rolloutOrder.length - 1 && (
                            <ArrowRight className={`w-3 h-3 ${isActive ? 'text-gray-400' : 'text-gray-200'}`} />
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ChartContainer>

      {/* Per-Stage Health */}
      <ChartContainer title="Stage Health Metrics" id="stage-health">
        {isHealthLoading ? (
          <ChartSkeleton />
        ) : healthData.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 p-6 text-center">
            <Gauge className="w-6 h-6 text-gray-400 mx-auto mb-2" />
            <p className="text-sm text-gray-500">Health metrics will appear once stages produce enough run data.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {healthData.map((metric) => (
              <div
                key={`${metric.stage}-${metric.metric_name}`}
                className={`p-4 rounded-lg border ${
                  metric.passing ? 'border-gray-200 bg-white' : 'border-amber-200 bg-amber-50'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {metric.stage_label}
                  </span>
                  {metric.passing ? (
                    <CheckCircle2 className="w-4 h-4 text-teal-500" />
                  ) : (
                    <XCircle className="w-4 h-4 text-amber-500" />
                  )}
                </div>
                <p className="text-sm font-medium text-gray-700">{metric.metric_label}</p>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-xl font-semibold text-gray-900 tabular-nums">
                    {metric.value.toFixed(3)}
                  </span>
                  <span className="text-xs text-gray-400">
                    pass bar: {metric.pass_bar.toFixed(3)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </ChartContainer>

      {/* Golden Set Results */}
      <ChartContainer title="Golden Set Evaluations" id="golden-set">
        {isGoldenLoading ? (
          <div className="animate-pulse h-32 bg-gray-100 rounded" />
        ) : goldenResults.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 p-6 text-center">
            <p className="text-sm text-gray-500">Golden set evaluation results will appear after regression runs.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Scenario</th>
                  <th className="text-right pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Det. FPR</th>
                  <th className="text-right pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Loc. HR@1</th>
                  <th className="text-right pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Fcst MASE</th>
                  <th className="text-right pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Entitle Leaks</th>
                  <th className="text-right pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Unverified #</th>
                  <th className="text-center pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Pass</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {goldenResults.map((r) => (
                  <tr key={r.scenario_id} className="hover:bg-gray-50">
                    <td className="py-2 font-medium text-gray-700">{r.scenario_label}</td>
                    <td className="py-2 text-right tabular-nums">{r.detection_fpr?.toFixed(3) ?? '–'}</td>
                    <td className="py-2 text-right tabular-nums">{r.localization_hit_rate_at_1?.toFixed(3) ?? '–'}</td>
                    <td className="py-2 text-right tabular-nums">{r.forecast_mase?.toFixed(3) ?? '–'}</td>
                    <td className="py-2 text-right tabular-nums">{r.entitlement_leaks}</td>
                    <td className="py-2 text-right tabular-nums">{r.unverified_numbers}</td>
                    <td className="py-2 text-center">
                      {r.passed ? (
                        <CheckCircle2 className="w-4 h-4 text-teal-500 mx-auto" />
                      ) : (
                        <XCircle className="w-4 h-4 text-red-500 mx-auto" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ChartContainer>

      {/* Model Run Trace */}
      <ChartContainer title="Model Run Trace" id="model-runs">
        {/* Stage filter */}
        <div className="flex items-center gap-1.5 mb-4 flex-wrap">
          <button
            onClick={() => setStageFilter('all')}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
              stageFilter === 'all' ? 'bg-[#1a73e8] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            All
          </button>
          {(Object.keys(stageLabels) as PipelineStage[]).map((stage) => (
            <button
              key={stage}
              onClick={() => setStageFilter(stage)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                stageFilter === stage ? 'bg-[#1a73e8] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {stageLabels[stage].label}
            </button>
          ))}
        </div>

        {isRunsLoading ? (
          <div className="animate-pulse space-y-2">
            {[1, 2, 3, 4, 5].map((i) => <div key={i} className="h-10 bg-gray-100 rounded" />)}
          </div>
        ) : filteredRuns.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 p-6 text-center">
            <Cpu className="w-6 h-6 text-gray-400 mx-auto mb-2" />
            <p className="text-sm text-gray-500">Model run traces will appear here as the pipeline executes.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Stage</th>
                  <th className="text-left pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Model</th>
                  <th className="text-left pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Engine</th>
                  <th className="text-right pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Latency</th>
                  <th className="text-right pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Tokens</th>
                  <th className="text-center pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Verified</th>
                  <th className="text-right pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filteredRuns.slice(0, 50).map((run: ModelRun) => (
                  <tr key={run.id} className="hover:bg-gray-50">
                    <td className="py-2">
                      <span className="text-xs font-semibold uppercase tracking-wider text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
                        {stageLabels[run.stage]?.label || run.stage}
                      </span>
                    </td>
                    <td className="py-2 font-mono text-xs text-gray-700">{run.model}</td>
                    <td className="py-2">
                      <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${
                        run.engine_type === 'llm' ? 'bg-purple-50 text-purple-700' :
                        run.engine_type === 'sql' ? 'bg-blue-50 text-blue-700' :
                        run.engine_type === 'stats' ? 'bg-teal-50 text-teal-700' :
                        'bg-gray-100 text-gray-600'
                      }`}>
                        {run.engine_type}
                      </span>
                    </td>
                    <td className="py-2 text-right tabular-nums text-gray-600">{formatDuration(run.latency_ms)}</td>
                    <td className="py-2 text-right tabular-nums text-gray-600">
                      {run.tokens_in != null || run.tokens_out != null
                        ? `${run.tokens_in ?? 0}/${run.tokens_out ?? 0}`
                        : '–'}
                    </td>
                    <td className="py-2 text-center">
                      {run.verifier_pass === true && <CheckCircle2 className="w-3.5 h-3.5 text-teal-500 mx-auto" />}
                      {run.verifier_pass === false && <XCircle className="w-3.5 h-3.5 text-red-500 mx-auto" />}
                      {run.verifier_pass == null && <span className="text-gray-300">–</span>}
                    </td>
                    <td className="py-2 text-right text-xs text-gray-400 flex items-center justify-end gap-1">
                      <Clock className="w-3 h-3" />
                      {formatTimestamp(run.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ChartContainer>
    </div>
  );
}
