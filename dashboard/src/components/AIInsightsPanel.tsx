'use client';

/**
 * AI Insights panel component.
 * Displays generated insights in a professional card-based layout.
 * Uses the blue/black/white design system, no colored gradients.
 */

import React, { memo, useState, useEffect } from 'react';
import { TrendingUp, AlertCircle, CheckCircle, Info, X } from 'lucide-react';
import ChartContainer from './ChartContainer';
import { AIInsight } from '@/types';

interface AIInsightsPanelProps {
  insights: AIInsight[];
}

const insightStyles: Record<string, {
  icon: React.ElementType;
  borderColor: string;
  badgeBg: string;
  badgeText: string;
  iconColor: string;
  label: string;
}> = {
  warning: {
    icon: AlertCircle,
    borderColor: 'border-gray-200',
    badgeBg: 'bg-gray-100',
    badgeText: 'text-gray-700',
    iconColor: 'text-[#1a73e8]',
    label: 'Alert',
  },
  success: {
    icon: CheckCircle,
    borderColor: 'border-gray-200',
    badgeBg: 'bg-blue-50',
    badgeText: 'text-blue-700',
    iconColor: 'text-[#1a73e8]',
    label: 'Growth',
  },
  info: {
    icon: Info,
    borderColor: 'border-gray-200',
    badgeBg: 'bg-gray-100',
    badgeText: 'text-gray-600',
    iconColor: 'text-[#4285F4]',
    label: 'Insight',
  },
};

function AIInsightsPanel({ insights }: AIInsightsPanelProps) {
  const [selectedInsight, setSelectedInsight] = useState<AIInsight | null>(null);

  const getConfidenceLabel = (insight: AIInsight): 'High' | 'Medium' | 'Low' => {
    if (insight.confidence) return insight.confidence;
    if (insight.priority === 'high') return 'High';
    if (insight.priority === 'medium') return 'Medium';
    return 'Low';
  };

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedInsight(null);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, []);

  if (!insights || insights.length === 0) {
    return (
      <ChartContainer title="AI Insights" id="ai-insights-panel">
        <div className="rounded-xl border border-dashed border-gray-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 h-10 w-10 rounded-full border border-blue-100 bg-blue-50 flex items-center justify-center">
            <Info className="h-4 w-4 text-[#1a73e8]" />
          </div>
          <p className="text-sm font-semibold text-gray-800">No stored AI insights yet.</p>
          <p className="mt-1 text-sm text-gray-500">
            Generate the AI report to populate this section with cached insights.
          </p>
        </div>
      </ChartContainer>
    );
  }

  return (
    <ChartContainer title="AI Insights" id="ai-insights-panel">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-2">
        {insights.map((insight, index) => {
          const style = insightStyles[insight.type] || insightStyles.info;
          const Icon = style.icon;
          const insightKey = `${insight.id ?? 'insight'}-${insight.type}-${index}`;
          const confidenceLabel = getConfidenceLabel(insight);

          return (
            <div
              key={insightKey}
              onClick={() => setSelectedInsight(insight)}
              className={`group relative overflow-hidden flex flex-col justify-between p-4 rounded-xl border ${style.borderColor} bg-white hover:shadow-md hover:border-blue-200 hover:-translate-y-0.5 transition-all duration-200 cursor-pointer`}
            >
              <div className="absolute left-0 top-0 h-full w-1 bg-[#1a73e8]/80 opacity-80 group-hover:opacity-100 transition-opacity" />

              <div className="flex items-center justify-between mb-3">
                <div className={`p-2 rounded-md border border-gray-100 ${style.badgeBg}`}>
                  <Icon className={`w-4 h-4 ${style.iconColor}`} />
                </div>
                <span className={`px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold tracking-wide ${style.badgeBg} ${style.badgeText}`}>
                  {style.label}
                </span>
              </div>

              <p className="text-[13px] text-gray-700 leading-relaxed line-clamp-4 pr-1">
                {insight.message}
              </p>

              <div className="flex items-center justify-between pt-3 mt-3 border-t border-gray-100">
                <div className="flex items-center gap-1.5">
                  <TrendingUp className="w-3 h-3 text-[#1a73e8]" />
                  <span className="text-[11px] text-gray-500 font-medium">Confidence: {confidenceLabel}</span>
                </div>
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity">
                  View
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Detail Modal */}
      {selectedInsight && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/45 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => setSelectedInsight(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200 border border-gray-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-linear-to-r from-blue-50 to-white">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg border border-gray-100 ${insightStyles[selectedInsight.type]?.badgeBg || insightStyles.info.badgeBg}`}>
                  {(() => {
                    const Icon = insightStyles[selectedInsight.type]?.icon || Info;
                    return <Icon className={`w-4 h-4 ${insightStyles[selectedInsight.type]?.iconColor || insightStyles.info.iconColor}`} />;
                  })()}
                </div>
                <h3 className="font-semibold text-gray-900 text-sm">
                  {insightStyles[selectedInsight.type]?.label || 'Insight'}
                </h3>
              </div>
              <button
                onClick={() => setSelectedInsight(null)}
                className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {/* Modal Body */}
            <div className="p-6">
              <p className="text-gray-700 leading-relaxed text-[14px]">
                {selectedInsight.message}
              </p>
              <div className="mt-6 flex items-center gap-2 pt-4 border-t border-gray-100">
                <TrendingUp className="w-4 h-4 text-[#1a73e8]" />
                <span className="text-sm text-gray-500 font-medium">Confidence: {getConfidenceLabel(selectedInsight)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </ChartContainer>
  );
}

export default memo(AIInsightsPanel);
