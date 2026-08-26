'use client';

import React, { useMemo } from 'react';
import { useDashboardData } from '@/hooks/useDashboard';
import { FunnelPageSkeleton } from '@/components/Skeletons';
import { FunnelStep } from '@/types';
import { TrendingUp, Sparkles, Target, ArrowRight } from 'lucide-react';

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

function toTitleCase(label: string) {
  return label
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function buildStageDiagnostics(funnelData: FunnelStep[]) {
  const entry = funnelData[0]?.value || 0;
  const maxValue = entry || 1;

  return funnelData.map((step, index) => {
    const nextStep = funnelData[index + 1];
    const reachesPct = (step.value / maxValue) * 100;
    const usersLostToNext = nextStep ? Math.max(step.value - nextStep.value, 0) : 0;
    const lossSeverity =
      step.dropOff >= 45 ? 'Critical' : step.dropOff >= 30 ? 'High' : step.dropOff >= 15 ? 'Medium' : 'Low';

    return {
      step,
      index,
      reachesPct,
      usersLostToNext,
      lossSeverity,
      nextStepLabel: nextStep?.label || null,
    };
  });
}

function getSeverity(dropOff: number): 'critical' | 'high' | 'medium' | 'low' {
  if (dropOff >= 45) return 'critical';
  if (dropOff >= 30) return 'high';
  if (dropOff >= 15) return 'medium';
  return 'low';
}

function severityStyles(level: 'critical' | 'high' | 'medium' | 'low') {
  if (level === 'critical') {
    return { badge: 'bg-gray-900 text-white border-gray-900', tone: 'text-gray-900' };
  }
  if (level === 'high') {
    return { badge: 'bg-gray-100 text-gray-800 border-gray-300', tone: 'text-gray-800' };
  }
  if (level === 'medium') {
    return { badge: 'bg-blue-50 text-blue-700 border-blue-200', tone: 'text-blue-700' };
  }
  return { badge: 'bg-white text-gray-600 border-gray-200', tone: 'text-gray-600' };
}

export default function FunnelPage() {
  const { isLoading, funnelData, selectedTenants, timeRange, topFeatures, featureActivity } = useDashboardData();
  const safeFunnelData = useMemo(() => funnelData ?? [], [funnelData]);

  const {
    entryCount,
    completedCount,
    overallConversion,
    diagnostics,
    actionableStages,
    largestLeak,
    funnelHealthScore,
    projectedRecoveredUsers,
    projectedConversion,
    averageStageDrop,
    benchmarkGap,
    stageMomentum,
    scenarios,
  } = useMemo(() => {
    const entry = safeFunnelData[0]?.value || 0;
    const completed = safeFunnelData[safeFunnelData.length - 1]?.value || 0;
    const conversion = entry > 0 ? (completed / entry) * 100 : 0;
    const dropOff = Math.max(100 - conversion, 0);
    const stageDiagnostics = buildStageDiagnostics(safeFunnelData);
    const actionable = stageDiagnostics.filter((item) => item.index < stageDiagnostics.length - 1);

    const leak = actionable.reduce(
      (worst, current) => (current.step.dropOff > worst.step.dropOff ? current : worst),
      actionable[0] || {
        step: { label: 'N/A', value: 0, dropOff: 0, color: '#1A73E8' },
        index: 0,
        reachesPct: 0,
        usersLostToNext: 0,
        lossSeverity: 'Low',
        nextStepLabel: null,
      }
    );

    const avgDrop = actionable.length > 0
      ? actionable.reduce((sum, item) => sum + item.step.dropOff, 0) / actionable.length
      : 0;

    const momentum = stageDiagnostics.length > 1
      ? stageDiagnostics.reduce((sum, stage, idx) => {
        if (idx === 0) return sum;
        const prev = stageDiagnostics[idx - 1].step.value || 1;
        return sum + (stage.step.value / prev) * 100;
      }, 0) / (stageDiagnostics.length - 1)
      : 0;

    const healthScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          conversion * 0.55 +
          Math.max(0, 100 - leak.step.dropOff) * 0.25 +
          Math.max(0, 100 - avgDrop) * 0.2,
        ),
      ),
    );
    const recovered = Math.round(leak.usersLostToNext * 0.2);
    const projectedNewCompletions = completed + recovered;
    const projected = entry > 0 ? (projectedNewCompletions / entry) * 100 : 0;

    const benchmark = 40; // operational benchmark for a healthy multi-step flow
    const gap = conversion - benchmark;

    const scenarioLevels = [10, 20, 30];
    const scenarioRows = scenarioLevels.map((improvementPct) => {
      const savedUsers = Math.round(leak.usersLostToNext * (improvementPct / 100));
      const newCompletion = completed + savedUsers;
      const newConversion = entry > 0 ? (newCompletion / entry) * 100 : 0;
      return {
        label: `${improvementPct}% leak recovery`,
        savedUsers,
        conversion: newConversion,
        uplift: Math.max(newConversion - conversion, 0),
      };
    });

    return {
      entryCount: entry,
      completedCount: completed,
      overallConversion: conversion,
      totalDropOff: dropOff,
      diagnostics: stageDiagnostics,
      actionableStages: actionable,
      largestLeak: leak,
      funnelHealthScore: healthScore,
      projectedRecoveredUsers: recovered,
      projectedConversion: projected,
      averageStageDrop: avgDrop,
      benchmarkGap: gap,
      stageMomentum: momentum,
      scenarios: scenarioRows,
    };
  }, [safeFunnelData]);

  const sortedActionableStages = useMemo(
    () => actionableStages.slice().sort((a, b) => b.step.dropOff - a.step.dropOff),
    [actionableStages]
  );

  const prioritizedActions = useMemo(() => {
    const topLeakStages = sortedActionableStages.slice(0, 3);

    return topLeakStages.map((stage, index) => {
      const severity = getSeverity(stage.step.dropOff);
      const expectedRecovery = Math.round(stage.usersLostToNext * 0.15);
      const tone = severityStyles(severity);
      return {
        id: `${stage.step.label}-${index}`,
        title: `Reduce friction at ${toTitleCase(stage.step.label)}`,
        detail: `${stage.usersLostToNext.toLocaleString()} users drop before ${toTitleCase(stage.nextStepLabel || 'next step')}`,
        severity,
        tone,
        expectedRecovery,
        dropOff: stage.step.dropOff,
      };
    });
  }, [sortedActionableStages]);

  const contextualSignals = useMemo(() => {
    const topFeature = topFeatures[0];
    const highActivity = featureActivity.filter((row) => row.level === 'High').slice(0, 2);

    const signals: Array<{ title: string; message: string }> = [];

    if (topFeature) {
      signals.push({
        title: 'Top interaction signal',
        message: `${toTitleCase(topFeature.name)} drives ${topFeature.value.toLocaleString()} events in the selected window. Consider connecting it earlier in the funnel path.`,
      });
    }

    if (highActivity.length > 0) {
      signals.push({
        title: 'High activity cluster',
        message: `${highActivity.map((item) => toTitleCase(item.feature)).join(', ')} show elevated activity. Use these as bridge actions for users before the biggest leak stage.`,
      });
    }

    if (signals.length === 0) {
      signals.push({
        title: 'Signal quality notice',
        message: 'Feature activity signals are currently limited. Increase event volume to improve recommendation precision.',
      });
    }

    return signals;
  }, [featureActivity, topFeatures]);

  const metricCards = [
    {
      label: 'Entry Users',
      value: entryCount.toLocaleString(),
      note: `${funnelData.length}-step journey`,
      color: 'bg-blue-50',
      border: 'border-gray-200 border-t-4 border-t-[#1a73e8]',
    },
    {
      label: 'Overall Conversion',
      value: formatPercent(overallConversion),
      note: `${completedCount.toLocaleString()} users reached final step`,
      color: 'bg-blue-50',
      border: 'border-gray-200 border-t-4 border-t-[#1a73e8]',
    },
    {
      label: 'Biggest Leak',
      value: `${toTitleCase(largestLeak.step.label)} (${largestLeak.step.dropOff}%)`,
      note: `${largestLeak.usersLostToNext.toLocaleString()} users lost to next stage`,
      color: 'bg-blue-50',
      border: 'border-gray-200 border-t-4 border-t-[#1a73e8]',
    },
    {
      label: 'Funnel Health Score',
      value: `${funnelHealthScore}/100`,
      note:
        funnelHealthScore >= 80
          ? 'Strong progression across stages'
          : funnelHealthScore >= 60
            ? 'Stable but with clear optimization headroom'
            : 'Urgent intervention needed at critical leaks',
      color: 'bg-blue-50',
      border: 'border-gray-200 border-t-4 border-t-[#1a73e8]',
    },
    {
      label: 'Avg Stage Drop',
      value: formatPercent(averageStageDrop),
      note: 'Mean drop-off across actionable stages',
      color: 'bg-blue-50',
      border: 'border-gray-200 border-t-4 border-t-[#1a73e8]',
    },
    {
      label: 'Stage Momentum',
      value: formatPercent(stageMomentum),
      note: 'Average transition retention between steps',
      color: 'bg-blue-50',
      border: 'border-gray-200 border-t-4 border-t-[#1a73e8]',
    },
  ];

  if (isLoading) {
    return <FunnelPageSkeleton />;
  }

  if (!funnelData || funnelData.length === 0) {
    return (
      <div className="animate-in fade-in duration-500 space-y-6">
        <section>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Funnel Analysis</h1>
          <p className="mt-1 text-sm text-gray-500">No funnel data available for the selected tenant and time range.</p>
        </section>

        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center">
          <p className="text-sm font-medium text-gray-700">No stages were returned from the funnel pipeline.</p>
          <p className="mt-2 text-sm text-gray-500">
            Try switching tenant or time range, then trigger fresh events to populate the journey.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in duration-500 space-y-6">
      <section>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Funnel Analysis</h1>
            <p className="mt-1 text-sm text-gray-500">
              Diagnose conversion drop-offs and prioritize interventions by estimated business impact.
            </p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-[#1a73e8]" />
            Dynamic insights from live funnel + feature activity signals
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-gray-500">Tenant</p>
            <p className="text-sm font-semibold text-gray-900 mt-1">{selectedTenants.map((tenant: string) => toTitleCase(tenant)).join(', ')}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-gray-500">Time Window</p>
            <p className="text-sm font-semibold text-gray-900 mt-1">{timeRange}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-gray-500">Benchmark Gap</p>
            <p className={`text-sm font-semibold mt-1 ${benchmarkGap >= 0 ? 'text-[#1a73e8]' : 'text-gray-900'}`}>
              {benchmarkGap >= 0 ? '+' : ''}{benchmarkGap.toFixed(1)} pts vs 40% baseline
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-gray-500">Projected Lift</p>
            <p className="text-sm font-semibold text-[#1a73e8] mt-1">+{Math.max(projectedConversion - overallConversion, 0).toFixed(1)} pts potential</p>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 stagger-children">
        {metricCards.map((card) => (
          <article
            key={card.label}
            className={`rounded-xl border bg-blue-50 p-4 shadow-sm ${card.border}`}
          >
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{card.label}</p>
            <p className="mt-2 text-2xl font-semibold text-gray-900">{card.value}</p>
            <p className="mt-2 text-xs text-gray-500">{card.note}</p>
          </article>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <article className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm xl:col-span-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold tracking-tight text-gray-900">Progression Map</h2>
            <p className="text-xs text-gray-500">Each bar is normalized against entry volume</p>
          </div>

          <div className="mt-6 space-y-4">
            {diagnostics.map((item) => {
              const barWidth = item.reachesPct <= 0 ? 0 : Math.max(item.reachesPct, 8);
              const stageLabel = toTitleCase(item.step.label);

              return (
                <div key={item.step.label} className="space-y-1">
                  <div className="flex items-end justify-between text-xs text-gray-500">
                    <span className="font-medium text-gray-700">Stage {item.index + 1}: {stageLabel}</span>
                    <span>{item.step.value.toLocaleString()} users ({formatPercent(item.reachesPct)})</span>
                  </div>
                  <div className="relative h-9 overflow-hidden rounded-lg border border-gray-200 bg-gray-100/80">
                    <div
                      className="h-full rounded-lg bg-linear-to-r from-[#1a73e8] to-[#4285F4] transition-all duration-700"
                      style={{ width: `${barWidth}%` }}
                    />
                    <div className="absolute inset-0 flex items-center justify-between px-3 text-xs font-medium text-orange-400">
                      <span>{stageLabel}</span>
                      {item.nextStepLabel ? <span>Drop: {item.step.dropOff}%</span> : <span>Final step</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </article>

        <article className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm xl:col-span-2">
          <h2 className="text-lg font-semibold tracking-tight text-gray-900">Leakage Matrix</h2>
          <p className="mt-1 text-xs text-gray-500">Prioritized by observed drop-off intensity</p>

          <div className="mt-5 space-y-3">
            {sortedActionableStages.map((stage) => (
              <div key={stage.step.label} className="rounded-lg border border-blue-200 bg-blue-50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-gray-900">{toTitleCase(stage.step.label)}</p>
                  <span
                    className={`rounded-full px-2.5 py-1 text-[11px] font-semibold border ${severityStyles(getSeverity(stage.step.dropOff)).badge}`}
                  >
                    {stage.lossSeverity}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-600">
                  {stage.usersLostToNext.toLocaleString()} users lost before {toTitleCase(stage.nextStepLabel || 'next step')}
                </p>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="text-gray-500">Drop-off</span>
                  <span className="font-semibold text-gray-900">{stage.step.dropOff}%</span>
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <article className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold tracking-tight text-gray-900">Executive Brief</h2>
          <p className="mt-2 text-sm text-gray-600">
            Current completion rate stands at <span className="font-semibold text-gray-900">{formatPercent(overallConversion)}</span>,
            with the largest friction observed at <span className="font-semibold text-gray-900">{toTitleCase(largestLeak.step.label)}</span>.
            If this stage drop-off improves by 20%, projections indicate <span className="font-semibold text-emerald-700">+{projectedRecoveredUsers.toLocaleString()}</span>{' '}
            recovered users and a potential conversion lift to <span className="font-semibold text-emerald-700">{formatPercent(projectedConversion)}</span>.
          </p>

          <div className="mt-4 rounded-lg border border-[#1a73e8] bg-[#1a73e8]/5 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[#1a73e8]">Estimated opportunity</p>
            <p className="mt-1 text-sm text-gray-900">
              Recovering leakage at the primary bottleneck can improve completion volume by approximately{' '}
              <span className="font-semibold">{Math.max(projectedConversion - overallConversion, 0).toFixed(1)} percentage points</span>.
            </p>
          </div>

          <div className="mt-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Scenario outlook</p>
            {scenarios.map((scenario) => (
              <div key={scenario.label} className="rounded-lg border border-gray-200 bg-white p-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{scenario.label}</p>
                  <p className="text-xs text-gray-500">+{scenario.savedUsers.toLocaleString()} recovered users</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-[#1a73e8]">{formatPercent(scenario.conversion)}</p>
                  <p className="text-xs text-gray-500">+{scenario.uplift.toFixed(1)} pts</p>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold tracking-tight text-gray-900">Recommended Experiments</h2>
          <div className="mt-4 space-y-3">
            {prioritizedActions.map((action, idx) => (
              <div key={action.id} className="rounded-lg border border-gray-200 bg-gray-100 p-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-semibold text-gray-900">{idx + 1}. {action.title}</p>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${action.tone.badge}`}>
                    {action.severity}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-600">{action.detail}</p>
                <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                  <span>Potential recovered users</span>
                  <span className="font-semibold text-[#1a73e8]">+{action.expectedRecovery.toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <article className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold tracking-tight text-gray-900 flex items-center gap-2">
            <Target className="w-4 h-4 text-[#1a73e8]" />
            Stage-by-Stage Action Board ({timeRange})
          </h2>
          <p className="mt-1 text-xs text-gray-500">Actionable leak analysis for the currently selected analytics window.</p>
          <div className="mt-4 space-y-3">
            {actionableStages.map((stage) => {
              const severity = getSeverity(stage.step.dropOff);
              const tone = severityStyles(severity);
              return (
                <div key={stage.step.label} className="rounded-lg border border-gray-200 bg-white p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-gray-900">{toTitleCase(stage.step.label)}</p>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone.badge}`}>
                      {severity}
                    </span>
                  </div>
                  <div className="mt-2 h-2 rounded-full bg-gray-100">
                    <div className="h-full rounded-full bg-[#1a73e8]" style={{ width: `${Math.min(stage.step.dropOff, 100)}%` }} />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                    <span>Drop-off {stage.step.dropOff}%</span>
                    <span>{stage.usersLostToNext.toLocaleString()} users lost</span>
                  </div>
                </div>
              );
            })}
          </div>
        </article>

        <article className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold tracking-tight text-gray-900 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-[#1a73e8]" />
            Contextual Signals
          </h2>

          <div className="mt-4 space-y-3">
            {contextualSignals.map((signal) => (
              <div key={signal.title} className="rounded-lg border border-gray-200 bg-gray-100 p-3">
                <p className="text-sm font-semibold text-gray-900">{signal.title}</p>
                <p className="mt-1 text-xs text-gray-600 leading-5">{signal.message}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-lg border border-gray-200 bg-white p-3">
            <p className="text-xs uppercase tracking-wide text-gray-500">Narrative flow</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-700">
              {diagnostics.map((item, idx) => (
                <React.Fragment key={item.step.label}>
                  <span className="rounded-md border border-gray-200 bg-gray-100 px-2 py-1">{toTitleCase(item.step.label)}</span>
                  {idx < diagnostics.length - 1 && <ArrowRight className="w-3 h-3 text-gray-400" />}
                </React.Fragment>
              ))}
            </div>
          </div>
        </article>
      </section>

      <div className="text-xs text-gray-500">
        Modeled from {funnelData.length} funnel steps in the active analytics window. Figures update with your selected tenant and time range.
      </div>
    </div>
  );
}
