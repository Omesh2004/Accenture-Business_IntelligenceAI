'use client';

/**
 * Feature Usage Over Time line chart.
 * Displays feature usage trends with a filled area and smooth curve.
 * Supports multi-tenant comparison by dynamically rendering lines per tenant.
 */

import React, { memo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import ChartContainer from './ChartContainer';
import { FeatureUsageDataPoint } from '@/types';

interface FeatureUsageChartProps {
  data: FeatureUsageDataPoint[];
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; dataKey: string; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm">
      <p className="text-gray-500 font-medium mb-1">{label}</p>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-gray-600 capitalize">
            {entry.dataKey.replace(/_/g, ' ')}:
          </span>
          <span className="font-semibold text-gray-900">
            {entry.value.toLocaleString()} events
          </span>
        </div>
      ))}
    </div>
  );
}

function formatYAxis(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
  return value.toString();
}

const MULTI_TENANT_COLORS = ['#1a73e8', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

function FeatureUsageChart({ data }: FeatureUsageChartProps) {
  // Dynamically detect data keys (single-tenant: 'usage', multi-tenant: 'nexabank_usage', 'safexbank_usage')
  const allKeys = Array.from(
    new Set(data.flatMap((d) => Object.keys(d).filter((k) => k !== 'date')))
  );

  const isMultiTenant = allKeys.some((k) => k.includes('_'));

  return (
    <ChartContainer title="Feature Usage Over Time" id="feature-usage-chart">
      <div className="h-64 mt-2">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
            <defs>
              {allKeys.map((key, i) => (
                <linearGradient key={key} id={`featureGrad-${key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={MULTI_TENANT_COLORS[i % MULTI_TENANT_COLORS.length]} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={MULTI_TENANT_COLORS[i % MULTI_TENANT_COLORS.length]} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>

            <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" vertical={true} horizontal={true}/>

            <XAxis
              dataKey="date"
              axisLine={{ stroke: '#E5E7EB', strokeWidth: 1 }}
              tickLine={{ stroke: '#E5E7EB', strokeWidth: 1 }}
              tick={{ fill: '#6B7280', fontSize: 12 }}
              dy={8}
            />

            <YAxis
              axisLine={{ stroke: '#E5E7EB', strokeWidth: 1 }}
              tickLine={{ stroke: '#E5E7EB', strokeWidth: 1 }}
              tick={{ fill: '#6B7280', fontSize: 12 }}
              tickFormatter={formatYAxis}
              dx={-8}
              width={55}
            />

            <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#E5E7EB', strokeWidth: 1 }} />

            {isMultiTenant && <Legend wrapperStyle={{ fontSize: 12 }} />}

            {allKeys.map((key, i) => (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                name={isMultiTenant ? key.replace(/_usage$/, '').replace(/_/g, ' ') : 'Usage'}
                stroke={MULTI_TENANT_COLORS[i % MULTI_TENANT_COLORS.length]}
                strokeWidth={2.5}
                fill={`url(#featureGrad-${key})`}
                dot={{ r: 3, stroke: MULTI_TENANT_COLORS[i % MULTI_TENANT_COLORS.length], strokeWidth: 2, fill: '#fff' }}
                activeDot={{ r: 5, stroke: MULTI_TENANT_COLORS[i % MULTI_TENANT_COLORS.length], strokeWidth: 2, fill: '#fff', cursor: 'pointer' }}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartContainer>
  );
}

export default memo(FeatureUsageChart);
