'use client';

/**
 * useIntelligenceData — Hook for Intelligence Layer data queries.
 *
 * IMPORTANT: This is deliberately SEPARATE from useDashboard to avoid
 * adding to the 17-parallel-call hot batch that fires every 15 seconds.
 * Intelligence data uses longer stale times (60s for batch-scheduled stages)
 * and is fetched independently.
 *
 * See: skills/analytics-endpoint/SKILL.md §"The dashboard batch"
 */

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { dashboardAPI } from '@/lib/api';
import { useDashboardData } from './useDashboard';
import { useRealtimeEvents } from './useRealtimeEvents';
import type {
  TrustVerdict,
  TrustBadgeStatus,
  Anomaly,
  RootCause,
  Forecast,
  Recommendation,
} from '@/types';

/**
 * Derive the TrustBadgeStatus for a given metric from the verdicts list.
 * Returns 'quarantined' if metric is quarantined, 'flagged' if flagged, else 'pass'.
 */
function deriveTrustStatus(metricId: string, verdicts: TrustVerdict[]): TrustBadgeStatus {
  const metric = verdicts.find((v) => v.metric_id === metricId);
  if (!metric) return 'pass';
  if (metric.quarantined) return 'quarantined';
  if (metric.verdict === 'flag') return 'flagged';
  if (metric.verdict === 'halt') return 'quarantined';
  return 'pass';
}

/**
 * Central hook for all Intelligence Layer data.
 * Pages import this for trust verdicts, anomalies, forecasts, recommendations.
 */
export function useIntelligenceData() {
  const { tenantsParam, rangeParam } = useDashboardData();
  const queryClient = useQueryClient();
  const { events: realtimeEvents } = useRealtimeEvents({ maxEvents: 10 });

  // ── Trust Verdicts ──
  const { data: trustVerdicts = [], isLoading: isTrustLoading } = useQuery({
    queryKey: ['intelligence', 'trustVerdicts', tenantsParam, rangeParam],
    queryFn: () => dashboardAPI.getTrustVerdicts(tenantsParam, rangeParam),
    staleTime: 60 * 1000,       // 60s — batch-scheduled
    refetchInterval: 60 * 1000,
    retry: 0,                   // graceful degradation; don't hammer
  });

  // ── Anomalies ──
  const { data: anomalies = [], isLoading: isAnomaliesLoading } = useQuery({
    queryKey: ['intelligence', 'anomalies', tenantsParam, rangeParam],
    queryFn: () => dashboardAPI.getAnomalies(tenantsParam, rangeParam),
    staleTime: 30 * 1000,       // 30s — Detect has a streaming path
    refetchInterval: 30 * 1000,
    retry: 0,
  });

  // ── Forecasts ──
  const { data: forecasts = [], isLoading: isForecastsLoading } = useQuery({
    queryKey: ['intelligence', 'forecasts', tenantsParam],
    queryFn: () => dashboardAPI.getForecasts(tenantsParam),
    staleTime: 5 * 60 * 1000,   // 5 min — forecast is a batch job
    refetchInterval: 5 * 60 * 1000,
    retry: 0,
  });

  // ── Recommendations ──
  const { data: recommendations = [], isLoading: isRecommendationsLoading } = useQuery({
    queryKey: ['intelligence', 'recommendations', tenantsParam],
    queryFn: () => dashboardAPI.getRecommendations(tenantsParam),
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
    retry: 0,
  });

  // ── Derived: trust status lookup ──
  const getTrustStatus = useCallback(
    (metricId: string): TrustBadgeStatus => deriveTrustStatus(metricId, trustVerdicts),
    [trustVerdicts]
  );

  // ── Derived: quarantined metrics ──
  const quarantinedMetrics = useMemo(
    () => (Array.isArray(trustVerdicts) ? trustVerdicts.filter((v) => v.quarantined) : []),
    [trustVerdicts]
  );

  // ── Derived: active anomalies (fired only) ──
  const activeAnomalies = useMemo(
    () => (Array.isArray(anomalies) ? anomalies.filter((a: Anomaly) => a.status === 'fired') : []),
    [anomalies]
  );

  // ── Derived: proposed recommendations ──
  const proposedRecommendations = useMemo(
    () => (Array.isArray(recommendations) ? recommendations.filter((r: Recommendation) => r.status === 'proposed') : []),
    [recommendations]
  );

  // ── Invalidation helpers for WebSocket events ──
  const invalidateTrust = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['intelligence', 'trustVerdicts'] });
  }, [queryClient]);

  const invalidateAnomalies = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['intelligence', 'anomalies'] });
  }, [queryClient]);

  const invalidateRecommendations = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['intelligence', 'recommendations'] });
  }, [queryClient]);

  // ── Fetch root causes for a specific anomaly (on-demand, not batched) ──
  const fetchRootCauses = useCallback(
    async (anomalyId: string): Promise<RootCause[]> => {
      return queryClient.fetchQuery({
        queryKey: ['intelligence', 'rootCauses', anomalyId],
        queryFn: () => dashboardAPI.getAnomalyRootCauses(anomalyId),
        staleTime: 5 * 60 * 1000,
      });
    },
    [queryClient]
  );

  return {
    // Raw data
    trustVerdicts: Array.isArray(trustVerdicts) ? trustVerdicts : [],
    anomalies: Array.isArray(anomalies) ? anomalies : [],
    forecasts: Array.isArray(forecasts) ? forecasts : [],
    recommendations: Array.isArray(recommendations) ? recommendations : [],

    // Derived
    getTrustStatus,
    quarantinedMetrics,
    activeAnomalies,
    proposedRecommendations,

    // Loading states
    isTrustLoading,
    isAnomaliesLoading,
    isForecastsLoading,
    isRecommendationsLoading,
    isIntelligenceLoading: isTrustLoading || isAnomaliesLoading,

    // On-demand fetchers
    fetchRootCauses,

    // Invalidation (for WebSocket handlers)
    invalidateTrust,
    invalidateAnomalies,
    invalidateRecommendations,

    // Pass-through for convenience
    realtimeEvents,
  };
}
