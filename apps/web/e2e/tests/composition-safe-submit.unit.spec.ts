/**
 * Composition-safe submit helpers (issue #854).
 *
 * Pins IME / assistive composition behaviour for Enter-to-create surfaces:
 *   - Japanese / Chinese / Korean composition Enter must not submit;
 *   - keyCode 229 (legacy IME processing) must not submit;
 *   - the follow-up Enter after compositionend must not double-submit;
 *   - ordinary Enter (no composition) still submits;
 *   - Escape during composition must not dismiss the editor;
 *   - mobile / assistive composition uses the same compositionstart/end path.
 *
 * Pure unit test — no backend, no browser — runs under pw-unit.config.ts.
 */
import { expect, test } from '@playwright/test';
import {
  IME_PROCESSING_KEY_CODE,
  compositionSafeEscapeHandler,
  compositionSafeFormSubmit,
  compositionSafeKeySubmit,
  createCompositionSubmitGate,
  isImeComposing,
  setCompositionClearSchedulerForTest,
} from '../../src/lib/compositionSafeSubmit';

type Scheduled = () => void;

function installImmediateClear() {
  const pending: Scheduled[] = [];
  setCompositionClearSchedulerForTest((fn) => {
    pending.push(fn);
  });
  return {
    flush() {
      while (pending.length) pending.shift()!();
    },
  };
}

test.afterEach(() => {
  setCompositionClearSchedulerForTest(null);
});

test.describe('isImeComposing', () => {
  test('detects React isComposing and nativeEvent.isComposing', () => {
    expect(isImeComposing({ key: 'Enter', isComposing: true })).toBe(true);
    expect(isImeComposing({ key: 'Enter', nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeComposing({ key: 'Enter', isComposing: false, nativeEvent: { isComposing: false } })).toBe(
      false,
    );
  });

  test('detects legacy keyCode 229 used by older IME engines', () => {
    expect(isImeComposing({ key: 'Enter', keyCode: IME_PROCESSING_KEY_CODE })).toBe(true);
    expect(isImeComposing({ key: 'Enter', nativeEvent: { keyCode: IME_PROCESSING_KEY_CODE } })).toBe(true);
    expect(isImeComposing({ key: 'Enter', keyCode: 13 })).toBe(false);
  });
});

test.describe('composition submit gate (issue #854)', () => {
  test('ordinary Enter submits; Japanese/Chinese/Korean composition Enter does not', () => {
    const gate = createCompositionSubmitGate({ scheduleClear: () => {} });
    const calls: string[] = [];
    const onKey = compositionSafeKeySubmit(gate, () => {
      calls.push('submit');
    });

    onKey({ key: 'Enter' });
    expect(calls).toEqual(['submit']);

    // Japanese / Chinese / Korean (and mobile assistive) composition session.
    gate.onCompositionStart();
    onKey({ key: 'Enter', isComposing: true });
    onKey({ key: 'Enter', nativeEvent: { isComposing: true } });
    onKey({ key: 'Enter', keyCode: IME_PROCESSING_KEY_CODE });
    expect(calls).toEqual(['submit']);
    expect(gate.shouldIgnoreSubmit({ key: 'Enter', isComposing: true })).toBe(true);
  });

  test('prevents duplicate submission after compositionend confirm Enter', () => {
    const clear = installImmediateClear();
    const keyGate = createCompositionSubmitGate();
    const formGate = createCompositionSubmitGate();
    const calls: string[] = [];
    const onKey = compositionSafeKeySubmit(keyGate, () => {
      calls.push('key');
    });
    const onSubmit = compositionSafeFormSubmit(formGate, () => {
      calls.push('form');
    });

    // Keyboard path: confirm candidate (e.g. 東京) — engines often emit Enter after end.
    keyGate.onCompositionStart();
    keyGate.onCompositionEnd();
    onKey({ key: 'Enter', isComposing: false });
    expect(calls).toEqual([]);

    // Form path: the same confirm Enter can submit the semantic form instead.
    formGate.onCompositionStart();
    formGate.onCompositionEnd();
    onSubmit({ preventDefault() {} });
    expect(calls).toEqual([]);

    clear.flush();
    onKey({ key: 'Enter' });
    onSubmit({ preventDefault() {} });
    expect(calls).toEqual(['key', 'form']);
  });

  test('form submit is ignored while composition is active', () => {
    const gate = createCompositionSubmitGate({ scheduleClear: () => {} });
    let submitted = 0;
    const onSubmit = compositionSafeFormSubmit(gate, () => {
      submitted += 1;
    });

    gate.onCompositionStart();
    onSubmit({ preventDefault() {} });
    expect(submitted).toBe(0);

    gate.onCompositionEnd();
    // Still suppressed for the compositionend follow-up.
    onSubmit({ preventDefault() {} });
    expect(submitted).toBe(0);

    // Fresh gate state after clear — ordinary submit works.
    gate.clear();
    onSubmit({ preventDefault() {} });
    expect(submitted).toBe(1);
  });

  test('Escape does not cancel the editor while composition is active', () => {
    const gate = createCompositionSubmitGate({ scheduleClear: () => {} });
    const calls: string[] = [];
    const onKey = compositionSafeKeySubmit(
      gate,
      () => {
        calls.push('submit');
      },
      {
        onEscape: () => {
          calls.push('escape');
        },
      },
    );
    const onEscapeOnly = compositionSafeEscapeHandler(gate, () => {
      calls.push('escape-only');
    });

    onKey({ key: 'Escape' });
    onEscapeOnly({ key: 'Escape' });
    expect(calls).toEqual(['escape', 'escape-only']);

    gate.onCompositionStart();
    onKey({ key: 'Escape', isComposing: true });
    onKey({ key: 'Escape', keyCode: IME_PROCESSING_KEY_CODE });
    onEscapeOnly({ key: 'Escape', isComposing: true });
    // Escape-only must not steal Enter from a semantic form.
    onEscapeOnly({ key: 'Enter' });
    expect(calls).toEqual(['escape', 'escape-only']);

    gate.onCompositionEnd();
    onKey({ key: 'Escape' });
    expect(calls).toEqual(['escape', 'escape-only', 'escape']);
  });

  test('Chinese and Korean composition sessions share the same ignore path', () => {
    const gate = createCompositionSubmitGate({ scheduleClear: () => {} });
    let submitted = 0;
    const onKey = compositionSafeKeySubmit(gate, () => {
      submitted += 1;
    });

    // Chinese Pinyin session.
    gate.onCompositionStart();
    onKey({ key: 'Enter', isComposing: true });
    gate.onCompositionEnd();
    expect(submitted).toBe(0);

    gate.clear();

    // Korean Hangul session (same events; different script only at the OS IME).
    gate.onCompositionStart();
    onKey({ key: 'Enter', nativeEvent: { isComposing: true } });
    expect(gate.isComposing()).toBe(true);
    gate.onCompositionEnd();
    expect(submitted).toBe(0);
  });
});
