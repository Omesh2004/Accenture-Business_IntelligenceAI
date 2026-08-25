'use client';

/**
 * ApproveRejectRow — Intelligence Layer shared primitive #5.
 * Action row for recommendations with Approve/Reject buttons + required comment.
 * Wires to the approve/reject API methods. Shows category chip.
 */

import React, { memo, useState, useCallback } from 'react';
import { Check, X, Loader2, MessageSquare } from 'lucide-react';
import { dashboardAPI } from '@/lib/api';
import type { Recommendation, RecommendationCategory } from '@/types';

interface ApproveRejectRowProps {
  recommendation: Recommendation;
  /** Callback after successful action */
  onActionComplete?: (id: string, action: 'approve' | 'reject') => void;
}

const categoryStyles: Record<RecommendationCategory, { bg: string; text: string; border: string }> = {
  business: { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200' },
  engineering: { bg: 'bg-cyan-50', text: 'text-cyan-700', border: 'border-cyan-200' },
};

function ApproveRejectRow({ recommendation, onActionComplete }: ApproveRejectRowProps) {
  const [comment, setComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showCommentField, setShowCommentField] = useState(false);
  const [pendingAction, setPendingAction] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = comment.trim().length > 0 && !isSubmitting;

  const handleInitiateAction = useCallback((action: 'approve' | 'reject') => {
    setPendingAction(action);
    setShowCommentField(true);
    setError(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!pendingAction || !comment.trim()) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const result = pendingAction === 'approve'
        ? await dashboardAPI.approveRecommendation(recommendation.id, comment.trim())
        : await dashboardAPI.rejectRecommendation(recommendation.id, comment.trim());

      if (result.status === 'error') {
        setError(`Failed to ${pendingAction} recommendation.`);
      } else {
        setShowCommentField(false);
        setComment('');
        setPendingAction(null);
        onActionComplete?.(recommendation.id, pendingAction);
      }
    } catch {
      setError(`Failed to ${pendingAction} recommendation.`);
    } finally {
      setIsSubmitting(false);
    }
  }, [pendingAction, comment, recommendation.id, onActionComplete]);

  const handleCancel = useCallback(() => {
    setShowCommentField(false);
    setComment('');
    setPendingAction(null);
    setError(null);
  }, []);

  const isActioned = recommendation.status === 'approved' || recommendation.status === 'rejected' || recommendation.status === 'executed';
  const catStyle = categoryStyles[recommendation.category] || categoryStyles.business;

  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white hover:border-gray-300 transition-colors">
      {/* Action description + category */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-900">{recommendation.action}</p>
          <p className="text-xs text-gray-500 mt-0.5">{recommendation.context}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${catStyle.bg} ${catStyle.text} ${catStyle.border}`}>
            {recommendation.category}
          </span>
          <span className="text-xs font-medium text-gray-400 tabular-nums">
            #{recommendation.rank}
          </span>
        </div>
      </div>

      {/* Uplift + cost info */}
      <div className="flex items-center gap-4 text-xs text-gray-500 mb-3">
        <span>
          Uplift: <span className="font-medium text-gray-700">{recommendation.predicted_uplift.toFixed(1)}%</span>
          <span className="text-gray-400 ml-1">
            ({recommendation.predicted_uplift_lo.toFixed(1)}–{recommendation.predicted_uplift_hi.toFixed(1)}%)
          </span>
        </span>
        {recommendation.cost != null && (
          <span>
            Cost: <span className="font-medium text-gray-700">${recommendation.cost.toLocaleString()}</span>
          </span>
        )}
        {recommendation.owner_role && (
          <span>
            Owner: <span className="font-medium text-gray-700">{recommendation.owner_role}</span>
          </span>
        )}
      </div>

      {/* Status or action buttons */}
      {isActioned ? (
        <div className={`flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-md ${
          recommendation.status === 'approved'
            ? 'bg-teal-50 text-teal-700'
            : recommendation.status === 'rejected'
              ? 'bg-red-50 text-red-600'
              : 'bg-blue-50 text-blue-700'
        }`}>
          {recommendation.status === 'approved' && <Check className="w-3.5 h-3.5" />}
          {recommendation.status === 'rejected' && <X className="w-3.5 h-3.5" />}
          <span className="capitalize">{recommendation.status}</span>
          {recommendation.approved_by && (
            <span className="text-gray-400 ml-1">by {recommendation.approved_by}</span>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {!showCommentField ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleInitiateAction('approve')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-teal-50 text-teal-700 border border-teal-200 hover:bg-teal-100 transition-colors cursor-pointer"
              >
                <Check className="w-3.5 h-3.5" />
                Approve
              </button>
              <button
                onClick={() => handleInitiateAction('reject')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                Reject
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <MessageSquare className="w-3.5 h-3.5" />
                <span>
                  Comment required to <span className={pendingAction === 'approve' ? 'text-teal-700 font-medium' : 'text-red-600 font-medium'}>{pendingAction}</span>:
                </span>
              </div>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={`Reason for ${pendingAction}ing this recommendation...`}
                className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-300"
                rows={2}
                disabled={isSubmitting}
              />
              {error && (
                <p className="text-xs text-red-500">{error}</p>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                    pendingAction === 'approve'
                      ? 'bg-teal-600 text-white hover:bg-teal-700 disabled:bg-teal-300'
                      : 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300'
                  } disabled:cursor-not-allowed`}
                >
                  {isSubmitting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : pendingAction === 'approve' ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : (
                    <X className="w-3.5 h-3.5" />
                  )}
                  Confirm {pendingAction}
                </button>
                <button
                  onClick={handleCancel}
                  disabled={isSubmitting}
                  className="px-3 py-1.5 rounded-md text-xs font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors cursor-pointer disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(ApproveRejectRow);
