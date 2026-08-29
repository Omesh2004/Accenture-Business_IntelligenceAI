'use client';

/**
 * Segment error boundary for the dashboard.
 *
 * Without one, a single thrown render error takes the whole app to a blank white page with no
 * message — which is what an unreachable Analytics API produced: every panel's query rejected,
 * one propagated out of render, and the sidebar, navbar and page all disappeared together.
 * A dashboard that cannot reach its API should say so and stay navigable.
 */

import { useEffect } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Dashboard segment error', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-slate-900">
              This view could not be rendered
            </h1>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              The page failed while loading its data. This is usually the Analytics API being
              unreachable rather than a problem with the data itself — nothing has been changed.
            </p>
            <p className="mt-3 break-words rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] text-slate-600">
              {error.message || 'Unknown error'}
              {error.digest ? ` (digest ${error.digest})` : ''}
            </p>
            <button
              onClick={reset}
              className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-xl bg-[#1a73e8] px-4 py-2 text-sm text-white"
            >
              <RotateCw className="h-4 w-4" />
              Try again
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
