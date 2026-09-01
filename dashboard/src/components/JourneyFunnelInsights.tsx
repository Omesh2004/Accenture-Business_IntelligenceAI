'use client';

import React, { memo } from 'react';
import ChartContainer from './ChartContainer';
import { FunnelStep } from '@/types';

interface JourneyFunnelInsightsProps {
  data: FunnelStep[];
}

function titleCase(value: string) {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

function JourneyFunnelInsights({ data }: JourneyFunnelInsightsProps) {
  const entry = data[0]?.value || 0;
  const completion = data[data.length - 1]?.value || 0;
  const overallConversion = entry > 0 ? (completion / entry) * 100 : 0;
  const stages = data.map((step, index) => {
    const next = data[index + 1];
    const transitionRate = next && step.value > 0 ? (next.value / step.value) * 100 : 0;

    return {
      ...step,
      index,
      normalized: entry > 0 ? (step.value / entry) * 100 : 0,
      nextLabel: next?.label || null,
      lostUsers: next ? Math.max(step.value - next.value, 0) : 0,
      transitionRate,
    };
  });

  const actionable = stages.filter((stage) => stage.nextLabel);
  const biggestLeak = actionable.reduce(
    (worst, stage) => (stage.dropOff > worst.dropOff ? stage : worst),
    actionable[0] || {
      label: 'N/A',
      dropOff: 0,
      lostUsers: 0,
      transitionRate: 0,
    }
  );

  return (
    <ChartContainer title="Onboarding Funnel" id="journey-funnel-intelligence">
      <p className="text-xs text-gray-500 mb-4">
        Behavioural view, from the clickstream. It follows sampled sessions through the
        onboarding steps, so its counts are smaller than the KYC Completion Rate card, which is
        computed from every loan application in core banking.
      </p>
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-lg border border-gray-200 bg-gray-100 p-3">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">Entered</p>
            <p className="num mt-1 text-xl font-semibold text-gray-900">{entry.toLocaleString()}</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-100 p-3">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">Final Step Users</p>
            <p className="num mt-1 text-xl font-semibold text-gray-900">{completion.toLocaleString()}</p>
          </div>
          <div className="rounded-lg border border-purple-200 bg-purple-50 p-3">
            <p className="text-[11px] uppercase tracking-wide text-purple-600">Overall Conversion</p>
            <p className="num mt-1 text-xl font-semibold text-purple-700">{formatPercent(overallConversion)}</p>
          </div>
        </div>

        <div className="space-y-3">
          {stages.map((stage) => {
            const width = Math.max(stage.normalized, 16);
            const isFinal = !stage.nextLabel;

            return (
              <div key={stage.label} className="space-y-1">
                <div className="flex items-center justify-between text-xs text-gray-600">
                  <span className="font-medium text-gray-700">Stage {stage.index + 1}: {titleCase(stage.label)}</span>
                  <span>{stage.value.toLocaleString()} users</span>
                </div>
                <div className="h-8 rounded-lg border border-gray-200 bg-gray-100 overflow-hidden relative">
                  <div
                    className="h-full rounded-lg bg-gradient-to-r from-[#1a73e8] to-[#4285F4]"
                    style={{ width: `${width}%` }}
                  />
                  <div className="absolute inset-0 px-3 flex items-center justify-between text-[11px] font-medium text-orange-400">
                    <span>{formatPercent(stage.normalized)} of entry</span>
                    {isFinal ? <span>Final</span> : <span>Drop-off {stage.dropOff}%</span>}
                  </div>
                </div>
                {!isFinal && (
                  <p className="text-[11px] text-gray-500">
                    Transition to {titleCase(stage.nextLabel || '')}: {formatPercent(stage.transitionRate)} | Lost users: {stage.lostUsers.toLocaleString()}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-semibold text-amber-700">Primary Risk Zone</p>
          <p className="mt-1 text-sm text-amber-900">
            Highest leak appears at {titleCase(biggestLeak.label)} with {biggestLeak.dropOff}% drop-off
            ({biggestLeak.lostUsers?.toLocaleString() || 0} users lost before the next stage).
          </p>
        </div>
      </div>
    </ChartContainer>
  );
}

export default memo(JourneyFunnelInsights);