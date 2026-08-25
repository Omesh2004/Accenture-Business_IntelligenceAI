'use client';

/**
 * AnomalyFeedPanel — Intelligence Layer shared primitive #7.
 * Live anomaly feed for the Dashboard overview.
 * Populated from the Detect stage streaming path + WebSocket.
 */

import React, { memo } from 'react';
import { AlertTriangle, TrendingUp, TrendingDown, Zap, Clock } from 'lucide-react';
import ChartContainer from '@/components/ChartContainer';
import TrustBadge from './TrustBadge';
import VerdictChip from './VerdictChip';
import type { Anomaly, TrustBadgeStatus } from '@/types';

interface AnomalyFeedPanelProps {
  /** Anomalies from the Detect stage */
  anomalies: Anomaly[];
  /** Loading state */
  isLoading?: boolean;
  /** Callback when an anomaly is clicked (for drill-down) */
  onAnomalyClick?: (anomalyId: string) => void;
}

const deviationIcons: Record<string, React.ElementType> = {
  spike: TrendingUp,
  dip: TrendingDown,
  level_shift: Zap,
  trend_change: TrendingUp,
};

function formatTimeAgo(dateStr: string): string {
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return dateStr;
  }
}

function AnomalyFeedPanel({ anomalies, isLoading, onAnomalyClick }: AnomalyFeedPanelProps) {
  if (isLoading) {
    return (
      <ChartContainer title="Anomaly Feed" id="anomaly-feed-panel">
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse h-16 bg-gray-100 rounded-lg" />
          ))}
        </div>
      </ChartContainer>
    );
  }

  if (!anomalies || anomalies.length === 0) {
    return (
      <ChartContainer title="Anomaly Feed" id="anomaly-feed-panel">
        <div className="rounded-xl border border-dashed border-gray-200 bg-white p-6 text-center">
          <div className="mx-auto mb-3 h-10 w-10 rounded-full border border-gray-100 bg-gray-50 flex items-center justify-center">
            <AlertTriangle className="h-4 w-4 text-gray-400" />
          </div>
          <p className="text-sm font-medium text-gray-600">No anomalies detected</p>
          <p className="mt-1 text-xs text-gray-400">
            Anomalies will appear here in real-time once the Detect stage is active.
          </p>
        </div>
      </ChartContainer>
    );
  }

  return (
    <ChartContainer title="Anomaly Feed" id="anomaly-feed-panel">
      <div className="space-y-2 max-h-[400px] overflow-y-auto custom-scrollbar">
        {anomalies.map((anomaly) => {
          const DevIcon = deviationIcons[anomaly.deviation_type] || AlertTriangle;
          const trustStatus: TrustBadgeStatus = anomaly.trust_status || 'pass';

          return (
            <div
              key={anomaly.id}
              onClick={() => onAnomalyClick?.(anomaly.id)}
              className="group flex items-start gap-3 p-3 rounded-lg border border-gray-100 bg-white hover:border-blue-200 hover:shadow-sm transition-all duration-200 cursor-pointer"
            >
              {/* Icon */}
              <div className={`p-2 rounded-lg shrink-0 ${
                anomaly.deviation_type === 'spike' ? 'bg-rose-50' :
                anomaly.deviation_type === 'dip' ? 'bg-blue-50' :
                'bg-amber-50'
              }`}>
                <DevIcon className={`w-4 h-4 ${
                  anomaly.deviation_type === 'spike' ? 'text-rose-500' :
                  anomaly.deviation_type === 'dip' ? 'text-blue-500' :
                  'text-amber-500'
                }`} />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-gray-900 truncate">
                    {anomaly.metric_label}
                  </span>
                  <TrustBadge status={trustStatus} showLabel={false} size="sm" />
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  <VerdictChip
                    verdict={anomaly.status === 'fired' ? 'fired' : anomaly.status === 'suppressed' ? 'suppressed' : 'provisional'}
                    size="sm"
                  />
                  <span className="tabular-nums">z={anomaly.z_score.toFixed(2)}</span>
                  <span className="tabular-nums">Δ={anomaly.effect_size.toFixed(2)}</span>
                  {anomaly.persistence_count > 1 && (
                    <span className="text-amber-600">×{anomaly.persistence_count}</span>
                  )}
                </div>
              </div>

              {/* Timestamp */}
              <div className="flex items-center gap-1 text-[11px] text-gray-400 shrink-0">
                <Clock className="w-3 h-3" />
                <span>{formatTimeAgo(anomaly.detected_at)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </ChartContainer>
  );
}

export default memo(AnomalyFeedPanel);
