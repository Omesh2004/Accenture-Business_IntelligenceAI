'use client';

/**
 * Evidence card, trust ledger and engine breakdown for one investigation.
 *
 * Every figure shown here is read back from the Signal Store, never recomputed in the browser —
 * that traceability is what lets the narrative be trusted.
 */

import React, { memo } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Cpu, Bot } from 'lucide-react';
import type { EvidenceClaim, TrustCheck, EngineBreakdown } from '@/types';

const VERDICT_STYLE: Record<string, { cls: string; Icon: React.ElementType }> = {
  pass: { cls: 'text-emerald-700 bg-emerald-50 border-emerald-200', Icon: CheckCircle2 },
  fail: { cls: 'text-red-700 bg-red-50 border-red-200', Icon: XCircle },
  ambiguous: { cls: 'text-amber-700 bg-amber-50 border-amber-200', Icon: AlertTriangle },
};

function formatValue(value: number, unit: string) {
  if (unit === 'percent') return `${value.toFixed(1)}%`;
  if (unit === 'currency') return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (unit === 'score') return value.toFixed(4);
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

interface Props {
  evidence: EvidenceClaim[];
  trust: { checks: TrustCheck[]; passed: number; failed: number; ambiguous: number };
  engine: EngineBreakdown;
  verifierPass: number;
}

function IntelligenceEvidence({ evidence, trust, engine, verifierPass }: Props) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Evidence card — every number the narrative may state */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-700">Evidence ledger</h3>
          <span
            className={`text-xs px-2 py-0.5 rounded-full border ${
              verifierPass
                ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                : 'text-red-700 bg-red-50 border-red-200'
            }`}
          >
            {verifierPass ? 'Numeric verifier passed' : 'Numeric verifier failed'}
          </span>
        </div>
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs sticky top-0">
              <tr>
                <th className="text-left font-medium px-4 py-2">Claim</th>
                <th className="text-right font-medium px-4 py-2">Value</th>
                <th className="text-left font-medium px-4 py-2">Source table</th>
              </tr>
            </thead>
            <tbody>
              {evidence.map((claim) => (
                <tr key={claim.claim_id} className="border-t border-slate-100">
                  <td className="px-4 py-2 text-slate-700">{claim.label}</td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatValue(claim.value, claim.unit)}
                  </td>
                  <td className="px-4 py-2 text-slate-500 font-mono text-xs">{claim.source}</td>
                </tr>
              ))}
              {evidence.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                    No claims were recorded for this investigation.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-4">
        {/* LLM vs non-LLM — computed from model_runs, not asserted by the model */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Method attribution</h3>
          <div className="flex items-center gap-3 mb-3">
            <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden flex">
              <div
                className="bg-[#1a73e8] h-full"
                style={{ width: `${100 - engine.llm_share_pct}%` }}
                title="deterministic stages"
              />
              <div
                className="bg-violet-400 h-full"
                style={{ width: `${engine.llm_share_pct}%` }}
                title="LLM stages"
              />
            </div>
          </div>
          <div className="flex items-center gap-5 text-sm">
            <span className="flex items-center gap-1.5 text-slate-700">
              <Cpu className="w-4 h-4 text-indigo-500" />
              {engine.non_llm_runs} deterministic
            </span>
            <span className="flex items-center gap-1.5 text-slate-700">
              <Bot className="w-4 h-4 text-violet-500" />
              {engine.llm_runs} LLM ({engine.llm_share_pct.toFixed(1)}%)
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(engine.by_engine).map(([name, stats]) => (
              <span
                key={name}
                className="text-xs px-2 py-1 rounded bg-slate-50 border border-slate-200 text-slate-600 font-mono"
              >
                {name}: {stats.runs} runs · {stats.latency_ms}ms
              </span>
            ))}
          </div>
        </div>

        {/* Trust ledger — passes are recorded too, so the suppression rate is auditable */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-slate-700">Trust gate ledger</h3>
            <span className="text-xs text-slate-500">
              {trust.passed} pass · {trust.failed} fail · {trust.ambiguous} ambiguous
            </span>
          </div>
          <div className="max-h-56 overflow-y-auto divide-y divide-slate-100">
            {trust.checks.map((check) => {
              const style = VERDICT_STYLE[check.verdict] || VERDICT_STYLE.ambiguous;
              return (
                <div key={check.check_id} className="px-4 py-2 flex items-start gap-2">
                  <style.Icon
                    className={`w-4 h-4 mt-0.5 shrink-0 ${style.cls.split(' ')[0]}`}
                  />
                  <div className="min-w-0">
                    <p className="text-sm text-slate-900 font-mono truncate">{check.check_id}</p>
                    <p className="text-xs text-slate-500">
                      {Object.entries(check.observed)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(', ') || check.verdict}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(IntelligenceEvidence);
