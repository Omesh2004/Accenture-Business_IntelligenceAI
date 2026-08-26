'use client';

/**
 * ConfidenceBand — Intelligence Layer shared primitive #2.
 * Recharts-based forecast chart: point line + shaded prediction interval.
 * Shows visual cue when series fell back to classical model (beat_naive === false).
 */

import React, { memo } from 'react';
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
} from 'recharts';
import type { ForecastPoint } from '@/types';
import ChartContainer from '@/components/ChartContainer';

interface ConfidenceBandProps {
  /** Forecast time series data with lo/hi intervals */
  data: ForecastPoint[];
  /** Metric label for the chart title */
  metricLabel: string;
  /** Model used for this forecast */
  modelUsed?: string;
  /** Whether this forecast beat the naive baseline */
  beatNaive?: boolean;
  /** Backtest MASE score */
  mase?: number | null;
  /** Backtest CRPS score */
  crps?: number | null;
  /** Reason for falling back to classical model */
  fallbackReason?: string;
}

function ConfidenceBand({
  data,
  metricLabel,
  modelUsed,
  beatNaive = true,
  mase,
  crps,
  fallbackReason,
}: ConfidenceBandProps) {
  // Transform data so Recharts can render the shaded band between lo and hi
  const chartData = data.map((p) => ({
    date: p.date,
    actual: p.actual ?? undefined,
    forecast: p.forecast,
    interval: [p.lo, p.hi] as [number, number],
    lo: p.lo,
    hi: p.hi,
  }));

  const isEmpty = data.length === 0;

  return (
    <ChartContainer
      title={`Forecast — ${metricLabel}`}
      id={`forecast-${metricLabel.toLowerCase().replace(/\s+/g, '-')}`}
    >
      {/* Backtest scores + model info */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        {modelUsed && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-gray-100 text-gray-600 border border-gray-200">
            Model: {modelUsed}
          </span>
        )}
        {!beatNaive && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-amber-50 text-amber-700 border border-amber-200"
            title={fallbackReason || 'Foundation model did not beat seasonal-naive baseline'}
          >
            ⚠ Classical Fallback
          </span>
        )}
        {mase != null && (
          <span className="text-[11px] text-gray-500 font-medium">
            MASE: {mase.toFixed(2)}
          </span>
        )}
        {crps != null && (
          <span className="text-[11px] text-gray-500 font-medium">
            CRPS: {crps.toFixed(2)}
          </span>
        )}
      </div>

      {isEmpty ? (
        <div className="flex items-center justify-center h-48 text-sm text-gray-400">
          Forecast data will appear once the pipeline produces predictions.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: '#888' }}
              tickLine={false}
              axisLine={{ stroke: '#e5e7eb' }}
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#888' }}
              tickLine={false}
              axisLine={false}
              width={50}
            />
            <Tooltip
              contentStyle={{
                fontSize: 12,
                borderRadius: 8,
                border: '1px solid #e5e7eb',
                boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />

            {/* Prediction interval band */}
            <Area
              dataKey="hi"
              stroke="none"
              fill="#1a73e8"
              fillOpacity={0.08}
              name="Upper bound"
              legendType="none"
            />
            <Area
              dataKey="lo"
              stroke="none"
              fill="#ffffff"
              fillOpacity={1}
              name="Lower bound"
              legendType="none"
            />

            {/* Actual values (if present) */}
            <Line
              dataKey="actual"
              stroke="#374151"
              strokeWidth={2}
              dot={{ r: 2, fill: '#374151' }}
              name="Actual"
              connectNulls
            />

            {/* Forecast line — dashed if classical fallback */}
            <Line
              dataKey="forecast"
              stroke="#1a73e8"
              strokeWidth={2}
              strokeDasharray={beatNaive ? undefined : '6 3'}
              dot={false}
              name="Forecast"
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </ChartContainer>
  );
}

export default memo(ConfidenceBand);
