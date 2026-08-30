"use client";

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarRange,
  ChevronDown,
  Filter,
  Layers3,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";

import ChartContainer from "./ChartContainer";
import { dashboardAPI } from "@/lib/api";
import { useDashboardData } from "@/hooks/useDashboard";

interface HeatmapSegment {
  group_key: string;
  count: number;
  percentile: number;
  level: string;
  color_scale?: string;
  color?: string;
}

interface HeatmapActivity {
  feature: string;
  total_usage: number;
  level: string;
  segments: HeatmapSegment[];
}

interface HeatmapData {
  is_compare: boolean;
  groups: string[];
  group_labels?: string[];
  activities: HeatmapActivity[];
}

function getIntensityColor(percentile: number): string {
  if (percentile <= 0) return "#f8fafc"; // almost white
  if (percentile <= 10) return "#e2e8f0"; // very light gray-blue
  if (percentile <= 20) return "#cbd5f5"; // soft blue tint
  if (percentile <= 30) return "#a5b4fc"; // light indigo
  if (percentile <= 40) return "#818cf8"; // medium indigo
  if (percentile <= 50) return "#6366f1"; // strong indigo
  if (percentile <= 60) return "#4f46e5"; // deeper
  if (percentile <= 70) return "#4338ca"; // darker
  if (percentile <= 80) return "#3730a3"; // deep indigo
  if (percentile <= 90) return "#1e3a8a"; // navy blue
  return "#020617"; // near black (extreme values)
}

function getTextColor(percentile: number): string {
  return percentile >= 30 ? "#ffffff" : "#111827";
}

function formatFallbackLabel(groupKey: string, isCompare: boolean): string {
  if (isCompare) {
    return groupKey
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  if (/^\d+$/.test(groupKey)) return `Bucket ${groupKey}`;

  const parsed = new Date(groupKey);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }

  return groupKey;
}

function renderFeatureLabel(feature: string) {
  return (
    <span className="wrap-break-word capitalize leading-tight">
      {feature.replace(/\./g, " ").replace(/_/g, " ")}
    </span>
  );
}

function FeatureHeatmap() {
  const { selectedTenants, timeRange, tenantsParam, rangeParam } =
    useDashboardData();

  const [data, setData] = useState<HeatmapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let mounted = true;

    const fetchHeatmap = async () => {
      setLoading(true);
      try {
        const result = await dashboardAPI.getFeatureHeatmap(
          tenantsParam,
          rangeParam,
        );
        if (mounted) setData(result as HeatmapData);
      } catch {
        if (mounted) setData({ is_compare: false, groups: [], activities: [] });
      } finally {
        if (mounted) setLoading(false);
      }
    };

    fetchHeatmap();

    return () => {
      mounted = false;
    };
  }, [tenantsParam, rangeParam]);

  const activities: HeatmapActivity[] = useMemo(
    () => data?.activities ?? [],
    [data?.activities],
  );
  const groups: string[] = data?.groups || [];
  const groupLabels: string[] = data?.group_labels || [];
  const isCompare = Boolean(data?.is_compare);

  const allFeatures = useMemo<string[]>(
    () => activities.map((row: HeatmapActivity) => row.feature),
    [activities],
  );

  const filteredFeatureOptions = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return allFeatures;
    return allFeatures.filter((feature: string) =>
      feature.toLowerCase().includes(term),
    );
  }, [allFeatures, searchTerm]);

  const selectedFeatureSet = useMemo(
    () => new Set(selectedFeatures),
    [selectedFeatures],
  );

  const filteredData = useMemo(() => {
    if (selectedFeatures.length === 0) return activities;
    return activities.filter((row: HeatmapActivity) =>
      selectedFeatureSet.has(row.feature),
    );
  }, [activities, selectedFeatures.length, selectedFeatureSet]);

  // Pre-index segments for O(1) cell lookups during render.
  const preparedRows = useMemo(
    () =>
      filteredData.map((row: HeatmapActivity) => ({
        ...row,
        segmentsByKey: new Map(
          row.segments.map((segment: HeatmapSegment) => [segment.group_key, segment]),
        ),
      })),
    [filteredData],
  );

  const insights = useMemo(() => {
    const totalEvents = filteredData.reduce(
      (sum: number, row: HeatmapActivity) => sum + (row.total_usage || 0),
      0,
    );
    const topFeature = filteredData[0];
    const activeRows = filteredData.filter(
      (row: HeatmapActivity) => row.total_usage > 0,
    ).length;
    const adoptionCoverage =
      filteredData.length > 0
        ? Math.round((activeRows / filteredData.length) * 100)
        : 0;

    return {
      totalEvents,
      topFeatureName: topFeature?.feature
        ? topFeature.feature.replace(/_/g, " ")
        : "No data",
      topFeatureUsage: topFeature?.total_usage || 0,
      adoptionCoverage,
    };
  }, [filteredData]);

  const toggleFeature = useCallback((feature: string) => {
    setSelectedFeatures((prev: string[]) =>
      prev.includes(feature)
        ? prev.filter((item) => item !== feature)
        : [...prev, feature],
    );
  }, []);

  const clearFilters = useCallback(() => {
    setSelectedFeatures([]);
    setSearchTerm("");
    setDropdownOpen(false);
  }, []);

  useEffect(() => {
    const handleOutsideInteraction = (event: MouseEvent | TouchEvent) => {
      if (!dropdownOpen || !dropdownRef.current) return;
      const target = event.target as Node;
      if (!dropdownRef.current.contains(target)) {
        setDropdownOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDropdownOpen(false);
      }
    };

    document.addEventListener("mousedown", handleOutsideInteraction);
    document.addEventListener("touchstart", handleOutsideInteraction);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleOutsideInteraction);
      document.removeEventListener("touchstart", handleOutsideInteraction);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [dropdownOpen]);

  const resolveGroupLabel = (groupKey: string, index: number) => {
    return groupLabels[index] || formatFallbackLabel(groupKey, isCompare);
  };

  const gridColWidth = groups.length > 0 ? `${78 / groups.length}%` : "78%";

  return (
    <ChartContainer title="Feature Adoption Heatmap" id="feature-heatmap">
      <div className="mt-2 mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-2.5">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-blue-700">
            <Layers3 className="h-3.5 w-3.5" />
            Scope
          </div>
          <p className="mt-1 wrap-break-word text-sm font-semibold text-gray-800">
            {selectedTenants.length > 0
              ? selectedTenants.join(", ").toUpperCase()
              : "NEXABANK"}
          </p>
        </div>

        <div className="rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-2.5">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-blue-700">
            <CalendarRange className="h-3.5 w-3.5" />
            Time Range
          </div>
          <p className="mt-1 text-sm font-semibold text-gray-800">
            {timeRange}
          </p>
        </div>

        <div className="rounded-lg border border-violet-100 bg-violet-50/70 px-3 py-2.5">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-violet-700">
            <Sparkles className="h-3.5 w-3.5" />
            Insight
          </div>
          <p
            className="mt-1 truncate text-sm font-semibold text-gray-800"
            title={insights.topFeatureName}
          >
            {insights.topFeatureName} (
            {insights.topFeatureUsage.toLocaleString()})
          </p>
        </div>
      </div>

      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative z-50" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen((open: boolean) => !open)}
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
              aria-expanded={dropdownOpen}
              aria-haspopup="listbox"
            >
              <Filter className="h-3.5 w-3.5 text-gray-500" />
              {selectedFeatures.length > 0
                ? `${selectedFeatures.length} selected`
                : "All Features"}
              <ChevronDown
                className={`h-3.5 w-3.5 text-gray-400 transition-transform ${dropdownOpen ? "rotate-180" : ""}`}
              />
            </button>

            {dropdownOpen && (
              <div className="absolute z-70 mt-1 w-72 rounded-lg border border-gray-200 bg-white py-1 shadow-lg" role="listbox" aria-multiselectable="true">
                <div className="border-b border-gray-100 px-2 pb-2 pt-1">
                  <input
                    value={searchTerm}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setSearchTerm(e.target.value)
                    }
                    placeholder="Search features..."
                    className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-200"
                  />
                </div>

                <div className="max-h-60 overflow-y-auto py-1">
                  {filteredFeatureOptions.map((feature) => (
                    <label
                      key={feature}
                      className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                    >
                      <input
                        type="checkbox"
                        checked={selectedFeatureSet.has(feature)}
                        onChange={() => toggleFeature(feature)}
                        className="h-3.5 w-3.5 cursor-pointer rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="truncate">{feature}</span>
                    </label>
                  ))}

                  {filteredFeatureOptions.length === 0 && (
                    <p className="px-3 py-2 text-xs text-gray-400">
                      No matching features
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {selectedFeatures.length > 0 && (
            <button
              onClick={clearFilters}
              className="flex cursor-pointer items-center gap-1 rounded-lg border border-red-100 bg-red-50 px-2 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-100"
            >
              <X className="h-3 w-3" /> Clear
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <span className="rounded-md border border-gray-200 bg-gray-100 px-2 py-1">
            {isCompare ? "Cross-tenant matrix" : "Trend matrix"}
          </span>
          <span className="rounded-md border border-gray-200 bg-gray-100 px-2 py-1">
            Coverage {insights.adoptionCoverage}%
          </span>
          <span className="rounded-md border border-gray-200 bg-gray-100 px-2 py-1">
            Total {insights.totalEvents.toLocaleString()}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center p-12 text-blue-500">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      ) : (
        <div>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-xs font-medium text-gray-500">
            <p className="text-gray-600">
              {isCompare
                ? "Tenant comparison intensity"
                : "Feature adoption across time buckets"}
            </p>
            <div className="flex items-center gap-2">
              <span>No activity</span>
              <div className="flex h-4 items-center overflow-hidden rounded-full border border-gray-200">
                <div className="h-4 w-6 bg-[#f8fafc]" />
                <div className="h-4 w-6 bg-[#e2e8f0]" />
                <div className="h-4 w-6 bg-[#cbd5f5]" />
                <div className="h-4 w-6 bg-[#a5b4fc]" />
                <div className="h-4 w-6 bg-[#818cf8]" />
                <div className="h-4 w-6 bg-[#6366f1]" />
                <div className="h-4 w-6 bg-[#4f46e5]" />
                <div className="h-4 w-6 bg-[#4338ca]" />
                <div className="h-4 w-6 bg-[#3730a3]" />
                <div className="h-4 w-6 bg-[#1e3a8a]" />
                <div className="h-4 w-6 bg-[#020617]" />
              </div>
              <span>Peak</span>
            </div>
          </div>
          <div className="relative max-w-full overflow-x-auto pb-3">
            <table className="w-full min-w-[920px] table-fixed border-collapse text-left text-sm lg:min-w-full">
              <colgroup>
                <col style={{ width: "16%" }} />
                {groups.map((groupKey) => (
                  <col
                    key={`col-${groupKey}`}
                    style={{ width: gridColWidth }}
                  />
                ))}
                <col style={{ width: "6%" }} />
              </colgroup>

              <thead className="sticky top-0 z-10">
                <tr className="bg-white/95 backdrop-blur-sm">
                  <th className="sticky left-0 z-20 border-b border-gray-100 bg-white px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-600">
                    Feature
                  </th>

                  {groups.map((groupKey, index) => (
                    <th
                      key={groupKey}
                      className="border-b border-gray-100 px-1 py-3 text-center text-[11px] font-medium text-gray-500"
                    >
                      <div className="px-1 leading-tight">
                        {resolveGroupLabel(groupKey, index)}
                      </div>
                    </th>
                  ))}

                  <th className="border-b border-gray-100 px-3 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-600">
                    Total
                  </th>
                </tr>
              </thead>

              <tbody>
                {preparedRows.map((row) => (
                  <tr key={row.feature} className="group align-middle">
                    <td className="sticky left-0 z-20 border-r border-gray-100 bg-white px-2 py-0.5 align-middle text-[13px] font-medium text-gray-800 shadow-[1px_0_0_0_rgba(229,231,235,0.45)] transition-colors group-hover:text-[#1a73e8]">
                      <div className="flex min-h-11 items-center whitespace-normal wrap-break-word">
                        {renderFeatureLabel(row.feature)}
                      </div>
                    </td>

                    {groups.map((groupKey, index) => {
                      const segment = row.segmentsByKey.get(groupKey) || {
                        group_key: groupKey,
                        count: 0,
                        percentile: 0,
                        level: "Low",
                      };

                      const pct = segment.percentile;
                      const bgColor = getIntensityColor(pct);
                      const textColor = getTextColor(pct);
                      const label = resolveGroupLabel(groupKey, index);

                      return (
                        <td key={groupKey} className="p-0">
                          <div
                            className="relative flex h-11 w-full cursor-pointer items-center justify-center border-r border-white/25 px-1 transition-all duration-150 hover:brightness-95"
                            style={{
                              backgroundColor: bgColor,
                              color: textColor,
                            }}
                            title={`${row.feature} x ${label}: ${segment.count.toLocaleString()} events (${pct}% intensity)`}
                          >
                            <span className="text-[10px] font-semibold leading-none tabular-nums drop-shadow-sm">
                              {segment.count > 0
                                ? segment.count.toLocaleString()
                                : "-"}
                            </span>
                          </div>
                        </td>
                      );
                    })}

                    <td className="align-middle border-l border-gray-100 px-3 py-2 text-right">
                      <div className="flex h-11 items-center justify-end">
                        <span className="text-xs font-mono font-semibold tabular-nums text-gray-700">
                          {row.total_usage?.toLocaleString() || 0}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {filteredData.length === 0 && (
              <div className="mt-2 rounded-lg bg-gray-100 py-12 text-center text-sm text-gray-400">
                No features match the current filter.
              </div>
            )}
          </div>
        </div>
      )}
    </ChartContainer>
  );
}

export default memo(FeatureHeatmap);
