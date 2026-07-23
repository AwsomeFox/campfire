/**
 * Shared clipboard write helpers (issue #796).
 *
 * Copy controls used to diverge: some reported success when `navigator.clipboard`
 * was missing (`?.writeText` resolves to `undefined`), some swallowed failures
 * silently, and some left a "Copied" label up forever. Capability detection and
 * outcome handling live here so every surface can share one truthful path.
 *
 * Kept DOM-light / injectable so the insecure-context, missing-API, rejection,
 * repeated-copy, and one-time-secret cases are exhaustively testable in a
 * `.unit.spec.ts` without a browser.
 */

/** How long success/failure button feedback stays visible before resetting. */
export const COPY_FEEDBACK_MS = 1500;

export const DEFAULT_COPY_SUCCESS = 'Copied to clipboard.';
export const DEFAULT_COPY_FAILURE =
  'Copy failed. Clipboard blocked — select the text and copy it manually.';

/** Minimal env surface the write path needs — injectable for unit tests. */
export type ClipboardEnv = {
  isSecureContext: boolean;
  clipboard?: { writeText?: (text: string) => Promise<void> } | null;
};

export type CopyFailReason = 'insecure' | 'missing' | 'rejected';

export type CopyOutcome =
  | { ok: true }
  | { ok: false; reason: CopyFailReason };

export type CopyFeedbackStatus = 'idle' | 'copied' | 'failed';

export interface CopyFeedbackSnapshot {
  status: CopyFeedbackStatus;
}

export const initialCopyFeedback: CopyFeedbackSnapshot = { status: 'idle' };

export type CopyFeedbackEvent =
  | { type: 'succeeded' }
  | { type: 'failed' }
  | { type: 'reset' };

/**
 * Whether the Clipboard API can be attempted in this environment.
 *
 * Requires a secure context AND a callable `clipboard.writeText`. Checking
 * before awaiting is what stops the false-success path when the API is absent
 * (`await navigator.clipboard?.writeText(...)` resolves to `undefined`).
 */
export function canUseClipboard(env: ClipboardEnv): boolean {
  return (
    env.isSecureContext === true &&
    typeof env.clipboard?.writeText === 'function'
  );
}

/** Read the live browser clipboard env (secure context + navigator.clipboard). */
export function browserClipboardEnv(): ClipboardEnv {
  return {
    isSecureContext: typeof globalThis.isSecureContext === 'boolean' ? globalThis.isSecureContext : false,
    clipboard: typeof navigator !== 'undefined' ? navigator.clipboard : null,
  };
}

/**
 * Attempt a clipboard write. Success is returned ONLY after `writeText`
 * resolves; every other path yields a typed failure (never a thrown error).
 */
export async function writeClipboardText(
  text: string,
  env: ClipboardEnv = browserClipboardEnv(),
): Promise<CopyOutcome> {
  if (!env.isSecureContext) return { ok: false, reason: 'insecure' };
  const writeText = env.clipboard?.writeText;
  if (typeof writeText !== 'function') return { ok: false, reason: 'missing' };
  try {
    await writeText.call(env.clipboard, text);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'rejected' };
  }
}

/**
 * Reduce copy-button feedback. Pure: no timers.
 *
 * `succeeded` / `failed` enter the matching feedback state (a repeated success
 * while already `copied` stays `copied` so the caller can re-arm the reset
 * timer). `reset` returns to idle — used by the component's feedback timeout.
 */
export function reduceCopyFeedback(
  state: CopyFeedbackSnapshot,
  event: CopyFeedbackEvent,
): CopyFeedbackSnapshot {
  switch (event.type) {
    case 'succeeded':
      return { status: 'copied' };
    case 'failed':
      return { status: 'failed' };
    case 'reset':
      return state.status === 'idle' ? state : initialCopyFeedback;
    default:
      return state;
  }
}

/** Whether the auto-reset timer should be armed for this snapshot. */
export function copyFeedbackTimerArmed(snapshot: CopyFeedbackSnapshot): boolean {
  return snapshot.status === 'copied' || snapshot.status === 'failed';
}

/**
 * Select the contents of an element so the user can copy manually after a
 * clipboard failure. Supports inputs/textareas (`.select()`) and arbitrary
 * elements (Selection API). Returns true when a selection was applied.
 */
export function selectElementText(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    el.select();
    return true;
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** Resolve a failure-recovery target from a ref or element id. */
export function resolveSelectTarget(
  selectRef?: { current: HTMLElement | null } | null,
  selectTargetId?: string,
): HTMLElement | null {
  if (selectRef?.current) return selectRef.current;
  if (selectTargetId && typeof document !== 'undefined') {
    return document.getElementById(selectTargetId);
  }
  return null;
}
