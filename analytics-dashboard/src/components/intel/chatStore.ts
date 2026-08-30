/**
 * Conversation persistence for the analyst chat.
 *
 * A question here can take several seconds and produce a briefing worth re-reading, so losing the
 * thread on a refresh is a real cost. The transcript lives in `localStorage`, keyed by tenant and
 * persona so two tenants never share a history.
 *
 * Three constraints shape this:
 *
 *   * Every read and write is wrapped. `localStorage` throws outright in a private window, when
 *     site data is blocked, and inside some embedded viewers — not returns null, THROWS — so an
 *     unguarded access takes the whole panel down with it.
 *   * The transcript is capped. Each assistant turn carries its trace, its result tables and its
 *     charts; a long session would otherwise walk into the ~5MB quota and start failing writes
 *     silently, losing the newest messages rather than the oldest.
 *   * Nothing here is a source of truth. Every answer is already recorded in the Signal Store and
 *     in `model_runs`; this is a convenience copy for one browser, and clearing it removes no
 *     record of anything.
 */

import type { AgentAnswer } from '@/types';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Plain text for a user turn; the flattened answer for an assistant turn. */
  text: string;
  /** Present on an assistant turn: the full payload the console renders from. */
  answer?: AgentAnswer;
  ts: number;
}

const PREFIX = 'fininsights.intel.chat';
/** Enough to scroll back through a working session, small enough to stay well inside quota. */
const MAX_MESSAGES = 40;
const VERSION = 1;

function keyFor(tenant: string, persona: string): string {
  return `${PREFIX}.v${VERSION}.${tenant}.${persona || 'default'}`;
}

export function loadChat(tenant: string, persona: string): ChatMessage[] {
  try {
    const raw = window.localStorage.getItem(keyFor(tenant, persona));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // A stored shape from an older build must not crash the panel; drop what does not fit.
    return parsed.filter(
      (m): m is ChatMessage =>
        m && typeof m.id === 'string' && (m.role === 'user' || m.role === 'assistant'),
    );
  } catch {
    return [];
  }
}

export function saveChat(tenant: string, persona: string, messages: ChatMessage[]): void {
  try {
    const trimmed = messages.slice(-MAX_MESSAGES);
    window.localStorage.setItem(keyFor(tenant, persona), JSON.stringify(trimmed));
  } catch {
    // Quota exceeded, or storage unavailable. Retry once with only the recent tail, which is what
    // a reader actually scrolls back to; if that fails too, the session simply is not persisted.
    try {
      window.localStorage.setItem(
        keyFor(tenant, persona),
        JSON.stringify(messages.slice(-8)),
      );
    } catch {
      /* not persistable in this browser */
    }
  }
}

export function clearChat(tenant: string, persona: string): void {
  try {
    window.localStorage.removeItem(keyFor(tenant, persona));
  } catch {
    /* nothing to clear */
  }
}

let seq = 0;
export function messageId(): string {
  seq += 1;
  return `m-${Date.now()}-${seq}`;
}
