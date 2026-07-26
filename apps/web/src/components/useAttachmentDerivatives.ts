/**
 * Responsive-derivative status for a map attachment (issue #604).
 *
 * The server generates downscaled map derivatives in the background, so a map is
 * briefly servable ONLY as its original after upload, and generation can fail.
 * Both map surfaces (the dashboard world map and the encounter battle map) need
 * the same four user-visible states, which this hook supplies:
 *
 *   loading  — we have not yet learned anything about this attachment.
 *   processing — derivatives are being generated. The original still renders, so
 *                the map is USABLE; the badge exists to explain why the first load
 *                is heavy and to promise it gets better.
 *   stale    — a ready derivative was generated from source bytes that have since
 *              been replaced (a restore that reused an attachment id). The image on
 *              screen may be the previous map, so say so rather than lying.
 *   error    — generation failed. Recovery is a DM-only "Retry" that re-plans the
 *              ladder; players see the explanation without the button.
 *
 * While `processing`, the hook re-polls on a slow interval. It deliberately does
 * NOT poll forever: after MAX_POLLS it stops and leaves the last known state, so a
 * tab left open on a permanently-stuck attachment cannot generate traffic all day.
 * A remount (or the DM's retry) starts a fresh polling window.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttachmentDerivativeManifest } from '@campfire/schema';
import { api, API, ApiError } from '../lib/api';

/** Poll cadence while derivatives are generating. */
const POLL_MS = 3000;
/** Give up polling after ~90s of "processing" — see the module note above. */
const MAX_POLLS = 30;

export interface AttachmentDerivativesState {
  manifest: AttachmentDerivativeManifest | null;
  /** True until the first manifest fetch settles (success or failure). */
  loading: boolean;
  /** True while at least one rung is still being generated. */
  processing: boolean;
  /** True when a ready rung was built from source bytes that have since changed. */
  stale: boolean;
  /** Non-null when the manifest itself could not be read, or generation failed. */
  error: string | null;
  /** DM-only recovery: re-plan the ladder and immediately re-read the manifest. */
  retry: () => Promise<void>;
  /** True while a retry request is in flight. */
  retrying: boolean;
}

/**
 * Convenience wrapper for a plain attachment (the dashboard world map): reads the
 * attachment's own manifest and offers the DM-only retry on the same attachment.
 */
export function useAttachmentDerivatives(attachmentId: number | null): AttachmentDerivativesState {
  return useDerivativeManifest(
    attachmentId != null ? `${API}/attachments/${attachmentId}/derivatives` : null,
    attachmentId != null ? `${API}/attachments/${attachmentId}/derivatives/retry` : null,
  );
}

/**
 * Read a derivative manifest from `manifestUrl`, polling while it reports
 * `processing`. `retryUrl` (when non-null) enables the recovery action.
 *
 * The URL is a parameter rather than an attachment id because the encounter battle
 * map must read its ladder through the ROLE-SAFE encounter route (#463): a player
 * may never touch `/attachments/:id/...`, but they still need the rung dimensions
 * to build a responsive srcset for the fogged map they are allowed to see.
 */
export function useDerivativeManifest(
  manifestUrl: string | null,
  retryUrl: string | null,
): AttachmentDerivativesState {
  const [manifest, setManifest] = useState<AttachmentDerivativeManifest | null>(null);
  const [loading, setLoading] = useState(manifestUrl != null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // Bumped on unmount / id change so a late response cannot setState on a dead
  // surface or overwrite a newer attachment's manifest.
  const generation = useRef(0);

  const load = useCallback(
    async (gen: number): Promise<AttachmentDerivativeManifest | null> => {
      if (manifestUrl == null) return null;
      try {
        const next = await api.get<AttachmentDerivativeManifest>(manifestUrl);
        if (gen !== generation.current) return null;
        setManifest(next);
        setError(null);
        return next;
      } catch (err) {
        if (gen !== generation.current) return null;
        // A 404 here means the attachment is hidden from this viewer or gone —
        // not a derivative problem. Surface nothing; the surrounding surface
        // already handles a missing map.
        if (err instanceof ApiError && err.status === 404) {
          setManifest(null);
          setError(null);
          return null;
        }
        setError(err instanceof ApiError ? err.message : String(err));
        return null;
      } finally {
        if (gen === generation.current) setLoading(false);
      }
    },
    [manifestUrl],
  );

  useEffect(() => {
    const gen = ++generation.current;
    setManifest(null);
    setError(null);
    setLoading(manifestUrl != null);
    if (manifestUrl == null) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let polls = 0;

    const tick = async () => {
      const next = await load(gen);
      if (gen !== generation.current) return;
      polls += 1;
      if (next?.status === 'processing' && polls < MAX_POLLS) {
        timer = setTimeout(() => void tick(), POLL_MS);
      }
    };
    void tick();

    return () => {
      generation.current += 1;
      if (timer) clearTimeout(timer);
    };
  }, [manifestUrl, load]);

  const retry = useCallback(async () => {
    if (retryUrl == null || retrying) return;
    setRetrying(true);
    try {
      const next = await api.post<AttachmentDerivativeManifest>(retryUrl, {});
      setManifest(next);
      setError(null);
      // Re-enter the polling window so the surface flips processing → ready on
      // its own once the background drain finishes.
      const gen = generation.current;
      let polls = 0;
      const tick = async () => {
        const latest = await load(gen);
        if (gen !== generation.current) return;
        polls += 1;
        if (latest?.status === 'processing' && polls < MAX_POLLS) {
          setTimeout(() => void tick(), POLL_MS);
        }
      };
      setTimeout(() => void tick(), POLL_MS);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }, [retryUrl, load, retrying]);

  return {
    manifest,
    loading,
    processing: manifest?.status === 'processing',
    stale: manifest?.stale === true,
    // A `failed` manifest IS an error even though the request succeeded — that is
    // the whole point of reporting per-rung state instead of only HTTP status.
    error: error ?? (manifest?.status === 'failed' ? derivativeFailureMessage(manifest) : null),
    retry,
    retrying,
  };
}

/** First real generator error from a failed manifest, for the surface's error note. */
function derivativeFailureMessage(manifest: AttachmentDerivativeManifest): string {
  const failed = manifest.derivatives.find((d) => d.state === 'failed' && d.lastError !== '');
  return failed?.lastError ?? 'Map derivative generation failed.';
}
