'use client';

/**
 * Top Features horizontal bar chart.
 * Displays feature ranking with horizontal bars and value labels.
 */

import React, { memo } from 'react';
import ChartContainer from './ChartContainer';
import { BarDataPoint } from '@/types';

interface TopFeaturesChartProps {
  data: BarDataPoint[];
}

function TopFeaturesChart({ data }: TopFeaturesChartProps) {
  const maxValue = Math.max(...data.map((d) => d.value));

  function formatValue(value: number): string {
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return value.toString();
  }

  return (
    <ChartContainer title="Top Features" id="top-features-chart">
      <div className="space-y-4 mt-3">
        {data.map((item) => (
          <div key={item.name} className="group cursor-pointer">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm text-gray-700 font-medium group-hover:text-blue-600 transition-colors">{item.name}</span>
              <span className="text-sm text-gray-500 font-semibold group-hover:text-gray-900 transition-colors">
                {formatValue(item.value)}
              </span>
            </div>

            <div className="w-full bg-gray-100 rounded-full h-2.5 overflow-hidden">
              <div
                className="h-full rounded-full bg-blue-600 transition-all duration-700 ease-out group-hover:bg-blue-500"
                style={{
                  width: `${(item.value / maxValue) * 100}%`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </ChartContainer>
  );
}

export default memo(TopFeaturesChart);
