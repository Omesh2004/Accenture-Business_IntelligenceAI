'use client';

/**
 * TrustBadge — Intelligence Layer shared primitive #1.
 * Small pill showing trust gate status: pass (teal) / flagged (amber) / quarantined (red-slate).
 * Attachable to any metric card, chart title, or table row.
 */

import React, { memo } from 'react';
import { ShieldCheck, ShieldAlert, ShieldOff } from 'lucide-react';
import type { TrustBadgeStatus } from '@/types';

interface TrustBadgeProps {
  status: TrustBadgeStatus;
  /** Optional: show the label text alongside the icon */
  showLabel?: boolean;
  /** Optional: smaller variant for inline use in table rows */
  size?: 'sm' | 'md';
  /** Optional: tooltip text override */
  tooltip?: string;
}

const statusConfig: Record<TrustBadgeStatus, {
  icon: React.ElementType;
  bg: string;
  text: string;
  border: string;
  label: string;
  iconColor: string;
}> = {
  pass: {
    icon: ShieldCheck,
    bg: 'bg-teal-50',
    text: 'text-teal-700',
    border: 'border-teal-200',
    label: 'Verified',
    iconColor: 'text-teal-500',
  },
  flagged: {
    icon: ShieldAlert,
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    border: 'border-amber-200',
    label: 'Flagged',
    iconColor: 'text-amber-500',
  },
  quarantined: {
    icon: ShieldOff,
    bg: 'bg-red-50',
    text: 'text-red-700',
    border: 'border-red-200',
    label: 'Quarantined',
    iconColor: 'text-red-500',
  },
};

function TrustBadge({ status, showLabel = true, size = 'md', tooltip }: TrustBadgeProps) {
  const config = statusConfig[status];
  const Icon = config.icon;
  const isSmall = size === 'sm';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border ${config.bg} ${config.border} ${config.text} transition-colors ${
        isSmall ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'
      } font-semibold uppercase tracking-wider`}
      title={tooltip || config.label}
      aria-label={`Trust status: ${config.label}`}
    >
      <Icon className={`${isSmall ? 'w-2.5 h-2.5' : 'w-3 h-3'} ${config.iconColor}`} />
      {showLabel && <span>{config.label}</span>}
    </span>
  );
}

export default memo(TrustBadge);
