'use client';

/**
 * Recommendations page — Intelligence Layer Stage 5 (Decide).
 * Lists proposed actions ranked by uplift-per-cost.
 * Each recommendation has an Approve/Reject action row.
 * Approved actions show up in Governance's audit trail.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { useDashboardData } from '@/hooks/useDashboard';
import { useIntelligenceData } from '@/hooks/useIntelligenceData';
import ChartContainer from '@/components/ChartContainer';
import { ApproveRejectRow } from '@/components/intelligence';
import { ChartSkeleton } from '@/components/Skeletons';
import {
  Lightbulb,
  Filter,
  ArrowUpDown,
  TrendingUp,
  AlertCircle,
  CheckCircle,
  XCircle,
  Zap,
} from 'lucide-react';
import type { RecommendationStatus } from '@/types';

const statusFilters: { value: RecommendationStatus | 'all'; label: string; icon: React.ElementType }[] = [
  { value: 'all', label: 'All', icon: Filter },
  { value: 'proposed', label: 'Proposed', icon: Lightbulb },
  { value: 'approved', label: 'Approved', icon: CheckCircle },
  { value: 'rejected', label: 'Rejected', icon: XCircle },
  { value: 'executed', label: 'Executed', icon: Zap },
];

export default function RecommendationsPage() {
  const { tenantsParam } = useDashboardData();
  const { recommendations, isRecommendationsLoading, invalidateRecommendations } = useIntelligenceData();
  const [statusFilter, setStatusFilter] = useState<RecommendationStatus | 'all'>('all');
  const [sortByUplift, setSortByUplift] = useState(true);

  const filteredRecommendations = useMemo(() => {
    let items = statusFilter === 'all'
      ? recommendations
      : recommendations.filter((r) => r.status === statusFilter);

    if (sortByUplift) {
      items = [...items].sort((a, b) => {
        const aRatio = a.cost ? a.predicted_uplift / a.cost : a.predicted_uplift;
        const bRatio = b.cost ? b.predicted_uplift / b.cost : b.predicted_uplift;
        return bRatio - aRatio;
      });
    }

    return items;
  }, [recommendations, statusFilter, sortByUplift]);

  const handleActionComplete = useCallback((_id: string, _action: 'approve' | 'reject') => {
    // Invalidate recommendations to refetch updated statuses
    invalidateRecommendations();
  }, [invalidateRecommendations]);

  // Summary stats
  const proposedCount = recommendations.filter((r) => r.status === 'proposed').length;
  const approvedCount = recommendations.filter((r) => r.status === 'approved').length;
  const rejectedCount = recommendations.filter((r) => r.status === 'rejected').length;
  const executedCount = recommendations.filter((r) => r.status === 'executed').length;

  return (
    <div className="animate-in fade-in duration-500 space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-amber-50 border border-amber-100">
            <Lightbulb className="w-5 h-5 text-amber-600" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Recommendations</h1>
            <p className="text-sm text-gray-500">Proposed actions from the Intelligence Pipeline</p>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Proposed', count: proposedCount, icon: Lightbulb, color: 'text-amber-600 bg-amber-50 border-amber-200' },
          { label: 'Approved', count: approvedCount, icon: CheckCircle, color: 'text-teal-600 bg-teal-50 border-teal-200' },
          { label: 'Rejected', count: rejectedCount, icon: XCircle, color: 'text-red-500 bg-red-50 border-red-200' },
          { label: 'Executed', count: executedCount, icon: Zap, color: 'text-blue-600 bg-blue-50 border-blue-200' },
        ].map(({ label, count, icon: Icon, color }) => (
          <div key={label} className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              <div className={`p-1.5 rounded-md border ${color}`}>
                <Icon className="w-3.5 h-3.5" />
              </div>
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</span>
            </div>
            <span className="text-2xl font-semibold text-gray-900 tabular-nums">{count}</span>
          </div>
        ))}
      </div>

      {/* Filter + Sort Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-1.5">
          {statusFilters.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              onClick={() => setStatusFilter(value)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                statusFilter === value
                  ? 'bg-[#1a73e8] text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              <Icon className="w-3 h-3" />
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setSortByUplift(!sortByUplift)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors cursor-pointer"
        >
          <ArrowUpDown className="w-3 h-3" />
          {sortByUplift ? 'Sorted by uplift/cost' : 'Original order'}
        </button>
      </div>

      {/* Recommendations List */}
      {isRecommendationsLoading ? (
        <ChartSkeleton />
      ) : filteredRecommendations.length === 0 ? (
        <ChartContainer title="Recommendations" id="recommendations-empty">
          <div className="rounded-xl border border-dashed border-gray-200 bg-white p-12 text-center">
            <Lightbulb className="w-8 h-8 text-gray-300 mx-auto mb-4" />
            <p className="text-sm font-medium text-gray-600">
              {statusFilter === 'all' ? 'No recommendations yet' : `No ${statusFilter} recommendations`}
            </p>
            <p className="text-xs text-gray-400 mt-1">
              Recommendations will appear here once the Decide stage produces proposed actions.
            </p>
          </div>
        </ChartContainer>
      ) : (
        <div className="space-y-3">
          {filteredRecommendations.map((rec) => (
            <ApproveRejectRow
              key={rec.id}
              recommendation={rec}
              onActionComplete={handleActionComplete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
