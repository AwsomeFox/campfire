export function toJsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJsonText<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Recursively sort object keys so two values that differ only in key insertion order
 * still canonicalize to the same JSON text. Array element order is NOT normalized — it is
 * semantically significant for an ordered list value. */
function canonicalizeForCompare(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForCompare);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalizeForCompare((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Deep-equality by canonical JSON (issue #1992, round 5): used for a content-based
 * optimistic-concurrency guard where a row-level revision token is the wrong granularity
 * (see encounters.service.ts's `expectedStatblock` check) — comparing the actual stored
 * value against what a caller says it started from, instead of a proxy timestamp that
 * advances on writes to unrelated fields of the same row.
 */
export function deepJsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalizeForCompare(a)) === JSON.stringify(canonicalizeForCompare(b));
}
