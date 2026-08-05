/**
 * Local draft persistence for long-form editors (issue #641).
 *
 * Namespaced by user + campaign + form id so shared devices and multi-campaign
 * users never collide. The envelope records the server `baselineUpdatedAt` at
 * draft start so callers can detect a stale restore after someone else saved.
 */

export const FORM_DRAFT_STORAGE_VERSION = 1 as const;

export type FormDraftEnvelope<T> = {
  v: typeof FORM_DRAFT_STORAGE_VERSION;
  savedAt: string;
  /** Server `updatedAt` when the draft baseline was captured. */
  baselineUpdatedAt: string | null;
  data: T;
};

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function formDraftStorageKey(userId: number, campaignId: number, formId: string): string {
  return `cf.formDraft.v${FORM_DRAFT_STORAGE_VERSION}:${userId}:${campaignId}:${formId}`;
}

export function defaultFormDraftStorage(): StorageLike | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

export function readFormDraft<T>(
  key: string,
  store: StorageLike | null = defaultFormDraftStorage(),
): FormDraftEnvelope<T> | null {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FormDraftEnvelope<T>;
    if (parsed?.v !== FORM_DRAFT_STORAGE_VERSION || parsed.data === undefined) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Returns true when the draft was written to storage. */
export function writeFormDraft<T>(
  key: string,
  envelope: FormDraftEnvelope<T>,
  store: StorageLike | null = defaultFormDraftStorage(),
): boolean {
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

export function clearFormDraft(key: string, store: StorageLike | null = defaultFormDraftStorage()): void {
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    /* private mode / quota */
  }
}

/**
 * True when the server record moved on after the draft baseline was captured.
 * When either timestamp is missing the draft is treated as fresh (no stale flag).
 */
function parseTimestampMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function isFormDraftStale(
  envelope: Pick<FormDraftEnvelope<unknown>, 'baselineUpdatedAt'>,
  currentUpdatedAt: string | null | undefined,
): boolean {
  if (!envelope.baselineUpdatedAt || !currentUpdatedAt) return false;
  const baselineMs = parseTimestampMs(envelope.baselineUpdatedAt);
  const currentMs = parseTimestampMs(currentUpdatedAt);
  if (baselineMs == null || currentMs == null) {
    return envelope.baselineUpdatedAt !== currentUpdatedAt;
  }
  return baselineMs !== currentMs;
}

export function buildFormDraftEnvelope<T>(
  data: T,
  baselineUpdatedAt: string | null | undefined,
  savedAt = new Date().toISOString(),
): FormDraftEnvelope<T> {
  return {
    v: FORM_DRAFT_STORAGE_VERSION,
    savedAt,
    baselineUpdatedAt: baselineUpdatedAt ?? null,
    data,
  };
}

/**
 * Normalizes a restored draft against a baseline instance (issue #1986).
 * Fills any missing or undefined top-level keys in storedData with values from baseline.
 * Performs a shallow merge on nested object properties as well, ensuring no newly-added
 * field in typed state silently restores as `undefined`.
 */
export function normalizeDraft<T>(storedData: unknown, baseline: T): T {
  if (storedData == null || typeof storedData !== 'object' || typeof baseline !== 'object' || baseline == null) {
    return (storedData ?? baseline) as T;
  }

  if (Array.isArray(baseline)) {
    return (Array.isArray(storedData) ? storedData : baseline) as T;
  }

  const result: Record<string, unknown> = {
    ...(baseline as Record<string, unknown>),
    ...(storedData as Record<string, unknown>),
  };

  for (const key of Object.keys(baseline as Record<string, unknown>)) {
    const baseVal = (baseline as Record<string, unknown>)[key];
    const storedVal = result[key];

    if (storedVal === undefined) {
      result[key] = baseVal;
    } else if (
      baseVal != null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal) &&
      storedVal != null &&
      typeof storedVal === 'object' &&
      !Array.isArray(storedVal)
    ) {
      result[key] = { ...(baseVal as Record<string, unknown>), ...(storedVal as Record<string, unknown>) };
    }
  }

  return result as T;
}
