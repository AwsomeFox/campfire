/** `?proposed=true` (or `1`) query param check for the propose-instead-of-write flow. */
export function isProposed(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}
