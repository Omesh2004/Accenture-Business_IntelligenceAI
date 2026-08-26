'use client';

/**
 * RootCauseBreakdown — Intelligence Layer shared primitive #4.
 * Dimension × contribution-share sortable table for Localize stage output.
 * Reused by Feature Analytics and Funnel Analysis drill-downs.
 */

import React, { memo, useState, useMemo } from 'react';
import { ArrowUpDown, Search, Layers } from 'lucide-react';
import type { RootCause, RootCauseCandidate } from '@/types';

interface RootCauseBreakdownProps {
  /** Root cause data for an anomaly */
  rootCause: RootCause | null;
  /** Loading state */
  isLoading?: boolean;
}

type SortKey = 'contribution_share' | 'method';
type SortDir = 'asc' | 'desc';

function RootCauseBreakdown({ rootCause, isLoading }: RootCauseBreakdownProps) {
  const [sortKey, setSortKey] = useState<SortKey>('contribution_share');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sortedCandidates = useMemo(() => {
    if (!rootCause?.candidates) return [];
    return [...rootCause.candidates].sort((a, b) => {
      const mult = sortDir === 'asc' ? 1 : -1;
      if (sortKey === 'contribution_share') {
        return mult * (a.contribution_share - b.contribution_share);
      }
      return mult * a.method.localeCompare(b.method);
    });
  }, [rootCause?.candidates, sortKey, sortDir]);

  const contributionSum = rootCause?.contributions_sum ?? 0;
  const sumHealthy = Math.abs(contributionSum - 1.0) < 0.05;

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-8 bg-gray-100 rounded" />
        ))}
      </div>
    );
  }

  if (!rootCause || rootCause.candidates.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 p-6 text-center">
        <Search className="w-5 h-5 text-gray-400 mx-auto mb-2" />
        <p className="text-sm text-gray-500">
          Root cause analysis will appear here once anomalies are localized.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header: fundamental + validation */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-gray-500" />
          <span className="text-xs font-medium text-gray-600 uppercase tracking-wider">
            Fundamental: {rootCause.fundamental}
          </span>
        </div>
        <span
          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
            sumHealthy
              ? 'bg-teal-50 text-teal-700 border-teal-200'
              : 'bg-amber-50 text-amber-700 border-amber-200'
          }`}
          title={sumHealthy ? 'Contributions sum to ~1.0' : 'Contributions do NOT sum to ~1.0 — check grain/invariants'}
        >
          Σ = {contributionSum.toFixed(3)} {sumHealthy ? '✓' : '⚠'}
        </span>
      </div>

      {/* Sortable table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left">
              <th className="pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Dimensions
              </th>
              <th
                className="pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700"
                onClick={() => handleSort('contribution_share')}
              >
                <span className="inline-flex items-center gap-1">
                  Contribution
                  <ArrowUpDown className="w-3 h-3" />
                </span>
              </th>
              <th
                className="pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700"
                onClick={() => handleSort('method')}
              >
                <span className="inline-flex items-center gap-1">
                  Method
                  <ArrowUpDown className="w-3 h-3" />
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {sortedCandidates.map((candidate: RootCauseCandidate, idx: number) => (
              <tr key={idx} className="hover:bg-gray-50 transition-colors">
                <td className="py-2 pr-4">
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(candidate.dimensions).map(([dim, val]) => (
                      <span
                        key={dim}
                        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[11px] font-medium border border-blue-100"
                      >
                        <span className="text-blue-400">{dim}:</span> {val}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="py-2 pr-4">
                  <div className="flex items-center gap-2">
                    {/* Visual bar */}
                    <div className="w-20 h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[#1a73e8] rounded-full transition-all"
                        style={{ width: `${Math.min(candidate.contribution_share * 100, 100)}%` }}
                      />
                    </div>
                    <span className="text-xs font-medium text-gray-700 tabular-nums">
                      {(candidate.contribution_share * 100).toFixed(1)}%
                    </span>
                  </div>
                </td>
                <td className="py-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
                    {candidate.method}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default memo(RootCauseBreakdown);
