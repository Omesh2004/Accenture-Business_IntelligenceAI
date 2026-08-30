'use client';

/**
 * Reusable chart wrapper component.
 * Provides consistent card styling, title, and optional controls
 * for all chart components in the dashboard.
 */

import React, { memo, ReactNode } from 'react';

interface ChartContainerProps {
  title: string;
  children: ReactNode;
  /** Optional right-side actions/controls */
  actions?: ReactNode;
  /** Additional CSS classes */
  className?: string;
  /** Container ID for testing */
  id?: string;
  /** True when this chart is built on a dimension the producer invented rather than measured.
   *  Fed by GET /metrics/dimension_provenance, never hardcoded -- a badge that is always on
   *  teaches readers to ignore it. */
  simulated?: boolean;
  /** Why it is simulated. Shown on hover. */
  simulatedNote?: string;
}

function ChartContainer({
  title,
  children,
  actions,
  className = '',
  id,
  simulated = false,
  simulatedNote,
}: ChartContainerProps) {
  return (
    <div
      className={`bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden ${className}`}
      id={id}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2 sm:px-5 sm:pt-4 border-b border-gray-100 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-[15px] font-medium text-gray-800 tracking-tight truncate">{title}</h3>
          {simulated && (
            // Same treatment as KPICard's badge, deliberately: one visual vocabulary for
            // "this number is modelled, not measured" wherever it appears.
            <span
              title={simulatedNote || 'This chart is built on a dimension the producer generated, not measured.'}
              className="shrink-0 text-[10px] uppercase tracking-wide font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 cursor-help"
            >
              Simulated
            </span>
          )}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>

      {/* Chart Content */}
      <div className="px-4 pb-4 sm:px-8 sm:pb-5">{children}</div>
    </div>
  );
}

export default memo(ChartContainer);
