"use client";

/**
 * Device Breakdown donut chart.
 * Displays device distribution with a clean donut/pie chart.
 * Matches the Google Analytics design with labeled segments.
 */

import React, { memo } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import ChartContainer from "./ChartContainer";
import { DeviceBreakdown, DimensionProvenance } from "@/types";

const COLORS = ["#0022e4", "#1a73e8", "#6366f1", "#3b82f6", "#2563eb"];

interface DeviceBreakdownChartProps {
  data: DeviceBreakdown[];
  timeRangeLabel?: string;
  tenantLabel?: string;
  /** Provenance of device_type, from GET /metrics/dimension_provenance. */
  provenance?: Record<string, DimensionProvenance>;
}

interface PieLabelProps {
  cx?: number;
  cy?: number;
  midAngle?: number;
  outerRadius?: number;
  percent?: number;
  name?: string;
  index?: number;
}

/** Custom tooltip */
function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{
    name: string;
    value: number;
    color?: string;
    payload?: { color?: string };
  }>;
}) {
  if (!active || !payload?.[0]) return null;

  const markerColor = payload[0].color ?? payload[0].payload?.color ?? "#8b5cf6";

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm">
      <div className="flex items-center gap-2">
        <span
          className="w-2.5 h-2.5 rounded-full"
          style={{ backgroundColor: markerColor }}
        />
        <span className="text-gray-600">{payload[0].name}:</span>
        <span className="font-semibold text-gray-900">{payload[0].value}%</span>
      </div>
    </div>
  );
}

function DeviceBreakdownChart({
  data,
  timeRangeLabel,
  tenantLabel,
  provenance,
}: DeviceBreakdownChartProps) {
  const deviceSimulated = provenance?.device_type?.simulated ?? false;
  const devicePct = provenance?.device_type?.simulated_pct ?? 0;
  const simulatedNote = `${devicePct}% of events carry a generated device_type. The producer picks one per session, so this split reflects the generator, not real devices.`;
  if (!data || data.length === 0) {
    return (
      <ChartContainer title="Device Breakdown" id="device-breakdown" simulated={deviceSimulated} simulatedNote={simulatedNote}>
        <div className="mt-3 rounded-lg border border-dashed border-gray-200 bg-gray-100 p-6 text-center">
          <p className="text-sm text-gray-600">
            No device fingerprint data found for this selection.
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {tenantLabel || "Selected tenants"} •{" "}
            {timeRangeLabel || "Selected range"}
          </p>
        </div>
      </ChartContainer>
    );
  }

  const sorted = [...data].sort((a, b) => b.value - a.value);
  const primary = sorted[0];
  const secondary = sorted[1];
  const unknownShare =
    sorted.find((d) => d.name.toLowerCase() === "unknown")?.value ?? 0;
  const concentrated = primary.value >= 70;
  const balanced = primary.value <= 45 && sorted.length >= 3;
  const confidence =
    unknownShare >= 40 ? "Low" : unknownShare >= 15 ? "Medium" : "High";

  const renderCustomizedLabel = ({
    cx,
    cy,
    midAngle,
    outerRadius,
    percent,
    name,
    index,
  }: PieLabelProps) => {
    if (
      cx === undefined ||
      cy === undefined ||
      midAngle === undefined ||
      outerRadius === undefined ||
      percent === undefined ||
      name === undefined
    ) {
      return null;
    }

    const color = COLORS[(index ?? 0) % COLORS.length];
    const radian = Math.PI / 180;

    const sx = cx + (outerRadius + 6) * Math.cos(-midAngle * radian);
    const sy = cy + (outerRadius + 6) * Math.sin(-midAngle * radian);

    const ex = cx + (outerRadius + 24) * Math.cos(-midAngle * radian);
    const ey = cy + (outerRadius + 24) * Math.sin(-midAngle * radian);

    const textX = cx + (outerRadius + 34) * Math.cos(-midAngle * radian);
    const textY = cy + (outerRadius + 34) * Math.sin(-midAngle * radian);

    return (
      <g>
        <line x1={sx} y1={sy} x2={ex} y2={ey} stroke={color} strokeWidth={1.5} />
        <text
          x={textX}
          y={textY}
          fill={color}
          textAnchor={textX > cx ? "start" : "end"}
          dominantBaseline="central"
          style={{ fontSize: "12px", fontWeight: 500 }}
        >
          {name} {(percent * 100).toFixed(0)}%
        </text>
      </g>
    );
  };

  return (
    <ChartContainer title="Device Breakdown" id="device-breakdown" simulated={deviceSimulated} simulatedNote={simulatedNote}>
      <div className="flex flex-col md:flex-row items-center md:justify-between px-8 md:items-start gap-10 w-full">
        {/* Donut chart */}
        <div className="flex-1 min-w-[180px] max-w-[300px] aspect-square">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius="35%"
                outerRadius="60%"
                paddingAngle={3}
                dataKey="value"
                labelLine={false}
                label={renderCustomizedLabel}
                isAnimationActive
                animationDuration={800}
                strokeWidth={2}
                stroke="#ffffff"
              >
                {data.map((entry, index) => (
                  <Cell className="hover:opacity-80 z-10" key={entry.name} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Legend */}
        <div className="flex-1 w-full max-w-md space-y-3">
          {/* Legend items */}
          {data.map((device, index) => (
            <div
              key={device.name}
              className="flex items-center gap-3 p-2 rounded-md hover:bg-blue-50 transition group"
            >
              <span
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: COLORS[index % COLORS.length] }}
              />

              <span className="text-sm font-medium text-gray-700 group-hover:text-blue-600 transition">
                {device.name}
              </span>

              <span className="ml-auto text-xs font-semibold text-gray-500">
                {device.value}%
              </span>
            </div>
          ))}

          {/* Insights */}
          <div className="pt-4 mt-2 border-t border-blue-100 space-y-2">
            <p className="text-xs text-gray-700 leading-relaxed">
              Dominant segment:{" "}
              <span className="font-semibold text-blue-700">
                {primary.name}
              </span>{" "}
              ({primary.value}%)
              {secondary && (
                <>
                  {" "}
                  • runner-up{" "}
                  <span className="font-semibold text-blue-700">
                    {secondary.name}
                  </span>{" "}
                  ({secondary.value}%)
                </>
              )}
            </p>

            <p className="text-xs text-gray-600">
              Pattern:{" "}
              <span className="text-gray-800 font-medium">
                {balanced
                  ? "Balanced cross-device adoption"
                  : concentrated
                    ? "Highly concentrated on one device type"
                    : "Moderately concentrated distribution"}
              </span>
            </p>

            <p className="text-xs text-gray-600">
              Data confidence:{" "}
              <span className="font-semibold text-blue-700">{confidence}</span>
              {unknownShare > 0 && (
                <span className="text-gray-400">
                  {" "}
                  ({unknownShare}% unknown)
                </span>
              )}
            </p>

            <p className="text-[11px] text-gray-400">
              {tenantLabel || "Selected tenants"} •{" "}
              {timeRangeLabel || "Selected range"}
            </p>
          </div>
        </div>
      </div>
    </ChartContainer>
  );
}

export default memo(DeviceBreakdownChart);
