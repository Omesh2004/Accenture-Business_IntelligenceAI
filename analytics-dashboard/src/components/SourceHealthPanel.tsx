'use client';

/**
 * Connected data sources: grain, cadence, SLA and how far behind each one is.
 *
 * The sources deliberately disagree on grain and cadence, an event stream, an hourly core-banking
 * batch and weekly reference data, so one global freshness number cannot gate them all.
 */

import React, { memo } from 'react';
import { Database, Clock, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { SourceHealth } from '@/types';

const CADENCE_LABEL: Record<string, string> = {
  real_time: 'Real time',
  hourly_batch: 'Hourly batch',
  weekly: 'Weekly',
};

function behindLabel(minutes: number | null) {
  if (minutes === null) return 'never loaded';
  if (minutes < 60) return `${minutes.toFixed(0)} min behind`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)} h behind`;
  return `${(minutes / 1440).toFixed(1)} d behind`;
}

function SourceHealthPanel({ sources }: { sources: SourceHealth[] }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <Database className="w-4 h-4 text-slate-400" />
          Connected sources
        </h3>
        <span className="text-xs text-slate-500">{sources.length} registered</span>
      </div>

      <div className="divide-y divide-slate-100">
        {sources.map((source) => (
          <div key={source.source_id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900 font-mono">{source.source_id}</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  grain: <span className="font-mono">{source.grain}</span>
                </p>
              </div>
              <span
                className={`shrink-0 text-xs px-2 py-0.5 rounded-full border flex items-center gap-1 ${
                  source.within_sla
                    ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                    : 'text-amber-700 bg-amber-50 border-amber-200'
                }`}
              >
                {source.within_sla ? (
                  <CheckCircle2 className="w-3 h-3" />
                ) : (
                  <AlertTriangle className="w-3 h-3" />
                )}
                {source.within_sla ? 'Within SLA' : 'Outside SLA'}
              </span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3 text-slate-400" />
                {CADENCE_LABEL[source.cadence] || source.cadence}
              </span>
              <span>SLA {source.sla_minutes} min</span>
              <span>{behindLabel(source.minutes_behind)}</span>
              <span>{source.rows_loaded.toLocaleString()} rows</span>
            </div>
          </div>
        ))}
        {sources.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-slate-400">No sources are registered for this portfolio.</p>
        )}
      </div>
    </div>
  );
}

export default memo(SourceHealthPanel);
