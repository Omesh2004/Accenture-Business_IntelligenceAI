/**
 * Design tokens for the intelligence report, scoped to that page.
 *
 * The rest of the dashboard is Google-Analytics blue on grey, which is correct for a monitoring surface,
 * where nothing on screen is claiming anything. This page IS a claim: it says a metric moved, says
 * why, and proposes an action. So it gets its own register: an ink-and-indigo editorial palette
 * with a single warm accent reserved for movement, and that register is deliberately not shared,
 * so the same blue never means "a link" here and "an anomaly" there.
 *
 * Every colour is a literal string rather than a Tailwind class, because most of them are consumed
 * by Recharts and Framer Motion, which take CSS values and not class names.
 */

export const INK = {
  /** Page ground. Warm-neutral rather than pure white so cards can be white and still separate. */
  canvas: '#fbfbfd',
  surface: '#ffffff',
  /** One step down from surface. Used for table headers, code, inset panels. */
  sunken: '#f5f6fa',
  hairline: '#e7e8ef',
  hairlineStrong: '#d6d8e3',

  text: '#12131a',
  textSoft: '#4a4d5e',
  textFaint: '#8b8fa3',

  /** Primary. Indigo, not the dashboard's #1a73e8, because this page must not read as a chart page. */
  accent: '#4338ca',
  accentSoft: '#eef0fd',
  accentLine: '#6366f1',

  /** Reserved exclusively for movement: a metric outside its band, a delta, a driver bar. */
  signal: '#c2410c',
  signalSoft: '#fef3ec',

  positive: '#047857',
  positiveSoft: '#ecfdf5',
  caution: '#b45309',
  cautionSoft: '#fffbeb',
  danger: '#be123c',
  dangerSoft: '#fff1f3',
} as const;

/** One hue per narrative slot, so the four parts of a finding are distinguishable at a glance. */
export const SLOT_COLOR: Record<string, string> = {
  'What changed': INK.signal,
  'When it happened': '#0e7490',
  'Why it happened': INK.accent,
  'What to do now': INK.positive,
  'How far to trust this': INK.caution,
};

/** Gate status → dot colour. Restricted is deliberately the loudest: it means access, not absence. */
export const GATE_COLOR: Record<string, string> = {
  idle: INK.hairlineStrong,
  engaged: INK.positive,
  skipped: INK.hairlineStrong,
  failed: INK.caution,
  restricted: INK.danger,
};

/** Ranked-driver bars: one hue, descending weight, so rank reads before the label does. */
export const RANK_SCALE = ['#4338ca', '#5b52d6', '#7469e0', '#8d82e9', '#a79cf1', '#c1b8f8'];

export const FONT = {
  // `--font-inter` was never defined: the variable is `--font-ui`, so every inline style
  // in the chat quietly fell back to system-ui and the conversation was set in a
  // different face from the rest of the product.
  sans: 'var(--font-ui), system-ui, sans-serif',
  display: 'var(--font-display), system-ui, sans-serif',
  // Kept so call sites resolve; deliberately the same face as the rest.
  prose: 'var(--font-ui), system-ui, sans-serif',
  // No monospace family is loaded; the stack's own fallbacks are the real face here.
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;

/**
 * Shared motion vocabulary. One easing and a small set of durations across the page, so movement
 * feels like one system rather than each component inventing its own timing.
 */
export const EASE = [0.22, 0.8, 0.3, 1] as const;

export const MOTION = {
  rise: {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.42, ease: EASE },
  },
  fade: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    transition: { duration: 0.3, ease: EASE },
  },
} as const;

/** Stagger delay for a list that should unfold rather than appear. */
export const step = (i: number, ms = 60, cap = 520) => Math.min(i * ms, cap) / 1000;

/** Compact figure formatting. Charts and headlines must abbreviate the same way. */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  if (abs > 0 && abs < 1) return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return `${Math.round(n * 100) / 100}`;
}
