'use client';

/**
 * A themed listbox, replacing the native `<select>`.
 *
 * The native control renders its option list through the OS, so none of it can be styled: on
 * Windows the persona picker dropped a square white panel with a hard system-blue highlight into
 * the middle of a page with rounded cards and an indigo accent. Everything around it was themed
 * and the one control a user actually opens was not.
 *
 * Keyboard behaviour is implemented rather than inherited, because losing it is the usual cost of
 * replacing a native select: Enter/Space opens, ArrowUp/Down move, Home/End jump, Enter commits,
 * Escape closes and returns focus, and typing a letter jumps to the next option starting with it.
 * `role="listbox"`/`role="option"` with `aria-selected` and `aria-activedescendant` keep it
 * announced correctly.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown } from 'lucide-react';
import { EASE, FONT, INK } from './theme';

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  testId?: string;
}

export default function Select({
  value,
  options,
  onChange,
  testId,
  title,
  ariaLabel,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  testId?: string;
  title?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const selectedIndex = useMemo(
    () => Math.max(0, options.findIndex((o) => o.value === value)),
    [options, value],
  );
  const selected = options[selectedIndex];

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }, []);

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (option) onChange(option.value);
      close();
    },
    [options, onChange, close],
  );

  // Opening always starts on the current value, not on wherever the cursor was left last time.
  useEffect(() => {
    if (open) setCursor(selectedIndex);
  }, [open, selectedIndex]);

  // A click anywhere else closes it. Pointerdown rather than click so the list does not linger
  // through a drag that started outside it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setCursor(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commit(cursor);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const letter = e.key.toLowerCase();
      const from = options.findIndex(
        (o, i) => i > cursor && o.label.toLowerCase().startsWith(letter),
      );
      const wrapped = from === -1
        ? options.findIndex((o) => o.label.toLowerCase().startsWith(letter))
        : from;
      if (wrapped !== -1) setCursor(wrapped);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-testid={testId}
        data-value={value}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${cursor}` : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className="flex cursor-pointer items-center gap-2 rounded-full border py-1.5 pr-2.5 pl-3.5 text-[length:var(--step--1)] font-medium transition-colors focus:outline-none"
        style={{
          borderColor: open ? INK.accent : INK.hairline,
          background: open ? INK.surface : INK.sunken,
          color: INK.textSoft,
          fontFamily: FONT.sans,
          boxShadow: open ? `0 0 0 3px ${INK.accentSoft}` : undefined,
        }}
      >
        <span className="whitespace-nowrap">{selected?.label ?? ''}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          style={{ color: INK.textFaint }}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.ul
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            initial={{ opacity: 0, y: -4, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.985 }}
            transition={{ duration: 0.16, ease: EASE }}
            className="absolute z-50 mt-1.5 max-h-72 min-w-full overflow-auto rounded-2xl border p-1.5"
            style={{
              borderColor: INK.hairline,
              background: INK.surface,
              boxShadow: '0 12px 40px rgba(18,19,26,.12), 0 2px 8px rgba(18,19,26,.06)',
            }}
          >
            {options.map((option, i) => {
              const isSelected = option.value === value;
              const isCursor = i === cursor;
              return (
                <li
                  key={option.value}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={isSelected}
                  data-testid={option.testId}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => commit(i)}
                  className="flex cursor-pointer items-start gap-2 rounded-xl px-3 py-2"
                  style={{ background: isCursor ? INK.accentSoft : 'transparent' }}
                >
                  <Check
                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                    style={{ color: isSelected ? INK.accent : 'transparent' }}
                  />
                  <span className="min-w-0">
                    <span
                      className="block text-[length:var(--step--1)] whitespace-nowrap"
                      style={{ color: INK.text, fontWeight: isSelected ? 600 : 400 }}
                    >
                      {option.label}
                    </span>
                    {option.hint && (
                      <span
                        className="mt-0.5 block max-w-[19rem] text-[length:var(--step--1a)] leading-[1.45]"
                        style={{ color: INK.textFaint }}
                      >
                        {option.hint}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
