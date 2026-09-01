'use client';

/** The dashboard the brief asks for: the KPIs, the funnel, and the AI insight. */

import React, { useState } from 'react';
import { useDashboardData } from '@/hooks/useDashboard';
import { DashboardSkeleton } from '@/components/Skeletons';
import KPICard from '@/components/KPICard';
import TrafficChart from '@/components/TrafficChart';
import AIInsightsPanel from '@/components/AIInsightsPanel';
import JourneyFunnelInsights from '@/components/JourneyFunnelInsights';
import KpiTrends from '@/components/KpiTrends';
import PersonaLens, { type PersonaId } from '@/components/PersonaLens';

export default function DashboardContent() {
  // The lens the whole page is read through. Server-validated on every request.
  const [persona, setPersona] = useState<PersonaId>('analyst');
  const {
    isLoading,
    kpiMetrics,
    secondaryKpiMetrics,
    trafficData,
    aiInsights,
    funnelData,
    timeRange,
    changeTimeRange,
  } = useDashboardData(persona);

  if (isLoading && kpiMetrics.length === 0) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="reveal space-y-8 relative">
      <PersonaLens persona={persona} onChange={setPersona} />
      <section id="kpi-section" aria-label="Key Performance Indicators">
        <div className="reveal-stagger grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {kpiMetrics.map((metric) => (
            <KPICard key={metric.id} metric={metric} />
          ))}
        </div>
      </section>

      <section className="reveal" id="kpi-trends" aria-label="KPI Trends">
        <h3 className="mb-3">How each KPI moved</h3>
        <KpiTrends persona={persona} />
      </section>

      <section className="reveal" id="traffic-section" aria-label="Traffic Analytics">
        <TrafficChart
          data={trafficData}
          timeRange={timeRange}
          onTimeRangeChange={changeTimeRange}
        />
      </section>

      <section className="reveal" id="funnel-section" aria-label="Onboarding Funnel">
        <JourneyFunnelInsights data={funnelData} />
      </section>

      <section className="reveal" id="insights-section" aria-label="AI Insights">
        <AIInsightsPanel insights={aiInsights} />
      </section>

      <section id="secondary-kpi-section" aria-label="Secondary Metrics">
        <div className="reveal-stagger grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {secondaryKpiMetrics.map((metric) => (
            <KPICard key={metric.id} metric={metric} />
          ))}
        </div>
      </section>
    </div>
  );
}
