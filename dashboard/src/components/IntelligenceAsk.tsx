'use client';

/**
 * Entry point to the analyst conversation.
 *
 * On the page this is a single composer. The moment a question is asked it hands over to
 * `ChatSurface` in a full-screen overlay, because a dialogue and a dashboard section want opposite
 * things: the section wants to be small and stay out of the way, and the conversation wants the
 * viewport so the reasoning, the evidence and the finding can be read together. Trying to be both
 * is what produced the earlier complaint that an answer to "hii" landed a screen away from the box
 * it was typed into.
 *
 * The transcript persists per tenant and persona, so closing the overlay does not end the session;
 * reopening restores it. Nothing here is a record of anything: every answer is already in the
 * Signal Store and in `model_runs`, and clearing the transcript removes neither.
 */

import React, { memo, useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUp, MessageSquare, Sparkles } from 'lucide-react';
import { dashboardAPI, type ChatTurn } from '@/lib/api';
import ChatSurface from './intel/ChatSurface';
import Select from './intel/Select';
import { EASE, FONT, INK } from './intel/theme';
import { loadChat } from './intel/chatStore';
import type { AgentAnswer, AgentDataset, AgentGate, AgentStep, AgentVisual } from '@/types';

function IntelligenceAsk({
  tenants,
  persona,
  onPersonaChange,
  days,
}: {
  tenants: string[];
  persona?: string;
  onPersonaChange?: (persona: string) => void;
  /** The page range selector. The agent answers over this unless the question names a period. */
  days?: number;
}) {
  const [open, setOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(true);
  const [seed, setSeed] = useState('');
  const [restored, setRestored] = useState(0);
  const [provider, setProvider] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('selected_llm_provider') || 'ollama';
    }
    return 'ollama';
  });

  const handleProviderChange = useCallback((p: string) => {
    setProvider(p);
    if (typeof window !== 'undefined') {
      localStorage.setItem('selected_llm_provider', p);
    }
  }, []);

  const { data: choices } = useQuery({
    queryKey: ['intelligencePersonas', tenants],
    queryFn: () => dashboardAPI.getIntelligencePersonas(tenants),
    staleTime: 5 * 60 * 1000,
    retry: 3,
  });

  const active = persona || choices?.resolved || '';
  const activeProfile = choices?.personas.find((p) => p.id === active);
  const tenantKey = tenants.join(',');

  // Whether there is a conversation to come back to. Read once per identity, not per render.
  useEffect(() => {
    if (typeof window === 'undefined' || !active) return;
    setRestored(loadChat(tenantKey, active).length);
  }, [tenantKey, active, open]);

  // Escape closes the overlay, and the page must not scroll behind it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prior = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prior;
    };
  }, [open]);

  const ask = useCallback(
    (
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
      history: ChatTurn[] = [],
    ) =>
      dashboardAPI
        .streamIntelligence(tenants, question, active || undefined, handlers, signal, days,
                            history, provider)
        .catch(async (err) => {
          if ((err as Error)?.name === 'AbortError') return;
          // Streaming is delivery, not the answer. If a proxy buffers SSE the batch route still
          // produces the identical payload, so a question is never lost to transport.
          const result = await dashboardAPI.askIntelligence(
            tenants, question, active || undefined, days, history, provider);
          if (result) handlers.onAnswer(result);
          else handlers.onError('The agent could not be reached.');
        }),
    [tenants, active, days, provider],
  );

  const launch = (q: string) => {
    setSeed(q.trim());
    setOpen(true);
  };

  return (
    <>
      <div
        className="rounded-3xl border p-5"
        style={{
          borderColor: INK.hairline,
          background: INK.surface,
          boxShadow: '0 1px 2px rgba(18,19,26,.04), 0 6px 22px rgba(18,19,26,.045)',
        }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <Sparkles className="h-4 w-4" style={{ color: INK.accent }} />
          <span className="text-[13px] font-semibold" style={{ color: INK.text }}>
            Ask the analyst
          </span>
          {/* Hidden while the overlay is up. The conversation carries its own switcher, and two
              controls with the same identity on one page is ambiguous both to a reader looking for
              the active persona and to anything selecting it. */}
          {!open && choices && choices.personas.length > 1 && (
            <Select
              testId="persona-select"
              ariaLabel="Answering as"
              value={active}
              onChange={(v) => onPersonaChange?.(v)}
              options={choices.personas.map((p) => ({
                value: p.id,
                label: p.label,
                hint: p.remit,
                testId: `persona-${p.id}`,
              }))}
            />
          )}
          {!open && (
            <Select
              testId="provider-select"
              ariaLabel="LLM Model"
              value={provider}
              onChange={handleProviderChange}
              options={[
                { value: 'ollama', label: '🦙 Local Ollama (GPU)', hint: 'Docker Qwen 2.5 3B', testId: 'provider-ollama' },
                { value: 'groq', label: '⚡ Groq / Grok API', hint: 'Cloud Llama 3.3 70B', testId: 'provider-groq' },
              ]}
            />
          )}
          {restored > 0 && (
            <button
              onClick={() => launch('')}
              className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px]"
              style={{ borderColor: INK.hairline, color: INK.textSoft }}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Resume conversation ({restored})
            </button>
          )}
        </div>

        {activeProfile && (
          <p data-testid="answering-as" className="mt-2.5 text-[12px]" style={{ color: INK.textFaint }}>
            Answering as{' '}
            <span style={{ color: INK.textSoft, fontWeight: 600 }}>{activeProfile.label}</span> ·{' '}
            {activeProfile.remit}
          </p>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const value = (new FormData(e.currentTarget).get('q') as string) || '';
            if (value.trim()) launch(value);
          }}
          className="mt-4 flex items-center gap-2 rounded-2xl border px-4 py-2.5"
          style={{ borderColor: INK.hairlineStrong, background: INK.canvas }}
        >
          <input
            name="q"
            placeholder="Start a conversation with the analyst"
            maxLength={500}
            data-focus-frame=""
            className="flex-1 border-0 bg-transparent text-[14.5px] outline-none"
            style={{ color: INK.text, fontFamily: FONT.sans }}
          />
          <button
            type="submit"
            aria-label="Ask"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full"
            style={{ background: INK.accent, color: '#fff' }}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </form>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="fixed inset-0 z-50 flex items-center justify-center"
            style={{ background: 'rgba(18,19,26,.28)', backdropFilter: 'blur(2px)' }}
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <motion.div
              initial={{ opacity: 0, y: 16, scale: 0.99 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.995 }}
              transition={{ duration: 0.3, ease: EASE }}
              className={
                fullscreen
                  ? 'h-full w-full'
                  : 'h-[86vh] w-[min(1100px,94vw)] overflow-hidden rounded-2xl shadow-2xl'
              }
            >
              <ChatSurface
                tenants={tenants}
                persona={active}
                onPersonaChange={onPersonaChange}
                choices={choices ?? undefined}
                provider={provider}
                onProviderChange={handleProviderChange}
                onAsk={ask}
                seed={seed}
                onSeedConsumed={() => setSeed('')}
                fullscreen={fullscreen}
                onToggleFullscreen={() => setFullscreen((v) => !v)}
                onClose={() => setOpen(false)}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default memo(IntelligenceAsk);
