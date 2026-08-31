'use client';

/**
 * One entrance animation for every page in the dashboard.
 *
 * Applied at the layout so it is not a per-page decision. Before this, some pages animated in
 * (`animate-in fade-in`), most did not, and a few staggered their own children, so navigating
 * between them felt like moving between three different products. A shared transition keyed on
 * the pathname makes every route arrive the same way.
 *
 * Deliberately restrained: a short rise and fade, not a slide. Content that travels across the
 * viewport on every navigation is tiring at the tenth navigation, whatever it feels like at the
 * first. `useReducedMotion` disables it outright rather than shortening it.
 */

import React from 'react';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

/** Shared with the intelligence theme so all motion in the product uses one curve. */
const EASE = [0.22, 0.8, 0.3, 1] as const;

export default function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const reduced = useReducedMotion();

  if (reduced) return <>{children}</>;

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={pathname}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.34, ease: EASE }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
