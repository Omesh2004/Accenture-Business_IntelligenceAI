'use client';

/**
 * VerdictChip — Intelligence Layer shared primitive #3.
 * Styled chip for pipeline verdicts: proceed / flagged / suppressed.
 * Uses teal/amber/slate palette consistent with architecture explorer.
 */

import React, { memo } from 'react';

export type VerdictValue = 'proceed' | 'flagged' | 'suppressed' | 'fired' | 'provisional';

interface VerdictChipProps {
  verdict: VerdictValue;
  /** Optional: smaller variant */
  size?: 'sm' | 'md';
}

const verdictConfig: Record<VerdictValue, {
  bg: string;
  text: string;
  border: string;
  label: string;
}> = {
  proceed: {
    bg: 'bg-teal-50',
    text: 'text-teal-700',
    border: 'border-teal-200',
    label: 'Proceed',
  },
  fired: {
    bg: 'bg-rose-50',
    text: 'text-rose-700',
    border: 'border-rose-200',
    label: 'Fired',
  },
  flagged: {
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    border: 'border-amber-200',
    label: 'Flagged',
  },
  suppressed: {
    bg: 'bg-slate-100',
    text: 'text-slate-600',
    border: 'border-slate-200',
    label: 'Suppressed',
  },
  provisional: {
    bg: 'bg-blue-50',
    text: 'text-blue-600',
    border: 'border-blue-200',
    label: 'Provisional',
  },
};

function VerdictChip({ verdict, size = 'md' }: VerdictChipProps) {
  const config = verdictConfig[verdict] || verdictConfig.flagged;
  const isSmall = size === 'sm';

  return (
    <span
      className={`inline-flex items-center rounded-full border font-semibold uppercase tracking-wider ${config.bg} ${config.text} ${config.border} ${
        isSmall ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'
      }`}
    >
      {config.label}
    </span>
  );
}

export default memo(VerdictChip);
