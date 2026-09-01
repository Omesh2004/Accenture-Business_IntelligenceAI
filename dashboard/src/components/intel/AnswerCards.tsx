'use client';

/**
 * An answer laid out as the four questions a reader actually arrives with: what happened, why,
 * where it concentrated, and what to do about it.
 *
 * Each card is filled from the section the agent already produced for that slot, plus the claims
 * the verifier checked. Nothing here derives a figure; where a slot has no section, the card is
 * not drawn, because an empty "Why" reads as "no cause" rather than "not asked".
 */
import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowDownRight, ArrowUpRight, ClipboardCheck, Crosshair, Search, TrendingUp,
} from 'lucide-react';
import type { AgentAnswer, AgentSection, AgentVisual } from '@/types';

const EASE = [0.22, 1, 0.36, 1] as const;
const FALL = '#f82768';
const RISE = '#0f9d76';

/** Claim values by id, so a card can show a checked figure rather than re-deriving one. */
function claimMap(answer: AgentAnswer): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of answer.evidence || []) {
    if (typeof c.value === 'number') out[c.claim_id] = c.value;
  }
  return out;
}

function unitOf(answer: AgentAnswer): string {
  return (answer.evidence || []).find((c) => c.claim_id === 'observed')?.unit || '';
}

function fmt(unit: string, v: number): string {
  if (unit === 'ratio') return `${(v * 100).toFixed(1)}%`;
  if (unit === 'percent') return `${v.toFixed(1)}%`;
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString();
  return Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3);
}

/** The prose the agent wrote for one slot, split into the bullets it was built from. */
function bullets(section?: AgentSection): string[] {
  if (!section?.text) return [];
  return section.text
    .split(/(?<=\.)\s+(?=[A-Z])/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function Card({
  icon: Icon, title, tone = 'brand', children, delay = 0,
}: {
  icon: React.ElementType; title: string; tone?: 'brand' | 'plain';
  children: React.ReactNode; delay?: number;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: EASE }}
      className="surface flex flex-col p-4"
    >
      <span className="mb-2.5 flex items-center gap-2">
        <span className="text-[12.5px] font-semibold"
              style={{ color: tone === 'brand' ? 'var(--brand)' : 'var(--color-slate-700)' }}>
          {title}
        </span>
        <Icon className="h-3.5 w-3.5 shrink-0 text-slate-300" />
      </span>
      {children}
    </motion.section>
  );
}

export default function AnswerCards(
  { answer, visuals }: { answer: AgentAnswer; visuals: AgentVisual[] },
) {
  const bySlot = useMemo(() => {
    const out: Record<string, AgentSection> = {};
    for (const s of answer.sections || []) if (s.slot) out[s.slot] = s;
    return out;
  }, [answer.sections]);

  const claims = useMemo(() => claimMap(answer), [answer]);
  const unit = unitOf(answer);
  const where = visuals.find((v) => v.kind === 'bars' && v.gate === 'localize');

  const observed = claims.observed;
  const baseline = claims.baseline;
  const pct = claims.pct_change;
  const fell = observed != null && baseline != null && observed < baseline;

  const what = bySlot.what_changed;
  const why = bySlot.why || bySlot.cause;
  // The agent names this slot `what_now`; `action` is accepted so an older payload
  // still renders the card rather than dropping it silently.
  const action = bySlot.what_now || bySlot.action;
  if (!what && !why && !action && !where) return null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {what && (
          <Card icon={fell ? ArrowDownRight : ArrowUpRight} title="What happened?">
            {pct != null && observed != null && baseline != null ? (
              <>
                <p className="num leading-none"
                   style={{ fontSize: 'var(--step-3)', fontWeight: 600,
                            color: fell ? FALL : RISE, letterSpacing: '-0.02em' }}>
                  {fell ? '-' : '+'}{Math.abs(pct).toFixed(1)}%
                </p>
                <p className="mt-2 text-[13px] text-slate-600">
                  from {fmt(unit, baseline)} to {fmt(unit, observed)}
                </p>
              </>
            ) : null}
            <p className="mt-2.5 text-[12.5px] leading-relaxed text-slate-500">{what.text}</p>
          </Card>
        )}

        {why && (
          <Card icon={Search} title="Why did it happen?" delay={0.06}>
            <ul className="space-y-1.5">
              {bullets(why).map((b, i) => (
                <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-slate-600">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-300" />
                  {b}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {where && (
          <Card icon={Crosshair} title="Where is it concentrated?" delay={0.12}>
            <ul className="space-y-2">
              {where.series.slice(0, 5).map((s, i) => (
                <li key={`${s.label}-${i}`}
                    className="flex items-baseline justify-between gap-3 text-[12.5px]">
                  <span className="truncate text-slate-600" title={s.label}>{s.label}</span>
                  <span className="num shrink-0 font-medium" style={{ color: 'var(--brand)' }}>
                    {s.value.toFixed(1)}%
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2.5 text-[11px] text-slate-400">share of the movement, ranked</p>
          </Card>
        )}
      </div>

      {action && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.18, ease: EASE }}
          className="surface p-4"
        >
          <span className="mb-3 flex items-center gap-2">
            <span className="text-[12.5px] font-semibold" style={{ color: 'var(--brand)' }}>
              What action should you take?
            </span>
            <ClipboardCheck className="h-3.5 w-3.5 text-slate-300" />
          </span>
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
            {bullets(action).map((b, i) => (
              <div key={i}
                   className="flex gap-2.5 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
                <span className="icon-tile shrink-0"><TrendingUp className="h-[14px] w-[14px]" /></span>
                <p className="text-[12px] leading-relaxed text-slate-600">{b}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-slate-400">
            Proposed only. Nothing here is executed automatically.
          </p>
        </motion.section>
      )}
    </div>
  );
}
