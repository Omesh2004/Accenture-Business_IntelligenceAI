'use client';

/**
 * The persona switch, and the statement of what it changed.
 *
 * A persona is a lens over the same verified numbers, never a different set of numbers. The
 * banner says what this reader sees and what is withheld from them, because entitlement that is
 * invisible looks like missing data.
 */
import React, { useEffect, useState } from 'react';
import { API_BASE_URL, rbacHeaders } from '@/lib/api';

export type PersonaId = 'cfo' | 'ops_manager' | 'risk_officer' | 'analyst';

interface PersonaInfo { id: string; label: string; remit?: string }

/** What each lens leads with. Mirrors personas.py; the server still decides what is readable. */
const LENS: Record<string, { leads: string; hides: string[]; accent: string }> = {
  cfo: { leads: 'Revenue and lending outcome', hides: [], accent: '#1a73e8' },
  ops_manager: {
    leads: 'Onboarding funnel and where it leaks',
    hides: ['Revenue'],
    accent: '#0f9d58',
  },
  risk_officer: { leads: 'Transaction failures and exposure', hides: [], accent: '#d93025' },
  analyst: { leads: 'Every metric, with method detail', hides: [], accent: '#5f6368' },
};

export default function PersonaLens({
  persona, onChange,
}: { persona: PersonaId; onChange: (p: PersonaId) => void }) {
  const [options, setOptions] = useState<PersonaInfo[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/intelligence/personas`, {
          headers: await rbacHeaders(),
        });
        if (!res.ok) return;
        const d = await res.json();
        // Server-authored allowlist. The client never widens it.
        if (Array.isArray(d?.personas)) setOptions(d.personas);
      } catch { /* the switcher falls back to the known four */ }
    })();
  }, []);

  const list: PersonaInfo[] = options.length
    ? options
    : Object.keys(LENS).map((id) => ({ id, label: id }));
  const lens = LENS[persona] || LENS.analyst;
  const current = list.find((p) => p.id === persona);

  return (
    <div className="reveal rounded-xl border border-gray-200/90 bg-white p-5 mb-6">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="eyebrow mr-1">Viewing as</span>
        {list.map((p) => {
          const active = p.id === persona;
          return (
            <button
              key={p.id}
              onClick={() => onChange(p.id as PersonaId)}
              className={`px-3 py-1.5 rounded-full text-sm transition-all duration-200 border ${
                active
                  ? 'text-white border-transparent shadow-sm'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
              }`}
              style={active ? { backgroundColor: (LENS[p.id] || lens).accent } : undefined}
            >
              {p.label || p.id}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div>
          <span className="eyebrow">Leads with</span>
          <p className="text-gray-900" style={{ fontSize: 'var(--step-0)' }}>{lens.leads}</p>
        </div>
        <div>
          <span className="eyebrow">Withheld</span>
          <p style={{ fontSize: 'var(--step-0)' }} className={lens.hides.length ? 'text-red-700' : 'text-gray-500'}>
            {lens.hides.length ? `${lens.hides.join(', ')}: removed before the answer is built` : 'Nothing'}
          </p>
        </div>
      </div>

      {current?.remit && (
        <p className="mt-3 text-sm text-gray-500 border-t border-gray-100 pt-3">{current.remit}</p>
      )}
    </div>
  );
}
