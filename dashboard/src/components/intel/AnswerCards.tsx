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
import Typed from './Typed';

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

/**
 * The action text, as one card per proposed action.
 *
 * The agent sends the whole recommendation as prose ending in the standing disclaimer, and
 * splitting that on sentence boundaries turned "Nothing is executed automatically." into an
 * action card of its own -- sitting beside a real action, under a footer already saying it.
 * The lead-in goes too: the heading asks what to do and the footer says it is a proposal, so
 * "Proposed, pending approval:" repeats both.
 */
function actions(section?: AgentSection): string[] {
  return bullets(section)
    .filter((b) => !/^Nothing is executed automatically\.?$/i.test(b))
    .map((b) => b.replace(/^Proposed, pending approval:\s*/i, ''))
    .map((b) => (b ? b[0].toUpperCase() + b.slice(1) : b))
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
      className="surface flex flex-col p-5"
    >
      <span className="mb-2.5 flex items-center gap-2">
        <span className="text-[length:var(--step--1)] font-semibold"
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
  { answer, visuals, live = false }:
  { answer: AgentAnswer; visuals: AgentVisual[]; live?: boolean },
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

  // The period the finding covers, taken from the agent's own "when" section rather than
  // restating the whole opening line underneath it.
  const window = (bySlot.when?.text || '').replace(/^The movement was measured over /i, 'Measured over ');
  const what = bySlot.what_changed;
  const why = bySlot.why || bySlot.cause;
  // The agent names this slot `what_now`; `action` is accepted so an older payload
  // still renders the card rather than dropping it silently.
  const action = bySlot.what_now || bySlot.action;
  if (!what && !why && !action && !where) return null;

  // The row sizes itself to what it actually has. A single card stretched across a third of the
  // width with two empty columns beside it reads as two cards that failed to load.
  const shown = [what, why, where].filter(Boolean).length;
  const cols = shown >= 3 ? 'lg:grid-cols-3' : shown === 2 ? 'lg:grid-cols-2' : '';

  return (
    <div className="space-y-4">
      <div className={`grid grid-cols-1 items-stretch gap-4 ${cols}`}>
        {what && (
          <Card icon={fell ? ArrowDownRight : ArrowUpRight} title="What happened?">
            {pct != null && observed != null && baseline != null ? (
              <>
                <p className="num leading-none"
                   style={{ fontSize: 'var(--step-3)', fontWeight: 600,
                            color: fell ? FALL : RISE, letterSpacing: '-0.02em' }}>
                  {fell ? '-' : '+'}{Math.abs(pct).toFixed(1)}%
                </p>
                <p className="mt-2 text-[length:var(--step--1)] text-slate-600">
                  from {fmt(unit, baseline)} to {fmt(unit, observed)}
                </p>
              </>
            ) : null}
            {pct == null && (
              <p className="text-[length:var(--step--1)] leading-relaxed text-slate-600">
                <Typed text={what.text} active={live} />
              </p>
            )}
            {window && pct != null && (
              <p className="mt-3 border-t border-slate-100 pt-3 text-[length:var(--step--1)] text-slate-400">
                <Typed text={window} active={live} delay={0.2} />
              </p>
            )}
          </Card>
        )}

        {why && (
          <Card icon={Search} title="Why did it happen?" delay={0.06}>
            <ul className="space-y-1.5">
              {bullets(why).map((b, i) => (
                <li key={i} className="flex gap-2 text-[length:var(--step--1)] leading-relaxed text-slate-600">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-300" />
                  <Typed text={b} active={live} delay={0.15 + i * 0.12} />
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
                    className="flex items-baseline justify-between gap-3 text-[length:var(--step--1)]">
                  <span className="truncate text-slate-600" title={s.label}>{s.label}</span>
                  <span className="num shrink-0 font-medium" style={{ color: 'var(--brand)' }}>
                    {s.value.toFixed(1)}%
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2.5 text-[length:var(--step--1a)] text-slate-400">share of the movement, ranked</p>
          </Card>
        )}
      </div>

      {action && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.18, ease: EASE }}
          className="surface p-5"
        >
          <span className="mb-4 flex items-center gap-2">
            <span className="text-[length:var(--step--1)] font-semibold" style={{ color: 'var(--brand)' }}>
              What action should you take?
            </span>
            <ClipboardCheck className="h-3.5 w-3.5 text-slate-300" />
          </span>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {actions(action).map((b, i) => (
              <div key={i}
                   className="flex gap-3 rounded-xl border border-slate-100 bg-slate-50/60 p-4">
                <span className="icon-tile shrink-0"><TrendingUp className="h-[14px] w-[14px]" /></span>
                <p className="text-[length:var(--step--1)] leading-relaxed text-slate-600">
                  <Typed text={b} active={live} delay={0.25 + i * 0.15} />
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[length:var(--step--1a)] text-slate-400">
            Proposed only. Nothing here is executed automatically.
          </p>
        </motion.section>
      )}
    </div>
  );
}
