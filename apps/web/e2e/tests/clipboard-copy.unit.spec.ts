import { expect, test } from '@playwright/test';
import {
  COPY_FEEDBACK_MS,
  DEFAULT_COPY_FAILURE,
  DEFAULT_COPY_SUCCESS,
  canUseClipboard,
  copyFeedbackTimerArmed,
  initialCopyFeedback,
  reduceCopyFeedback,
  selectElementText,
  writeClipboardText,
  type ClipboardEnv,
  type CopyFeedbackSnapshot,
} from '../../src/components/clipboardCopy';

/**
 * Issue #796 — shared clipboard write + feedback model.
 *
 * Copy controls used to report success when the Clipboard API was missing,
 * swallow failures, or leave "Copied" up forever. Capability detection and
 * outcome handling live in `clipboardCopy.ts` so every surface shares one
 * truthful path. These specs pin the acceptance scenarios without a browser:
 *   (a) insecure context
 *   (b) denied / missing API
 *   (c) writeText rejection
 *   (d) success only after a resolved write
 *   (e) repeated copy re-arms feedback (does not stick forever)
 *   (f) one-time secrets never claim success on failure
 */
function env(
  partial: Partial<ClipboardEnv> & { writeText?: (text: string) => Promise<void> } = {},
): ClipboardEnv {
  const { writeText, clipboard, ...rest } = partial;
  return {
    isSecureContext: true,
    clipboard:
      clipboard === null
        ? null
        : {
            writeText:
              writeText ??
              clipboard?.writeText ??
              (async () => {
                /* default success */
              }),
          },
    ...rest,
  };
}

test.describe('clipboard capability + write outcomes (issue #796)', () => {
  test('insecure context is not capable and fails without calling writeText', async () => {
    let called = false;
    const insecure = env({
      isSecureContext: false,
      writeText: async () => {
        called = true;
      },
    });
    expect(canUseClipboard(insecure)).toBe(false);
    await expect(writeClipboardText('secret', insecure)).resolves.toEqual({
      ok: false,
      reason: 'insecure',
    });
    expect(called).toBe(false);
  });

  test('missing Clipboard API is not capable and fails with reason missing', async () => {
    const missing = env({ clipboard: null });
    expect(canUseClipboard(missing)).toBe(false);
    await expect(writeClipboardText('hello', missing)).resolves.toEqual({
      ok: false,
      reason: 'missing',
    });

    const noWrite = { isSecureContext: true, clipboard: {} };
    expect(canUseClipboard(noWrite)).toBe(false);
    await expect(writeClipboardText('hello', noWrite)).resolves.toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  test('writeText rejection surfaces as rejected (denied permission path)', async () => {
    const denied = env({
      writeText: async () => {
        throw new Error('NotAllowedError');
      },
    });
    expect(canUseClipboard(denied)).toBe(true);
    await expect(writeClipboardText('hello', denied)).resolves.toEqual({
      ok: false,
      reason: 'rejected',
    });
  });

  test('success is returned only after writeText resolves', async () => {
    let resolveWrite!: () => void;
    let resolved = false;
    const pending = env({
      writeText: () =>
        new Promise<void>((resolve) => {
          resolveWrite = () => {
            resolved = true;
            resolve();
          };
        }),
    });

    const resultPromise = writeClipboardText('payload', pending);
    // Still pending — must not have reported ok yet.
    let settled: unknown = 'pending';
    void resultPromise.then((value) => {
      settled = value;
    });
    await Promise.resolve();
    expect(settled).toBe('pending');
    expect(resolved).toBe(false);

    resolveWrite();
    await expect(resultPromise).resolves.toEqual({ ok: true });
    expect(resolved).toBe(true);
    expect(settled).toEqual({ ok: true });
  });

  test('optional-chaining false-success is impossible: missing writeText never returns ok', async () => {
    // Regression for AiSetupChecklist: `await navigator.clipboard?.writeText(text)`
    // resolves to undefined when clipboard is absent, which looked like success.
    const outcome = await writeClipboardText('ask admin', {
      isSecureContext: true,
      clipboard: undefined,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('missing');
  });
});

test.describe('copy feedback reset (issue #796)', () => {
  test('default announcements mention copy success / manual recovery', () => {
    expect(DEFAULT_COPY_SUCCESS).toMatch(/copied/i);
    expect(DEFAULT_COPY_FAILURE).toMatch(/copy failed/i);
    expect(DEFAULT_COPY_FAILURE).toMatch(/manually/i);
    expect(COPY_FEEDBACK_MS).toBeGreaterThan(0);
  });

  test('success arms feedback that reset clears (SessionsPage indefinite-Copied fix)', () => {
    const copied = reduceCopyFeedback(initialCopyFeedback, { type: 'succeeded' });
    expect(copied.status).toBe('copied');
    expect(copyFeedbackTimerArmed(copied)).toBe(true);
    const idle = reduceCopyFeedback(copied, { type: 'reset' });
    expect(idle).toEqual(initialCopyFeedback);
    expect(copyFeedbackTimerArmed(idle)).toBe(false);
  });

  test('failure arms feedback without ever entering copied', () => {
    const failed = reduceCopyFeedback(initialCopyFeedback, { type: 'failed' });
    expect(failed.status).toBe('failed');
    expect(copyFeedbackTimerArmed(failed)).toBe(true);
    expect(reduceCopyFeedback(failed, { type: 'reset' }).status).toBe('idle');
  });

  test('repeated copy re-enters copied so the reset timer can be re-armed', () => {
    let snap: CopyFeedbackSnapshot = initialCopyFeedback;
    snap = reduceCopyFeedback(snap, { type: 'succeeded' });
    expect(snap.status).toBe('copied');
    // Second click while still showing Copied! — stay copied; the component
    // clears and re-arms its timeout from this transition.
    snap = reduceCopyFeedback(snap, { type: 'succeeded' });
    expect(snap.status).toBe('copied');
    expect(copyFeedbackTimerArmed(snap)).toBe(true);
    snap = reduceCopyFeedback(snap, { type: 'reset' });
    expect(snap.status).toBe('idle');
  });

  test('one-time secret failure never claims copied feedback', async () => {
    const secret = 'cf_live_one_time_token_abc123';
    const outcome = await writeClipboardText(secret, env({ clipboard: null }));
    expect(outcome.ok).toBe(false);
    // Feedback derived from the outcome must stay out of `copied` — the secret
    // remains on-screen for manual selection instead of a false "Copied!".
    const feedback = reduceCopyFeedback(
      initialCopyFeedback,
      outcome.ok ? { type: 'succeeded' } : { type: 'failed' },
    );
    expect(feedback.status).toBe('failed');
    expect(feedback.status).not.toBe('copied');
  });

  test('text change is modeled as reset so a new URL never keeps Copied', () => {
    // CopyControl clears feedback when `text` changes; the reducer contract for
    // that path is `reset` (SharePanel creating a new recap link).
    const copied = reduceCopyFeedback(initialCopyFeedback, { type: 'succeeded' });
    expect(copied.status).toBe('copied');
    expect(reduceCopyFeedback(copied, { type: 'reset' }).status).toBe('idle');
  });
});

test.describe('selectElementText non-browser safety (issue #796)', () => {
  test('null target is a no-op', () => {
    expect(selectElementText(null)).toBe(false);
    expect(selectElementText(undefined)).toBe(false);
  });

  test('tagName-based input detection does not throw when HTML* constructors are absent', () => {
    // Simulates a non-browser / stripped DOM: no HTMLInputElement on globalThis.
    const hadInput = 'HTMLInputElement' in globalThis;
    const hadTextArea = 'HTMLTextAreaElement' in globalThis;
    const savedInput = hadInput ? (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement : undefined;
    const savedTextArea = hadTextArea
      ? (globalThis as { HTMLTextAreaElement?: unknown }).HTMLTextAreaElement
      : undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).HTMLInputElement;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).HTMLTextAreaElement;

      const fakeInput = {
        tagName: 'INPUT',
        value: 'invite-link',
        setSelectionRange(start: number, end: number) {
          expect(start).toBe(0);
          expect(end).toBe('invite-link'.length);
        },
      } as unknown as HTMLElement;

      expect(() => selectElementText(fakeInput)).not.toThrow();
      expect(selectElementText(fakeInput)).toBe(true);
    } finally {
      if (hadInput) {
        (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement = savedInput;
      }
      if (hadTextArea) {
        (globalThis as { HTMLTextAreaElement?: unknown }).HTMLTextAreaElement = savedTextArea;
      }
    }
  });
});
