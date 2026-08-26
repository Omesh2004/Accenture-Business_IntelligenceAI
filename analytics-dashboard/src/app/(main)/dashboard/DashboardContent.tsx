'use client';

/**
 * Main Dashboard page component.
 * Assembles all dashboard widgets in a responsive grid layout.
 * Shows full skeleton only on first load (no data yet).
 */

import React from 'react';
import { useDashboardData } from '@/hooks/useDashboard';
import { DashboardSkeleton } from '@/components/Skeletons';
import KPICard from '@/components/KPICard';
import TrafficChart from '@/components/TrafficChart';
import AIInsightsPanel from '@/components/AIInsightsPanel';
import RealTimeUsers from '@/components/RealTimeUsers';
import TopPages from '@/components/TopPages';
import DeviceBreakdownChart from '@/components/DeviceBreakdownChart';
import TopLocations from '@/components/TopLocations';

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

  // Show full skeleton only on the very first load when no data exists yet
  if (isLoading && kpiMetrics.length === 0) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="animate-in fade-in duration-500 space-y-6 relative">
      {/* ═══════════ KPI METRICS ROW ═══════════ */}
      <section id="kpi-section" aria-label="Key Performance Indicators">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {kpiMetrics.map((metric) => (
            <KPICard key={metric.id} metric={metric} />
          ))}
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
