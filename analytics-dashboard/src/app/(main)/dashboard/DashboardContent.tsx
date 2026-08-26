'use client';

/**
 * Main Dashboard page component.
 * Assembles all dashboard widgets in a responsive grid layout.
 * Shows full skeleton only on first load (no data yet).
 *
 * Intelligence Layer additions:
 * - TrustBadge on each KPI tile
 * - AnomalyFeedPanel between traffic and AI insights
 * - Intelligence data via useIntelligenceData (separate from the 15s batch)
 */

import React from 'react';
import { useDashboardData } from '@/hooks/useDashboard';
import { useIntelligenceData } from '@/hooks/useIntelligenceData';
import { DashboardSkeleton } from '@/components/Skeletons';
import KPICard from '@/components/KPICard';
import TrafficChart from '@/components/TrafficChart';
import AIInsightsPanel from '@/components/AIInsightsPanel';
import RealTimeUsers from '@/components/RealTimeUsers';
import TopPages from '@/components/TopPages';
import DeviceBreakdownChart from '@/components/DeviceBreakdownChart';
import TopLocations from '@/components/TopLocations';
import { TrustBadge, AnomalyFeedPanel } from '@/components/intelligence';

export default function DashboardContent() {
  const {
    isLoading,
    kpiMetrics,
    secondaryKpiMetrics,
    trafficData,
    aiInsights,
    realTimeUsers,
    realTimeUsersTimestampIST,
    pagesPerMinute,
    topPages,
    deviceBreakdown,
    locations,
    selectedTenants,
    timeRange,
    changeTimeRange,
  } = useDashboardData();

  const {
    activeAnomalies,
    isAnomaliesLoading,
    getTrustStatus,
  } = useIntelligenceData();

  // Show full skeleton only on the very first load when no data exists yet
  if (isLoading && kpiMetrics.length === 0) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="animate-in fade-in duration-500 space-y-6 relative">
      {/* ═══════════ KPI METRICS ROW (with Trust Badges) ═══════════ */}
      <section id="kpi-section" aria-label="Key Performance Indicators">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {kpiMetrics.map((metric) => {
            const trustStatus = getTrustStatus(metric.id);
            return (
              <div key={metric.id} className="relative">
                <KPICard metric={metric} />
                {/* Trust badge overlay — quarantined metrics get a visible warning */}
                {trustStatus !== 'pass' && (
                  <div className="absolute top-2 right-2">
                    <TrustBadge status={trustStatus} size="sm" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ═══════════ TRAFFIC OVERVIEW + REAL-TIME ROW ═══════════ */}
      <section id="traffic-section" aria-label="Traffic Analytics">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <TrafficChart
              data={trafficData}
              timeRange={timeRange}
              onTimeRangeChange={changeTimeRange}
            />
          </div>
          <div>
            <RealTimeUsers
              activeUsers={realTimeUsers}
              pagesPerMinute={pagesPerMinute}
              timestampIST={realTimeUsersTimestampIST}
            />
          </div>
        </div>
      </section>

      {/* ═══════════ ANOMALY FEED (Intelligence Layer — Detect stage) ═══════════ */}
      <section id="anomaly-feed-section" aria-label="Anomaly Feed">
        <AnomalyFeedPanel
          anomalies={activeAnomalies}
          isLoading={isAnomaliesLoading}
        />
      </section>

      {/* ═══════════ AI INSIGHTS ═══════════ */}
      <section id="insights-section" aria-label="AI Insights">
        <AIInsightsPanel insights={aiInsights} />
      </section>

      {/* ═══════════ LOCATIONS (WORLD MAP) ═══════════ */}
      <section id="locations-section" aria-label="Geographic Distribution">
        <TopLocations data={locations} />
      </section>

      {/* ═══════════ TOP PAGES + DEVICE ═══════════ */}
      <section className="flex-col" id="detail-section" aria-label="Detailed Analytics">
        <TopPages data={topPages} />
        <div className="mt-8">
          <DeviceBreakdownChart
            data={deviceBreakdown}
            timeRangeLabel={timeRange}
            tenantLabel={selectedTenants.join(', ')}
          />
        </div>
      </section>

      {/* ═══════════ SECONDARY KPI METRICS ROW ═══════════ */}
      <section id="secondary-kpi-section" aria-label="Secondary Metrics">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {secondaryKpiMetrics.map((metric) => (
            <KPICard key={metric.id} metric={metric} />
          ))}
        </div>
      </section>
    </div>
  );
}
