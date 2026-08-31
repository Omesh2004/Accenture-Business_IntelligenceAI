'use client';

/**
 * Real-Time Users widget, India IST edition.
 * Shows currently active users with a live IST clock,
 * pulsing indicator, and pages-per-minute bar chart.
 * All timestamps are localized to Asia/Kolkata (IST, UTC+5:30).
 */

import React, { memo, useEffect, useState, useCallback } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  Cell,
} from 'recharts';
import ChartContainer from './ChartContainer';
import { PagesPerMinuteDataPoint } from '@/types';

interface RealTimeUsersProps {
  activeUsers: number;
  pagesPerMinute: PagesPerMinuteDataPoint[];
  /** IST-localized timestamp string from the backend */
  timestampIST?: string | null;
}

/** Format current time as IST (Asia/Kolkata) */
function getISTTime(): string {
  return new Date().toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function getISTDate(): string {
  return new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function RealTimeUsers({ activeUsers, pagesPerMinute, timestampIST }: RealTimeUsersProps) {
  /** Animated count display */
  const [displayCount, setDisplayCount] = useState(0);
  /** Live IST clock */
  const [istTime, setIstTime] = useState(getISTTime());
  const [istDate, setIstDate] = useState(getISTDate());
  /** Pulse animation state */
  const [isPulsing, setIsPulsing] = useState(false);

  // Animate count from current to target
  useEffect(() => {
    if (activeUsers === displayCount) return;
    const steps = 30;
    const diff = activeUsers - displayCount;
    const increment = diff / steps;
    let current = displayCount;
    let step = 0;
    const interval = setInterval(() => {
      step++;
      current += increment;
      if (step >= steps) {
        setDisplayCount(activeUsers);
        clearInterval(interval);
      } else {
        setDisplayCount(Math.round(current));
      }
    }, 25);

    return () => clearInterval(interval);
  }, [activeUsers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live IST clock, ticks every second
  useEffect(() => {
    const timer = setInterval(() => {
      setIstTime(getISTTime());
      setIstDate(getISTDate());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Pulse on user count change
  useEffect(() => {
    setIsPulsing(true);
    const t = setTimeout(() => setIsPulsing(false), 1200);
    return () => clearTimeout(t);
  }, [activeUsers]);

  // Determine bar color based on value (hotter = more traffic)
  const getBarColor = useCallback((value: number, maxVal: number) => {
    const ratio = maxVal > 0 ? value / maxVal : 0;
    if (ratio > 0.75) return '#1a73e8';
    if (ratio > 0.5) return '#4285F4';
    if (ratio > 0.25) return '#8AB4F8';
    return '#C2D9FC';
  }, []);

  const last60MinutesData = pagesPerMinute.slice(-60);
  const maxPPM = Math.max(...last60MinutesData.map(p => p.value), 1);

  /** Live indicator badge */
  const LiveBadge = (
    <div className="flex items-center gap-1.5">
      <span className="relative flex h-2 w-2">
        <span
          className={`absolute inline-flex h-full w-full rounded-full bg-blue-400 ${isPulsing ? 'animate-ping' : ''}`}
          style={{ opacity: isPulsing ? 0.75 : 0 }}
        />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
      </span>
      <span className="text-[11px] font-semibold text-blue-600 uppercase tracking-wider">Live</span>
    </div>
  );

  return (
    <ChartContainer title="Real-Time Users" id="real-time-users" actions={LiveBadge}>
      {/* IST Clock + Active Users */}
      <div className="mb-5">
        {/* IST timezone badge */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-100">
              🇮🇳 IST
            </span>
            <span className="text-xs text-gray-500 font-medium tabular-nums">
              {istDate}
            </span>
          </div>
          <span className="text-sm font-semibold text-gray-700 tabular-nums tracking-tight">
            {istTime}
          </span>
        </div>

        {/* Active users count */}
        <div className="flex items-end gap-3">
          <p
            className={`text-5xl font-bold text-gray-900 tracking-tight tabular-nums transition-transform duration-300 ${isPulsing ? 'scale-105' : 'scale-100'}`}
          >
            {displayCount.toLocaleString('en-IN')}
          </p>
          <div className="pb-1.5">
            <p className="text-xs text-gray-400 font-medium leading-tight">users active</p>
            <p className="text-[10px] text-gray-400 leading-tight">in last 5 minutes</p>
          </div>
        </div>
      </div>

      {/* Pages per minute bar chart */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-gray-500 font-semibold">Pages / Minute</p>
          <p className="text-[10px] text-gray-400">Last 60 min · IST</p>
        </div>
        <div className="h-36 min-h-[128px] w-full cursor-pointer">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={last60MinutesData}
              margin={{ top: 0, right: 0, left: -20, bottom: -10 }}
            >
              <XAxis
                dataKey="hour"
                axisLine={{ stroke: '#E5E7EB', strokeWidth: 1 }}
                tickLine={{ stroke: '#E5E7EB', strokeWidth: 1 }}
                tick={{ fill: '#6B7280', fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis
                axisLine={{ stroke: '#E5E7EB', strokeWidth: 1 }}
                tickLine={{ stroke: '#E5E7EB', strokeWidth: 1 }}
                tick={{ fill: '#6B7280', fontSize: 10 }}
                domain={[0, 'auto']}
                width={25}
              />
              <Tooltip
                cursor={{ fill: 'rgba(37, 99, 235, 0.05)' }}
                contentStyle={{
                  border: '1px solid #E5E7EB',
                  borderRadius: '8px',
                  fontSize: '11px',
                  boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)',
                }}
                labelFormatter={(label: any) => `${label} IST`}
                formatter={(value: any) => [`${value} pages`, 'Activity']}
              />
              <Bar
                dataKey="value"
                radius={[3, 3, 0, 0]}
                maxBarSize={24}
              >
                {last60MinutesData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={getBarColor(entry.value, maxPPM)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </ChartContainer>
  );
}

export default memo(RealTimeUsers);
