/**
 * Pure model for the guided external-generator round trip (issue #411).
 *
 * External map generators (Watabou, donjon) are third-party sites Campfire only LINKS to —
 * it never fetches or scrapes them (that would risk bundling NC/ND content and would imply
 * an integration that doesn't exist). So the DM's journey is necessarily a round trip:
 * open the generator → generate + export an image there → return to Campfire → import the
 * file → calibrate the grid → attach. This module holds the two testable pieces of that
 * flow that don't need the DOM:
 *
 *   1. ACQUISITION STATE persistence — which generator the DM opened and hasn't finished
 *      importing from — so the "return checklist" survives navigation and reload (a DM who
 *      opens Watabou, tabs away to generate, and comes back must land back on the same card,
 *      not a blank menu).
 *   2. EXPORT VALIDATION — type / size / dimension checks with a human "how to fix it"
 *      message, mirroring the server's own guards (magic-byte sniff + storage quota) so the
 *      DM learns about a bad export before the upload round-trips and fails.
 *
 * Kept framework-free and side-effect-light (localStorage is injected implicitly via the
 * global, guarded for SSR/test) so a unit spec can pin the behaviour without a browser.
 */

/** Accepted image MIME types — matches the server sniff (png/jpeg/webp) and ImageUpload. */
export const ACCEPTED_EXPORT_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Max upload size — matches the server's MAX_UPLOAD_BYTES (32MB) so the client fails fast. */
export const MAX_EXPORT_BYTES = 32 * 1024 * 1024;

/**
 * Dimension guardrails. A usable battle/location map is at least a few hundred pixels a
 * side (a thumbnail-sized export is almost always the DM grabbing the wrong image); the
 * upper bound catches an accidental massive export that would blow the quota or choke the
 * canvas. These are advisory client-side checks — the server still owns the quota — but
 * catching them here lets us explain the fix instead of surfacing an opaque upload error.
 */
export const MIN_EXPORT_DIMENSION = 256;
export const MAX_EXPORT_DIMENSION = 12_288;

/** A human, one-megabyte-rounded size label for messages ("42.0 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export interface ExportCandidate {
  /** The browser-reported MIME type (may be '' for an unknown type). */
  type: string;
  /** Size in bytes. */
  size: number;
  /** Decoded pixel dimensions, when known (the card decodes them before import). */
  width?: number;
  height?: number;
}

/**
 * Describe what's wrong with a selected export and how to fix it, or null when it's good to
 * import. The messages are actionable ("re-export as PNG", "shrink it below 32 MB") rather
 * than bare rejections, per the issue's "explain how to fix invalid/oversized files".
 */
export function describeExportProblem(file: ExportCandidate): string | null {
  // Only reject a NON-EMPTY type that isn't in the accepted set. Some platforms/browsers
  // report an empty `type` for a legitimate PNG/JPEG/WebP; the server accepts by magic-byte
  // sniff, so blocking an empty type here would wrongly reject a valid export. Let it through
  // and let the server be the authority on the actual bytes.
  if (file.type && !(ACCEPTED_EXPORT_MIME as readonly string[]).includes(file.type)) {
    return (
      `Campfire can't import “${file.type}”. Most generators can export a PNG (best for maps), ` +
      'JPEG, or WebP — re-export in one of those and drop it here.'
    );
  }
  if (file.size > MAX_EXPORT_BYTES) {
    return (
      `That export is ${formatBytes(file.size)}, over the ${formatBytes(MAX_EXPORT_BYTES)} limit. ` +
      'Export at a smaller resolution, or save as JPEG/WebP instead of PNG to shrink it.'
    );
  }
  if (file.size === 0) {
    return 'That file is empty — the export may not have finished. Re-export and try again.';
  }
  if (file.width != null && file.height != null) {
    const min = Math.min(file.width, file.height);
    const max = Math.max(file.width, file.height);
    if (min < MIN_EXPORT_DIMENSION) {
      return (
        `That image is only ${file.width}×${file.height}px — too small to read as a map. ` +
        `Export at a higher resolution (at least ${MIN_EXPORT_DIMENSION}px on the shorter side).`
      );
    }
    if (max > MAX_EXPORT_DIMENSION) {
      return (
        `That image is ${file.width}×${file.height}px — larger than Campfire handles well. ` +
        `Export below ${MAX_EXPORT_DIMENSION}px on the longer side.`
      );
    }
  }
  return null;
}

/** Persisted "the DM opened this generator and hasn't imported yet" marker for one campaign. */
export interface AcquisitionState {
  /** The MapSource.id the DM opened (e.g. 'watabou-one-page-dungeon'). */
  sourceId: string;
  /** Epoch ms when "Open generator" was pressed — lets us expire a very stale marker. */
  openedAt: number;
}

/** How long an unfinished acquisition marker is honoured before it's treated as abandoned. */
export const ACQUISITION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const STORAGE_PREFIX = 'cf.mapAcquisition.';

/** Per-campaign storage key so two campaigns' in-progress round trips never collide. */
export function acquisitionKey(campaignId: number): string {
  return `${STORAGE_PREFIX}${campaignId}`;
}

/** localStorage, or null when it's unavailable (SSR / privacy mode) — never throws. */
function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Read the in-progress acquisition for a campaign, or null when there is none / it's
 * malformed / it has expired. A read that finds an expired marker clears it as a
 * side-effect so a long-abandoned round trip doesn't resurrect the checklist forever.
 */
export function loadAcquisition(campaignId: number, now: number): AcquisitionState | null {
  const store = safeStorage();
  if (!store) return null;
  const raw = store.getItem(acquisitionKey(campaignId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AcquisitionState>;
    if (typeof parsed?.sourceId !== 'string' || typeof parsed?.openedAt !== 'number') {
      clearAcquisition(campaignId);
      return null;
    }
    if (now - parsed.openedAt > ACQUISITION_TTL_MS) {
      clearAcquisition(campaignId);
      return null;
    }
    return { sourceId: parsed.sourceId, openedAt: parsed.openedAt };
  } catch {
    clearAcquisition(campaignId);
    return null;
  }
}

/** Record that the DM opened a generator and is mid round trip (persists across reload). */
export function saveAcquisition(campaignId: number, sourceId: string, now: number): AcquisitionState {
  const state: AcquisitionState = { sourceId, openedAt: now };
  const store = safeStorage();
  if (store) {
    try {
      store.setItem(acquisitionKey(campaignId), JSON.stringify(state));
    } catch {
      /* storage full / blocked — the in-memory state still drives this session */
    }
  }
  return state;
}

/** Forget the in-progress acquisition (on successful import or explicit "later"). */
export function clearAcquisition(campaignId: number): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.removeItem(acquisitionKey(campaignId));
  } catch {
    /* ignore */
  }
}
