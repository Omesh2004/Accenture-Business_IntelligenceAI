'use client';

/**
 * Ask panel for the persona query agent.
 *
 * Two things are deliberately visible here. First, the reasoning trail: every tool the agent
 * called, in order, with what it passed and how long it took — an answer that cannot show its
 * retrieval path is not auditable. Second, the persona: the same question returns a different
 * briefing for a CFO and for an operations manager, and the switcher makes that explicit.
 *
 * An abstention is a normal outcome and is shown as such rather than hidden — a confident answer
 * with nothing behind it would be worse than no answer.
 */

import React, { memo, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { dashboardAPI } from '@/lib/api';
import {
  Send,
  Sparkles,
  ShieldCheck,
  ShieldAlert,
  Loader2,
  ChevronRight,
  X,
  Check,
  SkipForward,
  MinusCircle,
  XCircle,
} from 'lucide-react';
import type { AgentAnswer, AgentStep } from '@/types';

/**
 * `query_id` is derived from (tenant, persona, question) so that the same question is traceable
 * across runs -- which means it is deliberately NOT unique per reply. Asking the same thing twice
 * produced two React children with one key. Entries carry their own client-side id instead.
 */
type Reply = AgentAnswer & { entryId: string };

let entrySeq = 0;
const nextEntryId = () => `reply-${Date.now()}-${(entrySeq += 1)}`;

const FALLBACK_SUGGESTIONS = [
  'What drove the change?',
  'Where is it concentrated?',
  'Which metric moved most?',
  'What action is recommended?',
  'Which KPIs do you track?',
];

const STEP_ICON: Record<AgentStep['status'], { Icon: React.ElementType; cls: string }> = {
  ok: { Icon: Check, cls: 'text-emerald-600' },
  skipped: { Icon: SkipForward, cls: 'text-slate-400' },
  abstained: { Icon: MinusCircle, cls: 'text-amber-600' },
  failed: { Icon: XCircle, cls: 'text-red-600' },
};

const KIND_LABEL: Record<string, string> = {
  reason: 'Reason',
  act: 'Act',
  observe: 'Observe',
  validate: 'Validate',
  synthesize: 'Synthesize',
};

function ReasoningTrail({ steps }: { steps: AgentStep[] }) {
  const [open, setOpen] = useState(true);
  if (!steps?.length) return null;
  const total = steps.reduce((sum, s) => sum + s.ms, 0);

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Reasoning trail
        </span>
        <span className="ml-auto text-[11px] text-slate-400">
          {steps.length} steps · {total} ms
        </span>
      </button>

      {open && (
        <ol className="border-t border-slate-100 px-3 py-2">
          {steps.map((step) => {
            const { Icon, cls } = STEP_ICON[step.status] || STEP_ICON.ok;
            return (
              <li key={step.n} className="flex items-start gap-2.5 py-1.5">
                <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${cls}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-800">{step.label}</p>
                  {step.detail && (
                    <p className="mt-0.5 text-[11px] leading-5 text-slate-500">{step.detail}</p>
                  )}
                </div>
                <span className="shrink-0 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  {KIND_LABEL[step.kind] || 'Act'}
                </span>
                <span className="shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                  {step.tool}
                </span>
                <span className="w-12 shrink-0 text-right text-[10px] text-slate-400">
                  {step.ms} ms
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function IntelligenceAsk({
  tenants,
  persona,
  onPersonaChange,
}: {
  tenants: string[];
  persona?: string;
  onPersonaChange?: (persona: string) => void;
}) {
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<Reply[]>([]);

  const { data: choices } = useQuery({
    queryKey: ['intelligencePersonas', tenants],
    queryFn: () => dashboardAPI.getIntelligencePersonas(tenants),
    staleTime: 5 * 60 * 1000,
    retry: 3,
  });

  const active = persona || choices?.resolved || '';
  const activeProfile = useMemo(
    () => choices?.personas.find((p) => p.id === active),
    [choices, active],
  );

  const ask = useMutation({
    mutationFn: (q: string) => dashboardAPI.askIntelligence(tenants, q, active || undefined),
    onSuccess: (result) => {
      if (result) {
        setHistory((prev) => [{ ...result, entryId: nextEntryId() }, ...prev].slice(0, 8));
      }
    },
  });

  // Dismissal is local to this panel: the answer stays in the Signal Store and in `model_runs`,
  // so clearing a card from view never removes the record of it having been asked.
  const dismiss = (entryId: string) =>
    setHistory((prev) => prev.filter((item) => item.entryId !== entryId));

  const submit = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || ask.isPending) return;
    setQuestion('');
    ask.mutate(trimmed);
  };

  const suggestions = history[0]?.suggestions?.length
    ? history[0].suggestions
    : activeProfile?.examples?.length
      ? activeProfile.examples
      : FALLBACK_SUGGESTIONS;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <Sparkles className="h-4 w-4 text-slate-400" />
          Analyst enquiry
        </h3>
        <div className="flex items-center gap-2">
          {(choices?.personas.length ?? 0) > 1 && (
            <div className="flex items-center rounded-full border border-slate-200 bg-white p-0.5">
              {choices?.personas.map((p) => (
                <button
                  key={p.id}
                  data-testid={`persona-${p.id}`}
                  onClick={() => onPersonaChange?.(p.id)}
                  title={p.remit}
                  className={`cursor-pointer rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] transition-colors ${
                    p.id === active
                      ? 'bg-[#1a73e8] text-white'
                      : 'text-slate-500 hover:bg-slate-50'
                  }`}
                >
                  {p.label.split(' ')[0]}
                </button>
              ))}
            </div>
          )}
          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Evidence-bound
          </span>
        </div>
      </div>

      <div className="p-4">
        {activeProfile && (
          <p data-testid="answering-as" className="mb-3 text-[11px] leading-5 text-slate-500">
            Answering as <span className="font-semibold text-slate-700">{activeProfile.label}</span>
            {' — '}
            {activeProfile.remit}
          </p>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(question);
          }}
          className="flex gap-2"
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What drove the change in loan approval volume last week?"
            maxLength={500}
            className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-[#1a73e8] focus:ring-2 focus:ring-[#1a73e8]/15 focus:outline-none"
          />
          <button
            type="submit"
            disabled={ask.isPending || !question.trim()}
            className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-[#1a73e8] px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            {ask.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Ask
          </button>
        </form>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => submit(s)}
              disabled={ask.isPending}
              className="cursor-pointer rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              {s}
            </button>
          ))}
        </div>

        {ask.isPending && (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin text-[#1a73e8]" />
            Retrieving recorded findings…
          </div>
        )}

        <div className="mt-4 space-y-3">
          {history.map((item) => (
            <div
              key={item.entryId}
              data-testid="agent-answer"
              className={`rounded-xl border p-3 ${
                item.abstained ? 'border-amber-200 bg-amber-50/40' : 'border-slate-200 bg-slate-50/60'
              }`}
            >
              <div className="mb-1 flex items-start justify-between gap-2">
                <p className="text-xs text-slate-500">{item.question}</p>
                <button
                  onClick={() => dismiss(item.entryId)}
                  data-testid="dismiss-answer"
                  aria-label={`Dismiss the answer to "${item.question}"`}
                  title="Dismiss"
                  className="-mr-1 -mt-1 shrink-0 cursor-pointer rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {/* Labelled blocks when several capabilities contributed, so the reply reads as a
                  short briefing rather than one paragraph of run-on findings. The testid stays on
                  the wrapper: the full text is still one readable string for assertions. */}
              <div data-testid="agent-answer-text" className="text-sm leading-6 text-slate-900">
                {item.sections?.length > 1 ? (
                  <div className="space-y-2.5">
                    {item.sections.map((section, i) => (
                      <div key={`${item.entryId}-${section.tool}-${i}`}>
                        <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                          {section.label}
                        </p>
                        <p>{section.text}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p>{item.answer}</p>
                )}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                {(item.intents?.length ? item.intents : [item.intent]).map((i) => (
                  <span
                    key={i}
                    className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-slate-600"
                  >
                    {i}
                  </span>
                ))}
                <span
                  data-testid="agent-answer-persona"
                  className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-slate-600"
                >
                  {item.persona_label || item.persona}
                </span>
                {item.kpi_id && (
                  <span className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-slate-600">
                    {item.kpi_id}
                  </span>
                )}
                <span
                  className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${
                    item.verifier_pass
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-red-200 bg-red-50 text-red-700'
                  }`}
                >
                  {item.verifier_pass ? (
                    <ShieldCheck className="h-3 w-3" />
                  ) : (
                    <ShieldAlert className="h-3 w-3" />
                  )}
                  {item.verifier_pass ? 'Verified' : 'Unverified'}
                </span>
              </div>

              <ReasoningTrail steps={item.trace} />

              {item.citations?.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    Sources
                  </span>
                  {item.citations.map((c) => (
                    <span
                      key={`${c.tool}-${c.source}`}
                      data-testid="agent-citation"
                      className="rounded-full border border-slate-200 bg-white px-2 py-0.5 font-mono text-[10px] text-slate-600"
                      title={`${c.tool} read ${c.source}`}
                    >
                      {c.source}
                    </span>
                  ))}
                </div>
              )}

              {item.issues?.length > 0 && (
                <p className="mt-2 text-[11px] leading-5 text-amber-700">
                  Noted while answering: {item.issues.join('; ')}.
                </p>
              )}

              {item.evidence.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-slate-500">
                    {item.evidence.length} supporting claims
                  </summary>
                  <ul className="mt-1.5 space-y-0.5">
                    {item.evidence.map((claim) => (
                      <li key={claim.claim_id} className="font-mono text-xs text-slate-600">
                        {claim.label}: {claim.value} ({claim.source})
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default memo(IntelligenceAsk);
