'use client';

/**
 * The persona band: who is reading, what they lead with, and what is withheld from them.
 *
 * A persona is a lens over the same verified numbers, never a different set of numbers. The band
 * states what this reader sees and what is kept from them, because entitlement that is invisible
 * looks like missing data.
 */
import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { API_BASE_URL, rbacHeaders } from '@/lib/api';

export type PersonaId = 'cfo' | 'ops_manager' | 'risk_officer' | 'analyst';

interface PersonaInfo { id: string; label: string; remit?: string }

/** What each lens leads with. Mirrors personas.py; the server still decides what is readable. */
const LENS: Record<string, { leads: string; hides: string[] }> = {
  cfo: { leads: 'Revenue and lending outcome', hides: [] },
  ops_manager: { leads: 'Onboarding funnel and where it leaks', hides: ['Revenue'] },
  risk_officer: { leads: 'Transaction failures and exposure', hides: [] },
  analyst: { leads: 'Every metric, with method detail', hides: [] },
};

const EASE = [0.22, 1, 0.36, 1] as const;

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
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: EASE }}
      className="hero-band sheen-once mb-6 px-6 py-5 text-white sm:px-7"
      aria-label="Viewing as"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="mr-1 text-[10.5px] font-medium uppercase tracking-[0.18em] text-white/70">
          Viewing as
        </span>
        {list.map((p) => {
          const active = p.id === persona;
          return (
            <button
              key={p.id}
              onClick={() => onChange(p.id as PersonaId)}
              className={`relative cursor-pointer rounded-full px-4 py-1.5 text-[13px] transition-colors duration-200
                          ${active ? 'text-[#3d12c9]' : 'text-white/85 hover:text-white'}`}
            >
              {/* One shared pill slides between personas rather than four fading independently. */}
              {active && (
                <motion.span
                  layoutId="persona-pill"
                  transition={{ type: 'spring', stiffness: 430, damping: 36 }}
                  className="absolute inset-0 rounded-full bg-white"
                />
              )}
              {!active && (
                <span className="absolute inset-0 rounded-full border border-white/25" />
              )}
              <span className="relative z-10 whitespace-nowrap">{p.label || p.id}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-5 flex flex-wrap gap-x-14 gap-y-3">
        <div>
          <span className="block text-[10.5px] font-medium uppercase tracking-[0.18em] text-white/60">
            Leads with
          </span>
          <AnimatePresence mode="wait">
            <motion.p
              key={`${persona}-leads`}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              transition={{ duration: 0.24, ease: EASE }}
              className="mt-1 text-[14.5px]"
            >
              {lens.leads}
            </motion.p>
          </AnimatePresence>
        </div>
        <div>
          <span className="block text-[10.5px] font-medium uppercase tracking-[0.18em] text-white/60">
            Withheld
          </span>
          <AnimatePresence mode="wait">
            <motion.p
              key={`${persona}-hides`}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              transition={{ duration: 0.24, ease: EASE }}
              className="mt-1 text-[14.5px]"
            >
              {lens.hides.length
                ? `${lens.hides.join(', ')}: removed before the answer is built`
                : 'Nothing'}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>

      {current?.remit && (
        <p className="mt-5 border-t border-white/15 pt-3.5 text-[12.5px] text-white/75">
          {current.remit}
        </p>
      )}
    </motion.section>
  );
}
