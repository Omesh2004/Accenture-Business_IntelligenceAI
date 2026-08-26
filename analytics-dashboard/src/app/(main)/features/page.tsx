'use client';

import React, { useState, useEffect } from "react";
import { useDashboardData } from "@/hooks/useDashboard";
import { useIntelligenceData } from "@/hooks/useIntelligenceData";
import { FeaturePageSkeleton } from "@/components/Skeletons";
import FeatureUsageChart from "@/components/FeatureUsageChart";
import TopFeaturesChart from "@/components/TopFeaturesChart";
import FeatureHeatmap from "@/components/FeatureHeatmap";
import { AnomalyFeedPanel, RootCauseBreakdown } from "@/components/intelligence";
import { X, Loader2 } from "lucide-react";
import type { RootCause } from "@/types";

export default function FeaturesPage() {
  const { isLoading, featureUsageData, topFeatures } = useDashboardData();
  const { activeAnomalies, isAnomaliesLoading, fetchRootCauses } = useIntelligenceData();
  
  const [selectedAnomalyId, setSelectedAnomalyId] = useState<string | null>(null);
  const [rootCause, setRootCause] = useState<RootCause | null>(null);
  const [isRootCauseLoading, setIsRootCauseLoading] = useState(false);

  // Fetch root cause when an anomaly is selected
  useEffect(() => {
    if (!selectedAnomalyId) {
      setRootCause(null);
      return;
    }

    let isMounted = true;
    setIsRootCauseLoading(true);
    
    fetchRootCauses(selectedAnomalyId)
      .then((causes) => {
        if (isMounted) {
          // In a real app we might show multiple root causes, but here we just take the first
          setRootCause(causes[0] || null);
          setIsRootCauseLoading(false);
        }
      })
      .catch((error) => {
        console.error("Failed to fetch root causes:", error);
        if (isMounted) setIsRootCauseLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [selectedAnomalyId, fetchRootCauses]);

  if (isLoading) {
    return <FeaturePageSkeleton />;
  }

  return (
    <div className="animate-in fade-in duration-500 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 tracking-tight mb-6">
        Feature Analytics
      </h1>

      <div className="flex flex-col flex-1 gap-6">
        {/* Anomaly Feed (Intelligence Layer) */}
        <AnomalyFeedPanel 
          anomalies={activeAnomalies} 
          isLoading={isAnomaliesLoading} 
          onAnomalyClick={setSelectedAnomalyId}
        />

        <FeatureUsageChart data={featureUsageData} />
        <TopFeaturesChart data={topFeatures} />
      </div>

      <div className="grid grid-cols-1 gap-6">
        <FeatureHeatmap />
      </div>

      {/* Root Cause Drill-down Modal */}
      {selectedAnomalyId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/45 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => setSelectedAnomalyId(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-3xl overflow-hidden animate-in zoom-in-95 duration-200 border border-gray-200 max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-linear-to-r from-gray-50 to-white">
              <h3 className="font-semibold text-gray-900">
                Root Cause Breakdown (Localization)
              </h3>
              <button
                onClick={() => setSelectedAnomalyId(null)}
                className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            {/* Modal Body */}
            <div className="p-6 overflow-y-auto">
              {isRootCauseLoading ? (
                <div className="flex flex-col items-center justify-center py-12 space-y-3">
                  <Loader2 className="w-8 h-8 text-[#1a73e8] animate-spin" />
                  <p className="text-sm text-gray-500 font-medium animate-pulse">Running root cause localization...</p>
                </div>
              ) : rootCause ? (
                <RootCauseBreakdown rootCause={rootCause} />
              ) : (
                <div className="text-center py-12">
                  <p className="text-gray-500">No root cause data available for this anomaly.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
