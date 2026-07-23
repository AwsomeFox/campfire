/** Decode a location.hash fragment; fall back to the raw id if percent-encoding is invalid. */
export function decodeLocationHashId(hash: string): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
