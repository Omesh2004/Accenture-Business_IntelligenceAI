'use client';

/**
 * The agent's reasoning and its finding, side by side, as they happen.
 *
 * The layout is the argument. On the left the agent reasons; on the right the evidence it is
 * reasoning FROM lands as it is produced. Those two run at the same time because they happen at
 * the same time, a workspace that only fills after the answer arrives reduces the reasoning to a
 * loading screen, and reading the conclusion before its evidence is the wrong order to think in.
 *
 * Four surfaces, each load-bearing:
 *
 *   REASONING: the reason/validate steps in the agent's own words. "Read as a general question
 *                about the business, so the whole portfolio is ranked"; "usable, but the question
 *                also asks for a recommendation, continuing". This is where the agent explains
 *                its own control flow, and it is the only place a reader can audit that.
 *   CALLS    : one terminal line per capability, with its arguments, its result, the gate it
 *                answered for and the table it read.
 *   WORKSPACE: the result sets and charts, numbered so a reader can refer back to them. Built
 *                from the same observations as the prose, so a bar and a sentence cannot disagree.
 *   FINDING  : what changed, when, why, what to do now.
 *
 * Motion is Framer Motion with one shared easing (theme.EASE); GSAP drives the two things a spring
 * cannot do well: a counted-up headline figure and the pipeline rail drawing itself left to
 * right. Both are suppressed under prefers-reduced-motion.
 */

import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import gsap from 'gsap';
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
} from 'recharts';
import {
  Check,
  ChevronDown,
  Database,
  Loader2,
  MinusCircle,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { EASE, FONT, GATE_COLOR, INK, RANK_SCALE, SLOT_COLOR, compact, step } from './intel/theme';
import type {
  AgentDataset,
  AgentGate,
  AgentSection,
  AgentStep,
  AgentVisual,
  EvidenceClaim,
} from '@/types';

/* ── headline ────────────────────────────────────────────────────────────────────────────── */

/** A figure that counts up to its value. GSAP, because this is a tween over a number, not a layout. */
function Counter({ value, className, style }: { value: number; className?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced) {
      el.textContent = compact(value);
      return;
    }
    const box = { n: 0 };
    const tween = gsap.to(box, {
      n: value,
      duration: 1.05,
      ease: 'power2.out',
      onUpdate: () => {
        el.textContent = compact(box.n);
      },
    });
    return () => {
      tween.kill();
    };
  }, [value, reduced]);

  return <span ref={ref} className={className} style={style} />;
}

function HeroFinding({
  kpiName,
  delta,
  gates,
}: {
  kpiName: string;
  delta?: AgentVisual;
  gates: AgentGate[];
}) {
  if (!delta) return null;
  const [expected, observed] = delta.series;
  const rose = observed.value >= expected.value;
  const pct = typeof delta.pct_change === 'number' ? delta.pct_change : null;
  const engaged = gates.filter((g) => g.status === 'engaged').length;

  return (
    <motion.header
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE }}
      className="border-b px-6 pt-6 pb-5"
      style={{ borderColor: INK.hairline }}
    >
      <p
        className="text-[10.5px] tracking-[0.2em] uppercase"
        style={{ color: INK.textFaint, fontFamily: FONT.sans }}
      >
        {kpiName || 'Finding'}
      </p>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Counter
          value={observed.value}
          className="text-[42px] leading-none tracking-tight"
          style={{ color: INK.text, fontFamily: FONT.mono, fontVariantNumeric: 'tabular-nums' }}
        />
        {pct !== null && (
          <motion.span
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.5, duration: 0.34, ease: EASE }}
            className="rounded-full px-2.5 py-1 text-[12.5px] font-semibold"
            style={{
              color: rose ? INK.positive : INK.danger,
              background: rose ? INK.positiveSoft : INK.dangerSoft,
            }}
          >
            {rose ? '▲' : '▼'} {Math.abs(pct)}%
          </motion.span>
        )}
      </div>

      <p className="mt-2 text-[13px]" style={{ color: INK.textSoft }}>
        against an expected{' '}
        <span style={{ fontFamily: FONT.mono, color: INK.text }}>{compact(expected.value)}</span>
        {delta.unit ? ` · ${delta.unit}` : ''}
        {delta.subtitle ? ` · ${delta.subtitle}` : ''}
      </p>

      <p className="mt-1 text-[11px]" style={{ color: INK.textFaint, fontFamily: FONT.mono }}>
        {engaged} gates engaged · {delta.source}
      </p>
    </motion.header>
  );
}

/* ── pipeline rail ───────────────────────────────────────────────────────────────────────── */
export function GateRail({ gates, active, pad = 'px-6' }:
                         { gates: AgentGate[]; active?: string; pad?: string }) {
  const [open, setOpen] = useState('');
  const trackRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const engaged = gates.filter((g) => g.status === 'engaged').length;

  // The rail draws itself to the proportion of gates that ran. GSAP owns it because the target
  // changes mid-stream as gates land, and a re-triggered CSS transition stutters where a tween
  // retargets smoothly.
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el || !gates.length) return;
    const pct = (engaged / gates.length) * 100;
    if (reduced) {
      el.style.width = `${pct}%`;
      return;
    }
    const tween = gsap.to(el, { width: `${pct}%`, duration: 0.7, ease: 'power3.out' });
    return () => {
      tween.kill();
    };
  }, [engaged, gates.length, reduced]);

  if (!gates.length) return null;

  return (
    <div className={`${pad} pt-5`}>
      <div className="mb-2.5 flex items-center gap-2">
        <span
          className="text-[10px] tracking-[0.2em] uppercase"
          style={{ color: INK.textFaint, fontFamily: FONT.sans }}
        >
          Pipeline
        </span>
        <span className="ml-auto text-[10px]" style={{ color: INK.textFaint, fontFamily: FONT.mono }}>
          {engaged}/{gates.length}
        </span>
      </div>

      <div className="relative mb-3 h-px w-full" style={{ background: INK.hairline }}>
        <div ref={trackRef} className="absolute inset-y-0 left-0" style={{ background: INK.positive, width: 0 }} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {gates.map((gate, i) => {
          const running = active === gate.id;
          const color = GATE_COLOR[gate.status] || GATE_COLOR.idle;
          return (
            <motion.button
              key={gate.id}
              type="button"
              data-testid={`gate-${gate.id}`}
              data-status={gate.status}
              title={gate.question}
              onClick={() => setOpen((v) => (v === gate.id ? '' : gate.id))}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: step(i, 40, 320), duration: 0.3, ease: EASE }}
              whileHover={{ y: -1 }}
              className="flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1"
              style={{
                borderColor: gate.status === 'engaged' ? INK.hairlineStrong : INK.hairline,
                background: gate.status === 'engaged' ? INK.surface : 'transparent',
              }}
            >
              <motion.span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: running ? INK.accent : color }}
                animate={running ? { opacity: [0.35, 1, 0.35] } : { opacity: 1 }}
                transition={running ? { duration: 1.3, repeat: Infinity } : undefined}
              />
              <span
                className="text-[10.5px] whitespace-nowrap"
                style={{
                  color:
                    gate.status === 'engaged'
                      ? INK.text
                      : gate.status === 'restricted'
                        ? INK.danger
                        : INK.textFaint,
                }}
              >
                {gate.label}
              </span>
            </motion.button>
          );
        })}
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.26, ease: EASE }}
            className="overflow-hidden"
          >
            {(() => {
              const g = gates.find((x) => x.id === open);
              if (!g) return null;
              return (
                <div
                  className="mt-2.5 rounded-xl border px-3 py-2.5"
                  style={{ borderColor: INK.hairline, background: INK.sunken }}
                >
                  <p className="text-[12px]" style={{ color: INK.text }}>
                    {g.question}
                  </p>
                  <p
                    className="mt-1 text-[11.5px] leading-[1.55]"
                    style={{ color: g.status === 'restricted' ? INK.danger : INK.textSoft }}
                  >
                    {g.status === 'engaged' || g.status === 'failed'
                      ? g.detail
                      : g.status === 'restricted'
                        ? `Withheld: ${g.detail}.`
                        : `Not engaged: ${g.detail}.`}
                  </p>
                </div>
              );
            })()}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── reasoning ───────────────────────────────────────────────────────────────────────────── */

/** Seconds since the run began, ticking. A trail with no clock reads as frozen when a stage is slow. */
function Elapsed({ running }: { running: boolean }) {
  const [ms, setMs] = useState(0);
  const started = useRef<number>(0);

  useEffect(() => {
    if (!running) return;
    started.current = performance.now();
    setMs(0);
    const id = window.setInterval(() => setMs(performance.now() - started.current), 100);
    return () => window.clearInterval(id);
  }, [running]);

  if (!running) return null;
  return (
    <span className="text-[10.5px]" style={{ color: INK.textFaint, fontFamily: FONT.mono }}>
      {(ms / 1000).toFixed(1)}s
    </span>
  );
}

function Reasoning({
  steps,
  running,
  pending = [],
  showHeader = true,
}: {
  steps: AgentStep[];
  running: boolean;
  pending?: { tool: string; gate: string; label: string }[];
  /** False inside a chat turn, where the message itself already labels the state and times it. */
  showHeader?: boolean;
}) {
  const thoughts = useMemo(
    () => steps.filter((s) => s.kind === 'reason' || s.kind === 'validate'),
    [steps],
  );

  // Paced reveal. Several steps genuinely complete inside one animation frame, so they arrive as a
  // burst and five lines appear at once. This spaces the REVEAL only: the order is the real order
  // and each line still shows its own measured duration. Nothing is delayed on the server, and a
  // step that takes a second still appears the moment it lands, because the queue never gets ahead
  // of what has actually arrived.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (shown >= thoughts.length) return;
    const id = window.setTimeout(() => setShown((n) => Math.min(n + 1, thoughts.length)),
                                 shown === 0 ? 0 : 130);
    return () => window.clearTimeout(id);
  }, [shown, thoughts.length]);

  // A finished run shows its whole trail at once: pacing a historical record would be theatre.
  const visible = running ? thoughts.slice(0, shown) : thoughts;
  const settling = running && shown < thoughts.length;

  if (!thoughts.length && !pending.length && !running) return null;

  return (
    <section className={showHeader ? 'px-6 pt-5' : 'pt-1'}>
      {showHeader && (
      <div className="mb-3 flex items-center gap-1.5">
        {running ? (
          <motion.span
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.4, repeat: Infinity }}
          >
            <Sparkles className="h-3.5 w-3.5" style={{ color: INK.accent }} />
          </motion.span>
        ) : (
          <Sparkles className="h-3.5 w-3.5" style={{ color: INK.textFaint }} />
        )}
        <span
          className="text-[10px] tracking-[0.2em] uppercase"
          style={{ color: INK.textFaint, fontFamily: FONT.sans }}
        >
          {running ? 'Thinking' : 'Reasoning'}
        </span>
        <span className="ml-auto">
          <Elapsed running={running} />
        </span>
      </div>
      )}

      <ol className="space-y-3.5">
        <AnimatePresence initial={false}>
          {visible.map((s, i) => {
            const newest = running && i === visible.length - 1;
            return (
              <motion.li
                key={s.n}
                layout
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.36, ease: EASE }}
                className="flex gap-2.5"
              >
                <span
                  className="mt-1.75 h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: s.status === 'ok' ? INK.accent : INK.hairlineStrong }}
                />
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold" style={{ color: INK.text }}>
                    {s.label}
                  </p>
                  {s.detail && (
                    <p
                      className="mt-0.5 text-[12.5px] leading-[1.6]"
                      style={{ color: INK.textSoft }}
                    >
                      {s.detail}
                      {/* A caret on the newest line only. It says "this is where the agent is
                          now", which a static list of finished steps cannot say. */}
                      {newest && (
                        <motion.span
                          className="ml-0.5 inline-block h-3.25 w-0.5 translate-y-0.5"
                          style={{ background: INK.accent }}
                          animate={{ opacity: [1, 0, 1] }}
                          transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                        />
                      )}
                    </p>
                  )}
                </div>
              </motion.li>
            );
          })}

          {/* Capabilities announced but not yet returned. Without these the panel went quiet for
              the whole duration of a call and then produced several lines at once. */}
          {!settling && pending.map((t) => (
            <motion.li
              key={`pending-${t.tool}`}
              layout
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="flex gap-2.5"
            >
              <Loader2
                className="mt-0.75 h-3 w-3 shrink-0 animate-spin"
                style={{ color: INK.accent }}
              />
              <div className="min-w-0">
                <p className="text-[13px] font-semibold" style={{ color: INK.textSoft }}>
                  {t.label}
                </p>
                <p
                  className="mt-0.5 text-[12.5px]"
                  style={{ color: INK.textFaint, fontFamily: FONT.mono }}
                >
                  running {t.tool}…
                </p>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </section>
  );
}

/* ── tool calls ──────────────────────────────────────────────────────────────────────────── */
function ToolLine({ step: s }: { step: AgentStep }) {
  const [open, setOpen] = useState(false);
  const ok = s.status === 'ok';
  const secs = s.ms >= 1000 ? `${(s.ms / 1000).toFixed(1)}s` : `${s.ms}ms`;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.32, ease: EASE }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors"
        style={{ fontFamily: FONT.mono }}
        onMouseEnter={(e) => (e.currentTarget.style.background = INK.sunken)}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        <span className="text-[12px]" style={{ color: ok ? INK.accent : INK.caution }}>
          {'>'}
        </span>
        <span className="truncate text-[12.5px]" style={{ color: INK.textSoft }}>
          <span style={{ color: INK.text }}>{s.tool.replace(/^tools\./, '')}</span>
          {s.detail ? `, ${s.detail}` : ''}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px]" style={{ color: INK.textFaint }}>
          {s.evidence?.length > 0 && <span>{s.evidence.length} fig</span>}
          <span>{secs}</span>
          {ok ? (
            <Check className="h-3 w-3" style={{ color: INK.positive }} />
          ) : (
            <MinusCircle className="h-3 w-3" style={{ color: INK.caution }} />
          )}
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.26, ease: EASE }}
            className="overflow-hidden"
          >
            <div
              className="mt-1 ml-5 space-y-2.5 rounded-xl border px-3 py-2.5"
              style={{ borderColor: INK.hairline, background: INK.sunken }}
            >
              <div>
                <p className="mb-1 text-[10px] tracking-[0.14em] uppercase" style={{ color: INK.textFaint }}>
                  Request
                </p>
                <pre
                  className="overflow-x-auto rounded-lg px-2.5 py-2 text-[11.5px]"
                  style={{ background: INK.surface, color: INK.textSoft, fontFamily: FONT.mono }}
                >
                  {JSON.stringify({ gate: s.gate || null, why: s.why || null }, null, 1)}
                </pre>
              </div>
              {s.evidence?.length > 0 && <EvidenceRows claims={s.evidence} />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function EvidenceRows({ claims }: { claims: EvidenceClaim[] }) {
  return (
    <div className="overflow-hidden rounded-lg border" style={{ borderColor: INK.hairline }}>
      <table className="w-full" style={{ background: INK.surface }}>
        <tbody>
          {claims.map((c) => (
            <tr key={c.claim_id} style={{ borderTop: `1px solid ${INK.hairline}` }}>
              <td className="px-2.5 py-1.5 text-[12px]" style={{ color: INK.textSoft }}>
                {c.label}
              </td>
              <td
                className="px-2.5 py-1.5 text-right text-[12px] font-semibold"
                style={{ color: INK.text, fontFamily: FONT.mono, fontVariantNumeric: 'tabular-nums' }}
              >
                {c.value}
              </td>
              <td className="px-2.5 py-1.5 text-[11px]" style={{ color: INK.textFaint }}>
                {c.unit}
              </td>
              <td className="px-2.5 py-1.5 text-right">
                <span
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px]"
                  style={{ background: INK.sunken, color: INK.textFaint, fontFamily: FONT.mono }}
                >
                  <Database className="h-2.5 w-2.5" />
                  {c.source}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── workspace ───────────────────────────────────────────────────────────────────────────── */
function ResultTable({ dataset, n, capped = true }:
                     { dataset: AgentDataset; n: number; capped?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <motion.div layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.42, ease: EASE }}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] tracking-[0.16em]" style={{ color: INK.textFaint, fontFamily: FONT.mono }}>
          RESULT #{n}
        </span>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 cursor-pointer items-center gap-1.5 text-left text-[12.5px]"
          style={{ color: INK.text }}
        >
          <span className="truncate">{dataset.title}</span>
          <ChevronDown
            className={`ml-auto h-3 w-3 shrink-0 transition-transform duration-200 ${open ? '' : '-rotate-90'}`}
            style={{ color: INK.textFaint }}
          />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="overflow-hidden rounded-xl border"
            style={{ borderColor: INK.hairline, background: INK.surface }}
          >
            <div className={capped ? 'max-h-64 overflow-auto' : ''}>
              <table className="w-full border-collapse">
                <thead className="sticky top-0" style={{ background: INK.sunken }}>
                  <tr>
                    {dataset.columns.map((c) => (
                      <th
                        key={c}
                        className="px-3 py-2 text-left text-[10px] font-semibold tracking-widest whitespace-nowrap"
                        style={{ color: INK.textFaint, fontFamily: FONT.mono }}
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dataset.rows.map((row, ri) => (
                    <tr key={ri} style={{ borderTop: `1px solid ${INK.hairline}` }}>
                      {row.map((cell, ci) => (
                        <td
                          key={ci}
                          className="px-3 py-1.5 text-[12px] whitespace-nowrap"
                          style={
                            typeof cell === 'number'
                              ? {
                                  textAlign: 'right',
                                  color: INK.text,
                                  fontFamily: FONT.mono,
                                  fontVariantNumeric: 'tabular-nums',
                                }
                              : { color: INK.textSoft }
                          }
                        >
                          {cell ?? '-'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div
              className="flex items-center gap-1.5 px-3 py-1.5"
              style={{ borderTop: `1px solid ${INK.hairline}`, background: INK.sunken }}
            >
              <Database className="h-2.5 w-2.5" style={{ color: INK.textFaint }} />
              <span className="text-[10px]" style={{ color: INK.textFaint, fontFamily: FONT.mono }}>
                {dataset.source} · {dataset.rows.length} rows
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function shorten(label: string) {
  const c = label.replace(/^the /, '');
  return c.length > 14 ? `${c.slice(0, 13)}…` : c;
}

function VisualCard({ visual }: { visual: AgentVisual }) {
  const data = useMemo(
    () => visual.series.map((s) => ({ ...s, short: shorten(s.label) })),
    [visual.series],
  );

  if (visual.kind === 'delta') {
    const max = Math.max(...visual.series.map((x) => Math.abs(x.value))) || 1;
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.42, ease: EASE }}
        className="rounded-xl border p-4"
        style={{ borderColor: INK.hairline, background: INK.surface }}
      >
        <p className="text-[11.5px]" style={{ color: INK.textSoft }}>
          {visual.title}
        </p>
        <div className="mt-3 space-y-2">
          {visual.series.map((s, i) => (
            <div key={s.label} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-[11px]" style={{ color: INK.textFaint }}>
                {s.label}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded-full" style={{ background: INK.sunken }}>
                <motion.div
                  className="h-full rounded-full"
                  style={{ background: i === 0 ? INK.hairlineStrong : INK.signal }}
                  initial={{ width: 0 }}
                  animate={{ width: `${(Math.abs(s.value) / max) * 100}%` }}
                  transition={{ duration: 0.75, delay: 0.1 + i * 0.12, ease: EASE }}
                />
              </div>
              <span
                className="w-16 shrink-0 text-right text-[11.5px]"
                style={{ color: INK.text, fontFamily: FONT.mono, fontVariantNumeric: 'tabular-nums' }}
              >
                {compact(s.value)}
              </span>
            </div>
          ))}
        </div>
        <SourceTag source={visual.source} gate={visual.gate} />
      </motion.div>
    );
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.42, ease: EASE }}
      className="rounded-xl border p-4"
      style={{ borderColor: INK.hairline, background: INK.surface }}
    >
      <p className="text-[11.5px]" style={{ color: INK.textSoft }}>
        {visual.title}
      </p>
      {visual.subtitle && (
        <p className="mt-0.5 text-[11px]" style={{ color: INK.textFaint }}>
          {visual.subtitle}
        </p>
      )}
      <div className="mt-3 h-35">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
            <XAxis
              dataKey="short"
              tick={{ fill: INK.textFaint, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              interval={0}
            />
            <RechartsTooltip
              cursor={{ fill: '#00000008' }}
              contentStyle={{
                background: INK.surface,
                border: `1px solid ${INK.hairline}`,
                borderRadius: 10,
                fontSize: 12,
                color: INK.text,
                boxShadow: '0 6px 24px rgba(18,19,26,.08)',
              }}
              formatter={(v) => [`${Number(v)}${visual.unit}`, 'share'] as [string, string]}
              labelFormatter={(_l, p) => (p?.[0]?.payload as { label?: string })?.label ?? ''}
            />
            <Bar dataKey="value" radius={[5, 5, 0, 0]} animationDuration={850}>
              {data.map((_, i) => (
                <Cell key={i} fill={RANK_SCALE[i % RANK_SCALE.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <SourceTag source={visual.source} gate={visual.gate} />
    </motion.div>
  );
}

function SourceTag({ source, gate }: { source: string; gate: string }) {
  return (
    <div className="mt-3 flex items-center gap-1.5">
      <span
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px]"
        style={{ background: INK.sunken, color: INK.textFaint, fontFamily: FONT.mono }}
      >
        <Database className="h-2.5 w-2.5" />
        {source}
      </span>
      {gate && (
        <span className="text-[10.5px]" style={{ color: INK.textFaint }}>
          via {gate}
        </span>
      )}
    </div>
  );
}

/* ── finding ─────────────────────────────────────────────────────────────────────────────── */
const FIGURE = /(\d[\d,]*\.?\d*\s?%?)/g;
const IS_FIGURE = /^\d[\d,]*\.?\d*\s?%?$/;

/** Weights the figures inside an already-verified sentence. Presentational only, never rewrites. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(FIGURE).map((part, i) =>
        IS_FIGURE.test(part) ? (
          <strong
            key={i}
            style={{ color: INK.text, fontFamily: FONT.mono, fontVariantNumeric: 'tabular-nums' }}
          >
            {part}
          </strong>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

function statements(text: string): string[] {
  return text
    .split(/(?<=\.)\s+(?=[A-Z“"])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function Finding({ sections, answer }: { sections: AgentSection[]; answer: string }) {
  if (!sections?.length) {
    return (
      <p className="text-[14px] leading-[1.7]" style={{ color: INK.text }}>
        <Rich text={answer} />
      </p>
    );
  }

  // One section is not a briefing. A greeting, a capability list or a definition arrives alone and
  // needs no heading, no rule and no bullets: the heading was labelling a single paragraph
  // "Greeting" and then chopping it into five bullet points.
  const single = sections.length === 1 && sections[0].kind !== 'findings';
  if (single) {
    return (
      <p className="text-[14.5px] leading-[1.75]" style={{ color: INK.text }}>
        <Rich text={sections[0].text} />
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {sections.map((section, i) => {
        const accent = SLOT_COLOR[section.label] || INK.accent;
        const asBullets = section.kind !== 'prose' && statements(section.text).length > 1;
        return (
          <motion.div
            key={`${section.tool}-${i}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: step(i, 110), duration: 0.42, ease: EASE }}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />
              <h4 className="text-[14px]" style={{ color: accent, fontFamily: FONT.display }}>
                {section.label}
              </h4>
              {section.source && (
                <span
                  className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
                  style={{ background: INK.sunken, color: INK.textFaint, fontFamily: FONT.mono }}
                >
                  <Database className="h-2.5 w-2.5" />
                  {section.source}
                </span>
              )}
            </div>
            {!asBullets && (
              <p className="text-[14px] leading-[1.75]" style={{ color: INK.textSoft }}>
                <Rich text={section.text} />
              </p>
            )}
            <ul className={asBullets ? 'space-y-1.5 pl-4' : 'hidden'}>
              {statements(section.text).map((point, pi) => (
                <li
                  key={pi}
                  className="relative text-[14px] leading-[1.75]"
                  style={{ color: INK.textSoft }}
                >
                  <span
                    className="absolute top-2.5 -left-3 h-1 w-1 rounded-full"
                    style={{ background: INK.hairlineStrong }}
                  />
                  <Rich text={point} />
                </li>
              ))}
            </ul>
          </motion.div>
        );
      })}
    </div>
  );
}

/* ── console ─────────────────────────────────────────────────────────────────────────────── */
function AgentConsole({
  gates,
  steps,
  running,
  active,
  sections = [],
  answer = '',
  visuals = [],
  datasets = [],
  confidence,
  uncertainty = [],
  verified,
  kpiName = '',
  pending = [],
  embedded = false,
  chart,
}: {
  gates: AgentGate[];
  steps: AgentStep[];
  running: boolean;
  active?: string;
  sections?: AgentSection[];
  answer?: string;
  visuals?: AgentVisual[];
  datasets?: AgentDataset[];
  confidence?: number;
  uncertainty?: string[];
  verified?: boolean;
  kpiName?: string;
  /** Capabilities announced but not yet returned, shown as in-flight lines. */
  pending?: { tool: string; gate: string; label: string }[];
  /** True when the console is rendered inside a chat message. The transcript already scrolls and
   *  is only a column wide, so the panes stack and none of them takes its own scrollbar. */
  embedded?: boolean;
  /** The metric's real daily path, rendered at the top of the workspace. */
  chart?: React.ReactNode;
}) {
  const toolSteps = useMemo(() => steps.filter((s) => s.kind === 'act'), [steps]);
  const delta = useMemo(() => visuals.find((v) => v.kind === 'delta'), [visuals]);
  const [showCalls, setShowCalls] = useState(true);

  useEffect(() => setShowCalls(running), [running]);

  const hasWorkspace = datasets.length > 0 || visuals.length > 0 || Boolean(chart);
  const pad = embedded ? 'px-0' : 'px-6';

  return (
    <div
      className={embedded ? '' : 'overflow-hidden rounded-3xl border'}
      style={
        embedded
          ? undefined
          : {
              borderColor: INK.hairline,
              background: INK.surface,
              boxShadow: '0 1px 2px rgba(18,19,26,.04), 0 8px 32px rgba(18,19,26,.05)',
            }
      }
    >
      {!running && <HeroFinding kpiName={kpiName} delta={delta} gates={gates} />}

      {/* Reasoning and evidence run side by side because they happen side by side. */}
      <div
        className={
          hasWorkspace && !embedded
            ? 'grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]'
            : ''
        }
      >
        <div
          style={
            hasWorkspace && !embedded
              ? { borderRight: `1px solid ${INK.hairline}` }
              : undefined
          }
        >
          {!embedded && <GateRail gates={gates} active={active} pad={pad} />}
          {(!embedded || running) && (
            <Reasoning steps={steps} running={running} pending={pending} showHeader={!embedded} />
          )}

          {toolSteps.length > 0 && (
            <section className={`${pad} pt-5`}>
              <button
                onClick={() => setShowCalls((v) => !v)}
                className="mb-2 flex cursor-pointer items-center gap-1.5 text-[10px] tracking-[0.2em] uppercase"
                style={{ color: INK.textFaint, fontFamily: FONT.sans }}
              >
                {toolSteps.length} {toolSteps.length === 1 ? 'call' : 'calls'}
                <ChevronDown
                  className={`h-3 w-3 transition-transform duration-200 ${showCalls ? '' : '-rotate-90'}`}
                />
              </button>
              <AnimatePresence initial={false}>
                {showCalls && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.3, ease: EASE }}
                    className="space-y-0.5 overflow-hidden"
                  >
                    {toolSteps.map((s) => (
                      <ToolLine key={s.n} step={s} />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          )}

          {!running && (sections.length > 0 || answer) && (
            <>
              <div className={embedded ? 'mt-5' : 'mx-6 mt-5'} style={{ borderTop: `1px solid ${INK.hairline}` }} />
              <section data-testid="agent-answer-text" className={`${pad} py-5`}>
                <Finding sections={sections} answer={answer} />
              </section>
            </>
          )}

          {/* Confidence is a statement about an ANALYTICAL answer. A greeting has no figures to
              be confident about, so the bar only made a courtesy look like a hedged claim. */}
          {!running &&
            typeof confidence === 'number' &&
            confidence > 0 &&
            sections.some((x) => x.kind === 'findings') && (
            <section className={`${pad} py-4`} style={{ borderTop: `1px solid ${INK.hairline}` }}>
              <div className="flex items-center gap-2">
                {verified && <ShieldCheck className="h-3.5 w-3.5" style={{ color: INK.positive }} />}
                <span
                  className="text-[10px] tracking-[0.16em] uppercase"
                  style={{ color: INK.textFaint, fontFamily: FONT.sans }}
                >
                  Confidence
                </span>
                <div className="h-1 flex-1 overflow-hidden rounded-full" style={{ background: INK.sunken }}>
                  <motion.div
                    className="h-full rounded-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.round(confidence * 100)}%` }}
                    transition={{ duration: 0.8, ease: EASE }}
                    style={{
                      background:
                        confidence >= 0.8 ? INK.positive : confidence >= 0.5 ? INK.caution : INK.danger,
                    }}
                  />
                </div>
                <span
                  className="text-[11.5px]"
                  style={{ color: INK.text, fontFamily: FONT.mono, fontVariantNumeric: 'tabular-nums' }}
                >
                  {Math.round(confidence * 100)}%
                </span>
              </div>
              {uncertainty.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {uncertainty.map((u) => (
                    <li key={u} className="text-[10.5px]" style={{ color: INK.textFaint }}>
                     , {u}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        {hasWorkspace && (
          <div style={{ background: INK.canvas }}>
            <div className={`flex items-center gap-2 ${pad} pt-5 pb-3`}>
              <motion.span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: INK.accent }}
                animate={running ? { opacity: [0.35, 1, 0.35] } : { opacity: 1 }}
                transition={running ? { duration: 1.3, repeat: Infinity } : undefined}
              />
              <span
                className="text-[10px] tracking-[0.2em] uppercase"
                style={{ color: INK.textSoft, fontFamily: FONT.sans }}
              >
                Insight workspace
              </span>
              <span className="ml-auto text-[10px]" style={{ color: INK.textFaint, fontFamily: FONT.mono }}>
                {datasets.length} results · {visuals.length} charts
              </span>
            </div>
            {/* Inside the chat this must NOT scroll: the transcript is already a scroll
                container, and nesting a second one clipped the workspace and made the
                lower panels unreachable without scrolling a pane inside a pane. */}
            <div className={`space-y-4 ${pad} pb-6 ${embedded ? '' : 'max-h-190 overflow-auto'}`}>
              {chart}
              <AnimatePresence initial={false}>
                {datasets.map((ds, i) => (
                  <ResultTable key={`${ds.tool}-${ds.title}-${i}`} dataset={ds} n={i + 1}
                             capped={!embedded} />
                ))}
              </AnimatePresence>
              <AnimatePresence initial={false}>
                {visuals.map((v, i) => (
                  <VisualCard key={`${v.tool}-${v.title}-${i}`} visual={v} />
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(AgentConsole);
