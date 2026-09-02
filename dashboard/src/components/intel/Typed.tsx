'use client';

/**
 * Text that types itself in, once, the first time it is shown.
 *
 * The lead sentence already typed; everything under it appeared complete in a single frame, so
 * an answer read as one line of thought followed by a wall of pre-written output. Typing the
 * card text too makes the whole reply feel like it is being written rather than fetched.
 *
 * Deliberately cheap: one interval per block, a substring per tick, and nothing re-rendered but
 * this node. Blocks that have already typed once render instantly, so scrolling back through a
 * transcript never re-runs an animation the reader has seen.
 */
import React, { useEffect, useRef, useState } from 'react';

/** Characters per tick. A few at a time reads as writing; one at a time reads as a teleprinter. */
const CHARS_PER_TICK = 3;
const TICK_MS = 16;

export default function Typed({
  text, active = true, delay = 0, onDone, className, style,
}: {
  text: string;
  /** False renders the whole string at once, for a turn the reader has already seen. */
  active?: boolean;
  delay?: number;
  onDone?: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [shown, setShown] = useState(active ? 0 : text.length);
  const done = useRef(!active);

  useEffect(() => {
    if (!active || done.current) {
      setShown(text.length);
      return;
    }
    let timer: number | undefined;
    const start = window.setTimeout(() => {
      timer = window.setInterval(() => {
        setShown((n) => {
          const next = n + CHARS_PER_TICK;
          if (next >= text.length) {
            window.clearInterval(timer);
            done.current = true;
            onDone?.();
            return text.length;
          }
          return next;
        });
      }, TICK_MS);
    }, delay * 1000);

    return () => {
      window.clearTimeout(start);
      if (timer) window.clearInterval(timer);
    };
    // `text` identity is stable per message; re-running on it would restart a finished block.
  }, [text, active, delay, onDone]);

  return (
    <span className={className} style={style}>
      {text.slice(0, shown)}
      {shown < text.length && (
        <span aria-hidden className="ml-px inline-block h-[1em] w-[2px] translate-y-[2px]
                                     animate-pulse rounded-sm align-baseline"
              style={{ background: 'var(--brand)' }} />
      )}
    </span>
  );
}
