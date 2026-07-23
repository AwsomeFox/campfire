/**
 * Module-scoped deferred `beforeinstallprompt` event (issue #799 follow-up).
 *
 * Chromium fires `beforeinstallprompt` at most once per document load after
 * `preventDefault()`. `InstallHintBanner` only mounts on the campaign
 * dashboard, so keeping the event in React state alone loses it on
 * client-side navigation — remounting cannot recover a native Install CTA
 * until a full reload.
 *
 * This module holds the deferred event for the document lifetime and
 * registers capture listeners once so the prompt survives remounts (and can
 * be captured even before the banner mounts).
 */

/** Minimal surface the Install CTA needs — not in every lib.dom we target. */
export interface DeferredInstallPrompt {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

type BeforeInstallPromptEventLike = Event & DeferredInstallPrompt;

let deferred: DeferredInstallPrompt | null = null;
const subscribers = new Set<(prompt: DeferredInstallPrompt | null) => void>();
let captureStarted = false;

export function getDeferredInstallPrompt(): DeferredInstallPrompt | null {
  return deferred;
}

export function setDeferredInstallPrompt(prompt: DeferredInstallPrompt | null): void {
  deferred = prompt;
  for (const sub of subscribers) sub(deferred);
}

export function clearDeferredInstallPrompt(): void {
  setDeferredInstallPrompt(null);
}

/**
 * Subscribe to deferred-prompt changes. Does not invoke immediately — callers
 * should seed from `getDeferredInstallPrompt()` on mount.
 */
export function subscribeDeferredInstallPrompt(
  listener: (prompt: DeferredInstallPrompt | null) => void,
): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

/**
 * Register document-lifetime listeners once. Safe to call repeatedly; later
 * calls are no-ops. Pass a mock `Window` in unit tests.
 */
export function ensureDeferredInstallPromptCapture(
  target: Pick<Window, 'addEventListener'> | null | undefined =
    typeof window !== 'undefined' ? window : undefined,
): void {
  if (captureStarted || !target) return;
  captureStarted = true;

  target.addEventListener('beforeinstallprompt', (event: Event) => {
    // Hold the deferred prompt so the Install CTA can call it — do not let
    // the browser show its own mini-infobar in parallel with our banner.
    event.preventDefault();
    setDeferredInstallPrompt(event as BeforeInstallPromptEventLike);
  });

  target.addEventListener('appinstalled', () => {
    clearDeferredInstallPrompt();
  });
}

/** Reset module state between unit specs. */
export function resetDeferredInstallPromptForTests(): void {
  deferred = null;
  subscribers.clear();
  captureStarted = false;
}
