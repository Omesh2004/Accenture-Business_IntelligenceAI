"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { dashboardAPI } from "@/lib/api";
import { useDashboardData } from "@/hooks/useDashboard";
import { useRealtimeEvents } from "@/hooks/useRealtimeEvents";
import { TrendingUp, TrendingDown, Minus, Activity, Radar } from "lucide-react";
import ChartContainer from "@/components/ChartContainer";
import { PredictivePageSkeleton } from "@/components/Skeletons";

interface Prediction {
  feature_name: string;
  score: number;
  trend_score: number;
  users_pct: number;
  frequency_score: number;
  recent_7d: number;
  prev_7d: number;
  status: string;
  growth_rate?: number;
  projected_next_7d?: number;
  anomaly?: boolean;
}

export default function PredictivePage() {
  const { tenantsParam, rangeParam, selectedTenants, timeRange } =
    useDashboardData();
  const { lastEvent, isConnected } = useRealtimeEvents({ maxEvents: 1 });
  const lastRealtimeRefetchAt = useRef(0);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["predictiveAdoption", tenantsParam, rangeParam],
    queryFn: () => dashboardAPI.getPredictiveAdoption(tenantsParam, rangeParam),
    staleTime: 10 * 1000,
    refetchInterval: 10 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  useEffect(() => {
    if (!lastEvent) return;
    const now = Date.now();
    if (now - lastRealtimeRefetchAt.current < 3000) return;
    lastRealtimeRefetchAt.current = now;
    void refetch();
  }, [lastEvent, refetch]);

  const predictions: Prediction[] = useMemo(
    () => data?.predictions || [],
    [data?.predictions],
  );
  const anomalies = useMemo(
    () => predictions
      .filter((p) => p.anomaly)
      .sort((a, b) => (b.growth_rate ?? 0) - (a.growth_rate ?? 0)),
    [predictions],
  );

  const sortedPredictions = useMemo(
    () => predictions.slice().sort((a, b) => b.score - a.score),
    [predictions],
  );

  const summary = useMemo(() => {
    const total = sortedPredictions.length;
    const highAdoption = sortedPredictions.filter((p) => p.score >= 70).length;
    const atRisk = sortedPredictions.filter((p) => p.score < 40).length;
    const avgScore =
      total > 0
        ? sortedPredictions.reduce((sum, p) => sum + p.score, 0) / total
        : 0;
    const avgGrowth =
      total > 0
        ? sortedPredictions.reduce((sum, p) => sum + (p.growth_rate ?? 0), 0) /
          total
        : 0;
    const projectedTotal7d = sortedPredictions.reduce(
      (sum, p) => sum + (p.projected_next_7d ?? 0),
      0,
    );

    return {
      total,
      highAdoption,
      atRisk,
      avgScore,
      avgGrowth,
      projectedTotal7d,
    };
  }, [sortedPredictions]);

  const topUpside = useMemo(
    () =>
      sortedPredictions
        .filter((p) => p.status === "Growing" || p.score < 70)
        .slice(0, 3),
    [sortedPredictions],
  );

  const getScoreColor = (score: number) => {
    if (score >= 70) return "text-[#1a73e8]";
    if (score >= 40) return "text-gray-700";
    return "text-gray-500";
  };

  const getScoreBarColor = (score: number) => {
    if (score >= 70) return "bg-[#1a73e8]";
    if (score >= 40) return "bg-blue-400";
    return "bg-gray-300";
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "High Adoption":
        return "bg-white text-[#1a73e8] border border-[#1a73e8]/30";
      case "Growing":
        return "bg-white text-blue-600 border border-blue -300";
      default:
        return "bg-white text-gray-500 border border-gray-200";
    }
  };

  const getGrowthIcon = (rate: number) => {
    if (rate > 5) return <TrendingUp className="h-4 w-4 text-[#1a73e8]" />;
    if (rate < -5) return <TrendingDown className="h-4 w-4 text-red-500" />;
    return <Minus className="h-4 w-4 text-gray-400" />;
  };

  if (isLoading) {
    return <PredictivePageSkeleton />;
  }

  return (
    <div className="animate-in fade-in duration-500 space-y-6">
      <div className="flex justify-between items-center flex-wrap gap-4">
        <div>
          <h1 className="text-[22px] font-medium text-gray-900 tracking-tight">
            Predictive Adoption Insights
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Tenant:{" "}
            <strong className="text-gray-700">
              {selectedTenants.join(", ")}
            </strong>{" "}
            &middot; Range:{" "}
            <strong className="text-gray-700">{timeRange}</strong>
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            Score = Trend(40%) + Users(30%) + Frequency(30%)
          </p>
        </div>
        <div className="px-4 py-2 border border-[#1a73e8] bg-[#1a73e8]/5 rounded-lg text-sm flex items-center gap-3">
          <div>
            <span className="text-gray-500">Total Users:</span>{" "}
            <span className="font-bold text-[#1a73e8]">
              {data?.total_users?.toLocaleString() || 0}
            </span>
          </div>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] border ${isConnected ? "text-[#1a73e8] border-[#1a73e8]/30 bg-white" : "text-gray-500 border-gray-300 bg-white"}`}
          >
            <Activity className="h-3 w-3" />
            {isConnected ? "Realtime on" : "Realtime off"}
          </span>
          {isFetching && (
            <span className="text-[11px] text-gray-500">Refreshing...</span>
          )}
        </div>
      </div>

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <article className="rounded-xl border border-gray-200 border-t-4 border-t-[#1a73e8] bg-blue-50 p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-gray-500">
            Features Modeled
          </p>
          <p className="mt-2 text-2xl font-semibold text-gray-900">
            {summary.total}
          </p>
        </article>
        <article className="rounded-xl border border-gray-200 border-t-4 border-t-[#1a73e8] bg-blue-50 p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-gray-500">
            Average Score
          </p>
          <p className="mt-2 text-2xl font-semibold text-[#1a73e8]">
            {summary.avgScore.toFixed(1)}
          </p>
        </article>
        <article className="rounded-xl border border-gray-200 border-t-4 border-t-[#1a73e8] bg-blue-50 p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-gray-500">
            High Adoption
          </p>
          <p className="mt-2 text-2xl font-semibold text-gray-900">
            {summary.highAdoption}
          </p>
        </article>
        <article className="rounded-xl border border-gray-200 border-t-4 border-t-[#1a73e8] bg-blue-50 p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-gray-500">
            At Risk
          </p>
          <p className="mt-2 text-2xl font-semibold text-gray-900">
            {summary.atRisk}
          </p>
        </article>
        <article className="rounded-xl border border-gray-200 border-t-4 border-t-[#1a73e8] bg-blue-50 p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-gray-500">
            Projected 7d Volume
          </p>
          <p className="mt-2 text-2xl font-semibold text-gray-900">
            {summary.projectedTotal7d.toLocaleString()}
          </p>
        </article>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <article className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm xl:col-span-2">
          <h2 className="text-lg font-semibold text-gray-900 tracking-tight flex items-center gap-2">
            <Radar className="h-4 w-4 text-[#1a73e8]" />
            Opportunity Radar
          </h2>
          <p className="text-xs text-gray-500 mt-1">
            Top features with expansion headroom based on current score and
            trend.
          </p>

          <div className="mt-4 space-y-3">
            {topUpside.length > 0 ? (
              topUpside.map((p) => (
                <div
                  key={p.feature_name}
                  className="rounded-lg border border-gray-200 bg-gray-100 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-gray-900">
                      {p.feature_name}
                    </p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${getStatusBadge(p.status)}`}
                    >
                      {p.status}
                    </span>
                  </div>
                  <div className="mt-2 h-2 rounded-full bg-gray-100">
                    <div
                      className={`h-2 rounded-full ${getScoreBarColor(p.score)}`}
                      style={{
                        width: `${Math.max(8, Math.min(p.score, 100))}%`,
                      }}
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                    <span>Score {p.score}</span>
                    <span>
                      Growth {(p.growth_rate ?? 0) > 0 ? "+" : ""}
                      {p.growth_rate ?? 0}%
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-gray-500">
                No opportunity rows available yet. Send more events to improve
                forecast depth.
              </p>
            )}
          </div>
        </article>

        <article className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 tracking-tight">
            Model Pulse
          </h2>
          <div className="mt-4 space-y-3">
            <div className="rounded-lg border border-gray-200 bg-gray-100 p-3">
              <p className="text-xs uppercase tracking-wide text-gray-500">
                Average Growth
              </p>
              <p
                className={`mt-1 text-lg font-semibold ${summary.avgGrowth >= 0 ? "text-[#1a73e8]" : "text-gray-700"}`}
              >
                {summary.avgGrowth >= 0 ? "+" : ""}
                {summary.avgGrowth.toFixed(1)}%
              </p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-100 p-3">
              <p className="text-xs uppercase tracking-wide text-gray-500">
                Anomalies
              </p>
              <p className="mt-1 text-lg font-semibold text-gray-900">
                {anomalies.length}
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Spikes or dips beyond normal feature trend bands.
              </p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-100 p-3">
              <p className="text-xs uppercase tracking-wide text-gray-500">
                Confidence Notes
              </p>
              <p className="mt-1 text-xs text-gray-600 leading-5">
                Forecast stability increases with steady event cadence. Realtime
                refresh keeps this view aligned with newly ingested behavior.
              </p>
            </div>
          </div>
        </article>
      </section>

      {/* Anomaly alerts */}
      {anomalies.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white mt-6">
          {/* Header */}
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">
              Anomaly Insights
            </h3>
            <p className="text-xs text-gray-500">
              Features with unusual growth or decline
            </p>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="px-6 py-3 font-medium">Feature</th>
                  <th className="px-6 py-3 font-medium">Growth</th>
                  <th className="px-6 py-3 font-medium">Trend</th>
                  <th className="px-6 py-3 font-medium">Projected (Next 7d)</th>
                </tr>
              </thead>

              <tbody>
                {anomalies.map((a) => {
                  const growth = a.growth_rate ?? 0;

                  const trend =
                    growth > 20
                      ? "High Growth"
                      : growth < -20
                        ? "Declining"
                        : "Stable";

                  return (
                    <tr
                      key={a.feature_name}
                      className="border-b border-gray-100 bg-yellow-50  hover:bg-yellow-100 transition"
                    >
                      {/* Feature */}
                      <td className="px-6 py-4 font-medium text-gray-900">
                        {a.feature_name}
                      </td>

                      {/* Growth with bar */}
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <span
                            className={`font-medium ${
                              growth > 0
                                ? "text-blue-600"
                                : growth < 0
                                  ? "text-gray-700"
                                  : "text-gray-500"
                            }`}
                          >
                            {growth > 0 ? `+${growth}%` : `${growth}%`}
                          </span>
                        </div>
                      </td>

                      {/* Trend */}
                      <td className="px-6 py-4 text-gray-700">{trend}</td>

                      {/* Projection */}
                      <td className="px-6 py-4 text-gray-900">
                        {a.projected_next_7d
                          ? a.projected_next_7d.toLocaleString()
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Predictions table */}
      <ChartContainer
        title="Feature Adoption Predictions"
        id="predictive-table"
      >
        <div className="overflow-x-auto mt-2 scrollbar-thin scrollbar-thumb-gray-300">
          <table className="min-w-[1200px] w-full text-left text-sm text-gray-600">
            <thead className="text-[13px] text-gray-500 font-medium border-y border-gray-200 bg-gray-100/50">
              <tr>
                <th className="px-4 py-3 whitespace-nowrap font-medium">
                  Feature
                </th>
                <th className="px-4 py-3 whitespace-nowrap font-medium">
                  Score
                </th>
                <th className="px-4 py-3 whitespace-nowrap font-medium">
                  Status
                </th>
                <th className="px-4 py-3 whitespace-nowrap font-medium text-right">
                  Growth
                </th>
                <th className="px-4 py-3 whitespace-nowrap font-medium text-right">
                  Projected 7d
                </th>
                <th className="px-4 py-3 whitespace-nowrap font-medium text-right">
                  User Reach
                </th>
                <th className="px-4 py-3 whitespace-nowrap font-medium text-right">
                  Consistency
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedPredictions.map((p) => (
                <tr
                  key={p.feature_name}
                  className={`border-b border-gray-100 hover:bg-gray-100 transition-colors ${p.anomaly ? "bg-yellow-50 hover:bg-yellow-100" : ""}`}
                >
                  <td className="px-4 py-3 whitespace-nowrap font-medium text-gray-900">
                    {p.feature_name}
                    {p.anomaly && (
                      <span className="ml-1.5 text-amber-600 text-[10px] font-bold"></span>
                    )}
                  </td>
                  <td
                    className={`px-4 py-3 whitespace-nowrap font-bold text-lg ${
                      p.anomaly ? "text-yellow-600" : getScoreColor(p.score)
                    }`}
                  >
                    {p.score}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${getStatusBadge(p.status)}`}
                    >
                      {p.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-right">
                    <div className="flex items-center justify-end gap-1">
                      {getGrowthIcon(p.growth_rate ?? 0)}
                      <span
                        className={`font-mono text-xs ${(p.growth_rate ?? 0) > 0 ? "text-[#1a73e8]" : (p.growth_rate ?? 0) < 0 ? "text-red-500" : "text-gray-500"}`}
                      >
                        {(p.growth_rate ?? 0) > 0 ? "+" : ""}
                        {p.growth_rate ?? 0}%
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-right font-mono text-xs">
                    {p.projected_next_7d?.toLocaleString() ?? "—"}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-right font-mono text-xs">
                    {p.users_pct}%
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-right font-mono text-xs">
                    {p.frequency_score}%
                  </td>
                </tr>
              ))}
              {predictions.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="px-4 py-8 text-center text-gray-400"
                  >
                    No prediction data available. Ensure events are being
                    tracked.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </ChartContainer>

      {/* Score Legend */}
      <div className="flex items-center justify-evenly flex-wrap gap-4 text-xs text-gray-500 p-4 bg-white rounded-lg border border-gray-200">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 bg-[#1a73e8] rounded-full"></div>{" "}
          <strong>70-100:</strong> High Adoption
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 bg-blue-400 rounded-full"></div>{" "}
          <strong>40-69:</strong> Growing
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 bg-gray-300 rounded-full"></div>{" "}
          <strong>0-39:</strong> At Risk
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 bg-yellow-600 rounded-full"></div>
          Anomaly (&gt;50% change)
        </div>
      </div>
    </div>
  );
}
