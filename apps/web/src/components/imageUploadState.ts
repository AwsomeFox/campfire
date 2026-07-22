/**
 * Pure reducer for the ImageUpload preview-vs-stored lifecycle (issue #583).
 *
 * The bug this fixes: an object URL created on file-select was shown as the
 * preview immediately, indistinguishable from a confirmed attachment. If the
 * upload failed or the linking PATCH failed, the preview stayed — so a user
 * could navigate away believing an image was saved when only a local blob
 * existed. This module separates the two states in DATA so the component can
 * separate them VISUALLY.
 *
 * Kept pure (no React, no DOM, no `URL.createObjectURL`) so it can be exercised
 * exhaustively in a Playwright `.unit.spec.ts` without a browser. The component
 * owns the side-effectful bits: it creates/revokes object URLs, calls
 * `uploadAttachment`, and dispatches the events below.
 *
 * States (a progression — see `UploadStatus`):
 *   - idle      nothing pending; `shown` is the committed `previewUrl` (or empty)
 *   - uploading a local preview is on screen but the byte upload is in flight
 *   - saving    bytes stored; the caller's onUploaded/linking PATCH is committing
 *   - failed    upload or commit rejected; the pending preview is retained ONLY
 *               so the user can Retry or Discard it explicitly (it is never
 *               presented as a saved image)
 *   - committed onUploaded resolved; the pending preview is gone and `shown`
 *               reflects the freshly stored attachment via the caller-supplied url
 *
 * The reducer's rule of thumb: an object URL is a STAGED preview, never truth.
 * Only a resolved attachment is truth, and even then the host page must still
 * link it. So every terminal/reset path tells the component to revoke the staged
 * URL (see `shouldRevokeStaged`), preventing the blob leak from issue #583.
 */
import type { Attachment } from '@campfire/schema';

export type UploadStatus = 'idle' | 'uploading' | 'saving' | 'failed' | 'committed';

/** Terminal/observable subset of state the component renders. */
export interface UploadSnapshot {
  status: UploadStatus;
  /** Staged local preview (object URL) — present only while a new file is in flight or failed. */
  stagedPreview: string | null;
  /** URL of the freshly stored attachment, set the moment onUploaded succeeds. */
  committedUrl: string | null;
  /** Last error message, surfaced as the "Failed — Retry / Discard" affordance. */
  error: string | null;
}

export const initialUploadState: UploadSnapshot = {
  status: 'idle',
  stagedPreview: null,
  committedUrl: null,
  error: null,
};

/** Events the component dispatches. `payload.url` is the object URL it created. */
export type UploadEvent =
  | { type: 'select'; stagedUrl: string }
  | { type: 'bytes-stored'; committedUrl: string }
  | { type: 'upload-failed'; error: string }
  | { type: 'commit-failed'; committedUrl: string; error: string }
  | { type: 'retry' }
  | { type: 'discard' }
  | { type: 'reset' };

/**
 * Advance the state machine. The component holds the staged object URL and a
 * `retryFile` ref outside the reducer (refs don't drive render and a File isn't
 * serializable state); the reducer only tracks what to RENDER and whether to
 * REVOKE the staged URL.
 */
export function reduceUpload(state: UploadSnapshot, event: UploadEvent): UploadSnapshot {
  switch (event.type) {
    case 'select':
      // New file chosen: stage its object URL and mark uploading. A previously
      // staged URL (e.g. user picked a second file mid-retry) is replaced — the
      // component revokes the old one via shouldRevokeStaged on the prior render.
      return { status: 'uploading', stagedPreview: event.stagedUrl, committedUrl: null, error: null };

    case 'bytes-stored':
      // The multipart POST succeeded and onUploaded is committing. Keep the
      // staged preview visible but flip the badge — the bytes are durably
      // stored even if the linking PATCH still has to land.
      return { ...state, status: 'saving', committedUrl: event.committedUrl, error: null };

    case 'upload-failed':
      // Byte upload rejected (network/4xx/5xx). Hold the staged preview so the
      // user can Retry/Discard — but mark it failed so it is never read as saved.
      return { ...state, status: 'failed', error: event.error };

    case 'commit-failed':
      // Bytes stored but the linking PATCH failed. The attachment exists server-
      // side, so we keep committedUrl (the host can retry the link) AND surface
      // the error — this is the issue #583 "separate recoverable state".
      return { ...state, status: 'failed', committedUrl: event.committedUrl, error: event.error };

    case 'retry':
      // Re-enter uploading from failed. The staged preview stays (same file);
      // only the error clears. The component re-issues uploadAttachment.
      return { ...state, status: 'uploading', error: null };

    case 'discard':
    case 'reset':
      // Drop the staged preview entirely. The component revokes the object URL.
      // committedUrl is cleared too: a discarded flow should not masquerade as
      // a stored attachment on the next render.
      return { ...initialUploadState };
    default: {
      // Exhaustiveness guard — if UploadEvent grows, this compile error flags it.
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

/**
 * What the component renders as the visible image. Order matters: a STAGED
 * preview wins over the committed/initial url because it reflects the user's
 * in-flight intent — but the component must badge it as uncommitted. When
 * nothing is staged we fall back to the caller's committed `previewUrl` (the
 * previously stored image) or the freshly committed url, then empty.
 */
export function visiblePreview(
  state: UploadSnapshot,
  fallback: string | null | undefined,
): string | null {
  if (state.stagedPreview) return state.stagedPreview;
  if (state.committedUrl) return state.committedUrl;
  return fallback ?? null;
}

/** Whether the rendered preview is an uncommitted local blob (needs a badge). */
export function isPreviewUncommitted(
  state: UploadSnapshot,
  fallback: string | null | undefined,
): boolean {
  return state.status !== 'committed' && state.stagedPreview === visiblePreview(state, fallback);
}

/**
 * Did this event transition AWAY from a staged preview, so the component must
 * revoke the old object URL to avoid a blob leak? We revoke on every path where
 * the staged URL is no longer shown: discard/reset (explicit), bytes-stored
 * followed by commit success (the component dispatches `reset` once the host's
 * onUploaded resolves), and select-with-prior-staged (replacing a preview).
 *
 * The reducer can't see the previous URL directly (it only gets the new state),
 * so this helper compares the previous and next snapshots. The component calls
 * it in a useEffect keyed on state.stagedPreview.
 */
export function shouldRevokeStaged(prev: UploadSnapshot, next: UploadSnapshot): boolean {
  // The staged URL went from set → unset (discard/reset/committed handoff).
  if (prev.stagedPreview && !next.stagedPreview) return true;
  // The staged URL changed (user picked a new file mid-flow) — revoke the old.
  if (prev.stagedPreview && next.stagedPreview && prev.stagedPreview !== next.stagedPreview) {
    return true;
  }
  return false;
}

/** Convenience: derive a snapshot from a resolved Attachment's file URL. */
export function snapshotForStoredAttachment(attachment: Attachment, fileUrl: string): UploadSnapshot {
  void attachment;
  return { status: 'committed', stagedPreview: null, committedUrl: fileUrl, error: null };
}
