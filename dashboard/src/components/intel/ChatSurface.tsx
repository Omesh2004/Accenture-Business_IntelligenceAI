'use client';

/**
 * The analyst conversation, as a conversation.
 *
 * The panel used to be a form with results stacked under it: you typed at the top and the answer
 * appeared somewhere below, so a one-line reply to "hii" landed off-screen and a second question
 * pushed the first further away. That is a query form, not a dialogue.
 *
 * This is the dialogue. The composer is fixed at the bottom, the transcript scrolls above it and
 * pins to the newest turn, and the whole thing takes the viewport once a conversation exists so
 * the reasoning and the finding share one field of view. The transcript is restored from
 * `localStorage`, because a briefing that took eight seconds to produce should survive a refresh.
 *
 * Two presentation choices that are not decoration:
 *
 *   * The assistant's prose TYPES for a reply that has just arrived, and renders instantly for one
 *     restored from storage. Replaying a typing animation over yesterday's transcript would be
 *     theatre; doing it for a live reply matches the pace at which it was actually produced.
 *   * "Thinking" carries a moving shine rather than a spinner. A spinner implies a determinate
 *     wait; this run has no known duration, and the elapsed counter beside it is the honest
 *     progress signal.
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUp, Database, Loader2, Maximize2, Minimize2, Sparkles, Trash2, X } from 'lucide-react';
import type { ChatTurn } from '@/lib/api';
import AgentConsole from '../AgentConsole';
import AnswerCards from './AnswerCards';
import Chart from './Charts';
import InsightRail from './InsightRail';
import Select from './Select';
import ShinyText from './ShinyText';
import TextType from './TextType';
import { EASE, FONT, INK } from './theme';
import { type ChatMessage, clearChat, loadChat, messageId, saveChat } from './chatStore';
import type { AgentAnswer, AgentDataset, AgentGate, AgentStep, AgentVisual } from '@/types';
import type { PersonaChoices } from '@/types';

/** Typing an eight-line briefing at reading speed would take a minute. This is a pace, not a wait. */
const TYPE_SPEED_MS = 9;

function Elapsed({ from }: { from: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span style={{ color: INK.textFaint, fontFamily: FONT.mono }} className="text-[11px]">
      {((now - from) / 1000).toFixed(1)}s
    </span>
  );
}

/**
 * One stage of an answer arriving.
 *
 * The whole answer used to appear the instant the lead line finished typing: four cards, three
 * charts and a derivation panel in a single frame. Staging them costs nothing and lets a reader
 * follow the argument in the order it was made.
 */
function Reveal({ delay, children }: { delay: number; children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.42, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

function UserTurn({ text }: { text: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="flex justify-end"
    >
      <div
        className="max-w-[78%] rounded-2xl px-4 py-2.5 text-[14.5px] leading-[1.6]"
        style={{ background: INK.sunken, color: INK.text }}
      >
        {text}
      </div>
    </motion.div>
  );
}

function AssistantTurn({
  message,
  live,
  tenants,
  onTyped,
  onDismiss,
  followUps = [],
  onFollowUp,
}: {
  message: ChatMessage;
  live: boolean;
  tenants: string[];
  onTyped: () => void;
  onDismiss: () => void;
  /** Offered under the newest answer only, so a transcript is not lined with stale prompts. */
  followUps?: string[];
  onFollowUp?: (q: string) => void;
}) {
  const answer = message.answer;
  const [typed, setTyped] = useState(!live);

  // The answer carries its own charts now: `get_trend` reads the series through the Metric API
  // and the payload arrives with it. Fetching a second copy here was two reads of a moving table,
  // which is exactly what a chart beside a quoted figure must not be.
  const lead = answer?.sections?.length ? answer.sections[0].text : message.text;
  const analytical = Boolean(answer?.sections?.some((s) => s.kind === 'findings'));
  // Whether the console would actually render anything here. Embedded, it shows the sections
  // after the lead, the tool calls, the tables and the charts, and nothing else. A greeting has
  // none of those, and an empty panel offering to explain a derivation that does not exist is
  // worse than no panel.
  const hasDerivation = Boolean(
    (answer?.sections?.length ?? 0) > 1
    || (answer?.datasets?.length ?? 0) > 0
    || (answer?.visuals?.length ?? 0) > 0
    || answer?.trace?.some((t) => t.kind === 'act'),
  );
  // At most three charts, and never one the cards above already are: `bars` IS the "Where is it
  // concentrated" list and `delta` IS the big number in "What happened". Drawing them again put
  // the same figures on screen twice, which reads as two findings rather than one.
  const charts = useMemo(() => {
    const all = answer?.visuals || [];
    const order = ['trend', 'waterfall', 'band', 'donut'];
    const seen = new Set<string>();
    const picked: typeof all = [];
    for (const kind of order) {
      const found = all.find((v) => v.kind === kind && !seen.has(v.kind));
      if (!found) continue;
      seen.add(found.kind);
      picked.push(found);
      if (picked.length === 3) break;
    }
    return picked;
  }, [answer?.visuals]);

  const sources = useMemo(() => {
    const seen = new Set<string>();
    return (answer?.citations || []).filter((c) => {
      if (!c.source || seen.has(c.source)) return false;
      seen.add(c.source);
      return true;
    });
  }, [answer?.citations]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: EASE }}
      data-testid="agent-answer"
      className="group space-y-3"
    >
      {/* A transcript can mix personas, so each answer states which view produced it. Without this
          a reader scrolling back cannot tell why two answers to the same question differ. */}
      <div className="flex items-center gap-2">
        <span
          data-testid="agent-answer-persona"
          className="text-[11px] font-semibold"
          style={{ color: INK.accent }}
        >
          {answer?.persona_label || answer?.persona || 'Analyst'}
        </span>
        {answer?.kpi_id && (
          <span
            className="rounded px-1.5 py-0.5 text-[10px]"
            style={{ background: INK.sunken, color: INK.textFaint, fontFamily: FONT.mono }}
          >
            {answer.kpi_id}
          </span>
        )}
        <button
          onClick={onDismiss}
          data-testid="dismiss-answer"
          aria-label="Remove this answer from the transcript"
          title="Remove from this transcript"
          className="ml-auto cursor-pointer rounded p-1 opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color: INK.textFaint }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* The opening line types; everything structured below it appears once typing is done, so a
          reader is not chasing a moving layout while a table renders beneath it. */}
      <div data-testid="agent-answer-text" className="text-[14.5px] leading-[1.7]" style={{ color: INK.text }}>
        {live && !typed ? (
          <TextType
            as="p"
            text={lead}
            typingSpeed={TYPE_SPEED_MS}
            loop={false}
            showCursor
            cursorCharacter="▍"
            cursorClassName="opacity-60"
            className="!inline"
            onDone={() => {
              setTyped(true);
              onTyped();
            }}
          />
        ) : (
          <p>{lead}</p>
        )}
      </div>

      {/* The four questions a reader arrives with, then everything the run could honestly draw.
          Each stage waits for the one before it, so the answer assembles in the order it was
          reasoned rather than appearing all at once. */}
      {typed && answer && (
        <>
          <Reveal delay={0}>
            <AnswerCards answer={answer} visuals={answer.visuals || []} />
          </Reveal>
          {charts.length > 0 && (
            <Reveal delay={0.34}>
              <div className={`grid grid-cols-1 gap-3 ${
                charts.length === 1 ? '' : charts.length === 2 ? 'lg:grid-cols-2'
                                                              : 'lg:grid-cols-2 xl:grid-cols-3'}`}>
                {charts.map((v, i) => (
                  <Chart key={`${v.tool}-${v.kind}-${i}`} visual={v} />
                ))}
              </div>
            </Reveal>
          )}
        </>
      )}

      {typed && answer && hasDerivation && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE }}
        >
          <details className="surface group mt-3 overflow-hidden">
            <summary className="flex cursor-pointer select-none items-center gap-2 px-5 py-3
                                text-[10.5px] font-semibold uppercase tracking-[0.14em]
                                text-slate-500 transition-colors hover:text-slate-700">
              <span className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ background: 'var(--brand)' }} />
              How this answer was derived
            </summary>
            <div className="border-t border-slate-100">
          <AgentConsole
            gates={answer.rail || []}
            steps={answer.trace || []}
            running={false}
            // The lead paragraph is already above; the console renders the remaining parts.
            sections={(answer.sections || []).slice(1)}
            answer=""
            visuals={answer.visuals || []}
            datasets={answer.datasets || []}
            confidence={answer.confidence}
            uncertainty={answer.uncertainty || []}
            verified={Boolean(answer.verifier_pass)}
            kpiName={answer.kpi_id?.replace(/_/g, ' ') || ''}
            embedded
          />
            </div>
          </details>
        </motion.div>
      )}

      {/* The tables each figure was read from, flat. The console shows a source per section; this
          is the whole provenance of the answer in one line, which is what a reader checks first. */}
      {typed && live && followUps.length > 0 && (
        <Reveal delay={0.62}>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {followUps.map((q) => (
              <button
                key={q}
                onClick={() => onFollowUp?.(q)}
                className="cursor-pointer rounded-full border px-3 py-1.5 text-[12px]
                           transition-colors duration-200"
                style={{ borderColor: INK.hairline, background: INK.surface,
                         color: INK.textSoft }}
              >
                {q}
              </button>
            ))}
          </div>
        </Reveal>
      )}

      {typed && sources.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] tracking-[0.16em] uppercase" style={{ color: INK.textFaint }}>
            Sources
          </span>
          {sources.map((c) => (
            <span
              key={`${c.tool}-${c.source}`}
              data-testid="agent-citation"
              title={`${c.tool} read ${c.source}`}
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]"
              style={{
                borderColor: INK.hairline,
                background: INK.surface,
                color: INK.textFaint,
                fontFamily: FONT.mono,
              }}
            >
              <Database className="h-2.5 w-2.5" />
              {c.source}
            </span>
          ))}
        </div>
      )}
    </motion.div>
  );
}

function ChatSurface({
  tenants,
  persona,
  onPersonaChange,
  choices,
  provider,
  onProviderChange,
  onAsk,
  seed,
  onSeedConsumed,
  fullscreen,
  onToggleFullscreen,
  onClose,
}: {
  tenants: string[];
  persona: string;
  onPersonaChange?: (p: string) => void;
  choices?: PersonaChoices;
  provider?: string;
  onProviderChange?: (p: string) => void;
  onAsk: (
    question: string,
    handlers: {
      onRail: (g: AgentGate[]) => void;
      onStep: (s: AgentStep) => void;
      onPending: (p: { tools: { tool: string; gate: string; label: string }[] }) => void;
      onResult: (p: { datasets: AgentDataset[]; visuals: AgentVisual[] }) => void;
      onAnswer: (a: AgentAnswer) => void;
      onError: (d: string) => void;
    },
    signal: AbortSignal,
    history: ChatTurn[],
  ) => Promise<void>;
  /** A question typed on the page before the overlay existed. Sent once, then cleared. */
  seed?: string;
  onSeedConsumed?: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onClose: () => void;
}) {
  const tenantKey = tenants.join(',');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [liveSteps, setLiveSteps] = useState<AgentStep[]>([]);
  const [liveGates, setLiveGates] = useState<AgentGate[]>([]);
  const [liveDatasets, setLiveDatasets] = useState<AgentDataset[]>([]);
  const [liveVisuals, setLiveVisuals] = useState<AgentVisual[]>([]);
  const [pending, setPending] = useState<{ tool: string; gate: string; label: string }[]>([]);
  const [error, setError] = useState('');
  const [liveId, setLiveId] = useState('');

  const abort = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Restore on mount and whenever the conversation's identity changes. A tenant switch must not
  // show another tenant's transcript.
  useEffect(() => {
    setMessages(loadChat(tenantKey, persona));
  }, [tenantKey, persona]);

  useEffect(() => {
    if (messages.length) saveChat(tenantKey, persona, messages);
  }, [messages, tenantKey, persona]);

  const scrollToEnd = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, []);

  useEffect(() => {
    scrollToEnd();
  }, [messages.length, running, liveSteps.length, scrollToEnd]);

  useEffect(() => {
    if (fullscreen) inputRef.current?.focus();
  }, [fullscreen]);


  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || running) return;
      setQuestion('');
      setError('');
      setRunning(true);
      setStartedAt(performance.now());
      setLiveSteps([]);
      setLiveGates([]);
      setLiveDatasets([]);
      setLiveVisuals([]);
      setPending([]);
      setMessages((prev) => [
        ...prev,
        { id: messageId(), role: 'user', text, ts: Date.now() },
      ]);

      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;

      try {
        await onAsk(
          text,
          {
            onRail: setLiveGates,
            onStep: (step) => {
              setLiveSteps((prev) => [...prev, step]);
              setPending((prev) => prev.filter((t) => `tools.${t.tool}` !== step.tool));
              if (step.gate) {
                setLiveGates((prev) =>
                  prev.map((g) =>
                    g.id === step.gate
                      ? {
                          ...g,
                          status: step.status === 'ok' ? 'engaged' : 'failed',
                          detail: step.detail,
                          tools: Array.from(new Set([...(g.tools ?? []), step.tool])),
                        }
                      : g,
                  ),
                );
              }
            },
            onPending: ({ tools }) => setPending(tools ?? []),
            onResult: ({ datasets, visuals }) => {
              if (datasets?.length) setLiveDatasets((prev) => [...prev, ...datasets]);
              if (visuals?.length) setLiveVisuals((prev) => [...prev, ...visuals]);
            },
            onAnswer: (answer) => {
              const id = messageId();
              setLiveId(id);
              setMessages((prev) => [
                ...prev,
                { id, role: 'assistant', text: answer.answer, answer, ts: Date.now() },
              ]);
            },
            onError: setError,
          },
          controller.signal,
          // The turns so far, so a follow-up like "what about the others?" has a subject. The
          // user turn just pushed is excluded; it is the question being asked.
          messages.slice(-8).map((m) => ({
            role: m.role, text: m.text, kpi_id: m.answer?.kpi_id || undefined,
          })),
        );
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          setError('The agent could not be reached.');
        }
      } finally {
        setRunning(false);
        setPending([]);
      }
    },
    [onAsk, running, messages],
  );

  // The question typed on the page is sent here, once. Guarded by a ref rather than by clearing
  // state alone: the parent's clear is async, and a second fire would ask the same question twice.
  const seeded = useRef(false);
  useEffect(() => {
    if (!seed || seeded.current) return;
    seeded.current = true;
    void submit(seed);
    onSeedConsumed?.();
  }, [seed, submit, onSeedConsumed]);

  // Once an answer has landed the agent's own follow-ups are better than the persona's stock
  // examples: they are about the metric actually on screen.
  const latestAnswer = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].answer) return messages[i].answer!;
    }
    return null;
  }, [messages]);

  const suggestions = useMemo(() => {
    const fromAnswer = latestAnswer?.suggestions ?? [];
    const stock = choices?.personas.find((p) => p.id === persona)?.examples ?? [];
    return (fromAnswer.length ? fromAnswer : stock).slice(0, 4);
  }, [latestAnswer, choices, persona]);

  const wipe = () => {
    clearChat(tenantKey, persona);
    setMessages([]);
    setLiveSteps([]);
    setLiveGates([]);
  };

  return (
    <div className="flex h-full flex-col" style={{ background: INK.canvas }}>
      <header
        className="flex shrink-0 items-center gap-3 px-5 py-3"
        style={{ borderBottom: `1px solid ${INK.hairline}`, background: INK.surface }}
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg"
              style={{ background: 'var(--brand-grad)' }}>
          <Sparkles className="h-3.5 w-3.5 text-white" />
        </span>
        <span className="text-[13.5px] font-semibold"
              style={{ color: INK.text, fontFamily: FONT.sans }}>
          AI Analyst
        </span>
        <span className="chip chip-brand">Evidence-bound</span>
        {choices && choices.personas.length > 1 && (
          <Select
            testId="persona-select"
            ariaLabel="Answering as"
            value={persona}
            onChange={(v) => onPersonaChange?.(v)}
            options={choices.personas.map((p) => ({
              value: p.id,
              label: p.label,
              hint: p.remit,
              testId: `persona-${p.id}`,
            }))}
          />
        )}
        <Select
          testId="provider-select"
          ariaLabel="LLM Engine"
          value={provider || 'ollama'}
          onChange={(v) => onProviderChange?.(v)}
          options={[
            { value: 'ollama', label: '🦙 Local Ollama (GPU)', hint: 'Docker Qwen 2.5 3B', testId: 'provider-ollama' },
            { value: 'groq', label: '⚡ Groq / Grok API', hint: 'Cloud Llama 3.3 70B', testId: 'provider-groq' },
          ]}
        />
        <div className="ml-auto flex items-center gap-1">
          {messages.length > 0 && (
            <button
              onClick={wipe}
              title="Start a new conversation"
              aria-label="Start a new conversation"
              className="mr-1 flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5
                         text-[12px] font-medium text-white transition-transform duration-200
                         hover:scale-[1.03]"
              style={{ background: 'var(--brand-grad)' }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              New chat
            </button>
          )}
          <button
            onClick={onToggleFullscreen}
            title={fullscreen ? 'Exit full screen' : 'Full screen'}
            aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            className="cursor-pointer rounded-lg p-1.5"
            style={{ color: INK.textFaint }}
          >
            {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          {fullscreen && (
            <button
              onClick={onClose}
              title="Close"
              aria-label="Close the conversation"
              className="cursor-pointer rounded-lg p-1.5"
              style={{ color: INK.textFaint }}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
       <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto max-w-4xl space-y-6">
          {messages.map((m) =>
            m.role === 'user' ? (
              <UserTurn key={m.id} text={m.text} />
            ) : (
              <AssistantTurn
                key={m.id}
                message={m}
                live={m.id === liveId}
                tenants={tenants}
                onTyped={scrollToEnd}
                onDismiss={() => setMessages((prev) => prev.filter((x) => x.id !== m.id))}
                followUps={suggestions}
                onFollowUp={submit}
              />
            ),
          )}

          <AnimatePresence>
            {running && (
              <motion.div
                key="thinking"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="space-y-3"
              >
                <div className="flex items-center gap-2">
                  <ShinyText
                    text="Thinking"
                    speed={1.6}
                    color={INK.textFaint}
                    shineColor={INK.accent}
                    className="text-[13px] font-medium"
                  />
                  <Elapsed from={startedAt} />
                </div>
                <AgentConsole
                  gates={liveGates}
                  steps={liveSteps}
                  running
                  pending={pending}
                  datasets={liveDatasets}
                  visuals={liveVisuals}
                  active={[...liveSteps].reverse().find((s) => s.gate)?.gate}
                  embedded
                />
              </motion.div>
            )}
          </AnimatePresence>

          {error && (
            <p
              className="rounded-xl px-3 py-2 text-[12.5px]"
              style={{ background: INK.dangerSoft, color: INK.danger }}
            >
              {error}
            </p>
          )}

          <div ref={endRef} />
        </div>
       </div>

       {/* Only shown once there is something to summarise, and only for the newest answer. */}
       {latestAnswer && !running && (
         <div className="hidden min-h-0 xl:flex">
           <InsightRail answer={latestAnswer} />
         </div>
       )}
      </div>

      <div className="shrink-0 px-5 pb-5" style={{ background: INK.canvas }}>
        <div className="mx-auto max-w-3xl">
          {/* Only on an empty transcript. Once an answer is on screen a permanent row of
              questions sits between the reader and the thing they asked for, and reads as part
              of the answer rather than as a prompt. Follow-ups live under the answer instead. */}
          {messages.length === 0 && !running && suggestions.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {suggestions.map((s, i) => (
                <motion.button
                  key={s}
                  onClick={() => submit(s)}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.05, 0.3), duration: 0.3, ease: EASE }}
                  className="cursor-pointer rounded-full border px-3.5 py-1.5 text-[12.5px]"
                  style={{ borderColor: INK.hairline, background: INK.surface, color: INK.textSoft }}
                >
                  {s}
                </motion.button>
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(question);
            }}
            className="rounded-3xl border"
            style={{
              borderColor: INK.hairlineStrong,
              background: INK.surface,
              boxShadow: '0 1px 2px rgba(18,19,26,.04), 0 8px 28px rgba(18,19,26,.06)',
            }}
          >
            <textarea
              ref={inputRef}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit(question);
                }
              }}
              rows={1}
              maxLength={500}
              placeholder="Ask about any governed metric, what moved, why, and what to do about it."
              data-focus-frame=""
              className="w-full resize-none border-0 bg-transparent px-5 pt-4 pb-1 text-[15px] leading-[1.6] outline-none"
              style={{ color: INK.text, fontFamily: FONT.sans }}
            />
            <div className="flex items-center gap-2 px-3 pb-2.5">
              <span
                className="rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-[0.16em] uppercase"
                style={{ background: INK.accentSoft, color: INK.accent }}
              >
                Evidence-bound
              </span>
              <motion.button
                type="submit"
                disabled={running || !question.trim()}
                whileHover={running || !question.trim() ? undefined : { scale: 1.05 }}
                whileTap={running || !question.trim() ? undefined : { scale: 0.96 }}
                aria-label="Ask"
                className="ml-auto flex h-8 w-8 cursor-pointer items-center justify-center rounded-full disabled:cursor-not-allowed"
                style={{
                  background: running || !question.trim() ? INK.hairline : INK.accent,
                  color: running || !question.trim() ? INK.textFaint : '#ffffff',
                }}
              >
                {running ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="h-4 w-4" />
                )}
              </motion.button>
            </div>
          </form>
          <p className="mt-2 text-center text-[10.5px]" style={{ color: INK.textFaint }}>
            Answers come from recorded findings only. Where the evidence does not support one, the
            agent abstains.
          </p>
        </div>
      </div>
    </div>
  );
}

export default memo(ChatSurface);
