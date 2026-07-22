import { expect, test } from '@playwright/test';
import {
  initialUploadState,
  isPreviewUncommitted,
  reduceUpload,
  shouldRevokeStaged,
  visiblePreview,
  type UploadSnapshot,
} from '../../src/components/imageUploadState';

/**
 * Issue #583: an uncommitted local preview (object URL) must never be
 * indistinguishable from a stored attachment. These tests pin the pure state
 * model that drives the ImageUpload badge/border/affordances — the component's
 * only job is to render the snapshot and dispatch the events exercised here.
 *
 * The model is DOM-free, so we can cover every transition (incl. the leak-prone
 * ones: replace, discard, commit handoff) without a browser.
 */
const STAGED = 'blob:http://127.0.0.1:5173/pending-preview';
const COMMITTED = '/api/v1/attachments/42/file?v=abc';
const FALLBACK = '/api/v1/attachments/7/file?v=old';

function from(partial: Partial<UploadSnapshot>): UploadSnapshot {
  return { ...initialUploadState, ...partial };
}

test.describe('image upload preview-vs-stored state (issue #583)', () => {
  test('idle falls back to the committed preview and is not flagged uncommitted', () => {
    const snap = initialUploadState;
    expect(visiblePreview(snap, FALLBACK)).toBe(FALLBACK);
    expect(visiblePreview(snap, null)).toBeNull();
    expect(isPreviewUncommitted(snap, FALLBACK)).toBe(false);
  });

  test('select stages the local preview and marks it uncommitted', () => {
    const snap = reduceUpload(initialUploadState, { type: 'select', stagedUrl: STAGED });
    expect(snap).toMatchObject({ status: 'uploading', stagedPreview: STAGED });
    // The staged preview wins over any committed fallback — it reflects intent.
    expect(visiblePreview(snap, FALLBACK)).toBe(STAGED);
    expect(isPreviewUncommitted(snap, FALLBACK)).toBe(true);
  });

  test('bytes-stored keeps the staged preview but flips to saving (badge changes, not truth)', () => {
    const staged = reduceUpload(initialUploadState, { type: 'select', stagedUrl: STAGED });
    const saving = reduceUpload(staged, { type: 'bytes-stored', committedUrl: COMMITTED });
    expect(saving).toMatchObject({ status: 'saving', committedUrl: COMMITTED, stagedPreview: STAGED });
    // Still shows the staged local preview (bytes are stored but the page link is pending).
    expect(visiblePreview(saving, FALLBACK)).toBe(STAGED);
    expect(isPreviewUncommitted(saving, FALLBACK)).toBe(true);
  });

  test('commit success drops the staged preview so the caller previewUrl becomes truth', () => {
    const staged = reduceUpload(initialUploadState, { type: 'select', stagedUrl: STAGED });
    const saving = reduceUpload(staged, { type: 'bytes-stored', committedUrl: COMMITTED });
    const done = reduceUpload(saving, { type: 'reset' });
    expect(done).toMatchObject({ status: 'idle', stagedPreview: null });
    expect(visiblePreview(done, FALLBACK)).toBe(FALLBACK);
    expect(isPreviewUncommitted(done, FALLBACK)).toBe(false);
  });

  test('upload-failed retains the staged preview for retry but marks it failed (never read as saved)', () => {
    const staged = reduceUpload(initialUploadState, { type: 'select', stagedUrl: STAGED });
    const failed = reduceUpload(staged, { type: 'upload-failed', error: 'network reset' });
    expect(failed).toMatchObject({ status: 'failed', stagedPreview: STAGED, error: 'network reset' });
    // The preview is still visible (so Retry/Discard are meaningful)…
    expect(visiblePreview(failed, FALLBACK)).toBe(STAGED);
    // …but it is flagged uncommitted so the badge reads "Not saved".
    expect(isPreviewUncommitted(failed, FALLBACK)).toBe(true);
  });

  test('commit-failed is a separate recoverable state: bytes stored but link failed', () => {
    const staged = reduceUpload(initialUploadState, { type: 'select', stagedUrl: STAGED });
    const saving = reduceUpload(staged, { type: 'bytes-stored', committedUrl: COMMITTED });
    const failed = reduceUpload(saving, { type: 'commit-failed', committedUrl: COMMITTED, error: '409' });
    // The attachment exists server-side (committedUrl retained) but the page link failed.
    expect(failed).toMatchObject({ status: 'failed', committedUrl: COMMITTED, error: '409' });
    expect(isPreviewUncommitted(failed, FALLBACK)).toBe(true);
  });

  test('retry re-enters uploading from failed and clears the error', () => {
    const staged = reduceUpload(initialUploadState, { type: 'select', stagedUrl: STAGED });
    const failed = reduceUpload(staged, { type: 'upload-failed', error: 'boom' });
    const retry = reduceUpload(failed, { type: 'retry' });
    expect(retry).toMatchObject({ status: 'uploading', stagedPreview: STAGED, error: null });
    // Same staged preview, still uncommitted.
    expect(isPreviewUncommitted(retry, FALLBACK)).toBe(true);
  });

  test('discard resets to idle and drops the staged preview', () => {
    const staged = reduceUpload(initialUploadState, { type: 'select', stagedUrl: STAGED });
    const failed = reduceUpload(staged, { type: 'upload-failed', error: 'boom' });
    const discarded = reduceUpload(failed, { type: 'discard' });
    expect(discarded).toEqual(initialUploadState);
    // After discard the committed fallback shows again.
    expect(visiblePreview(discarded, FALLBACK)).toBe(FALLBACK);
    expect(isPreviewUncommitted(discarded, FALLBACK)).toBe(false);
  });

  test.describe('object URL revocation (leak fix)', () => {
    test('revoke when the staged URL is cleared on discard', () => {
      const prev = from({ status: 'failed', stagedPreview: STAGED });
      const next = reduceUpload(prev, { type: 'discard' });
      expect(shouldRevokeStaged(prev, next)).toBe(true);
    });

    test('revoke when the staged URL is cleared on reset (commit handoff)', () => {
      const prev = from({ status: 'saving', stagedPreview: STAGED, committedUrl: COMMITTED });
      const next = reduceUpload(prev, { type: 'reset' });
      expect(shouldRevokeStaged(prev, next)).toBe(true);
    });

    test('revoke the old URL when a new file replaces a staged preview mid-flow', () => {
      const STAGED_2 = 'blob:http://127.0.0.1:5173/second-pending-preview';
      const prev = from({ status: 'uploading', stagedPreview: STAGED });
      const next = reduceUpload(prev, { type: 'select', stagedUrl: STAGED_2 });
      expect(next.stagedPreview).toBe(STAGED_2);
      expect(shouldRevokeStaged(prev, next)).toBe(true);
    });

    test('do NOT revoke while the same staged URL stays (uploading -> failed -> retry)', () => {
      const uploading = from({ status: 'uploading', stagedPreview: STAGED });
      const failed = reduceUpload(uploading, { type: 'upload-failed', error: 'x' });
      expect(shouldRevokeStaged(uploading, failed)).toBe(false);
      const retry = reduceUpload(failed, { type: 'retry' });
      expect(shouldRevokeStaged(failed, retry)).toBe(false);
    });

    test('do NOT revoke when there was never a staged URL (idle transitions)', () => {
      const next = reduceUpload(initialUploadState, { type: 'reset' });
      expect(shouldRevokeStaged(initialUploadState, next)).toBe(false);
    });
  });

  test('the full happy path: select -> bytes-stored -> reset, preview flagged uncommitted until the end', () => {
    let snap: UploadSnapshot = initialUploadState;
    snap = reduceUpload(snap, { type: 'select', stagedUrl: STAGED });
    expect(isPreviewUncommitted(snap, FALLBACK)).toBe(true);
    snap = reduceUpload(snap, { type: 'bytes-stored', committedUrl: COMMITTED });
    expect(isPreviewUncommitted(snap, FALLBACK)).toBe(true);
    snap = reduceUpload(snap, { type: 'reset' });
    expect(isPreviewUncommitted(snap, FALLBACK)).toBe(false);
    expect(visiblePreview(snap, FALLBACK)).toBe(FALLBACK);
  });

  test('the interrupted path: select -> upload-failed -> discard returns cleanly to the committed fallback', () => {
    let snap: UploadSnapshot = initialUploadState;
    snap = reduceUpload(snap, { type: 'select', stagedUrl: STAGED });
    snap = reduceUpload(snap, { type: 'upload-failed', error: 'offline' });
    expect(isPreviewUncommitted(snap, FALLBACK)).toBe(true);
    snap = reduceUpload(snap, { type: 'discard' });
    expect(isPreviewUncommitted(snap, FALLBACK)).toBe(false);
    expect(visiblePreview(snap, FALLBACK)).toBe(FALLBACK);
  });
});
