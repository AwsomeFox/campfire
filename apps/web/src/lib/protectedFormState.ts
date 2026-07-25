/**
 * Pure helpers for protected long-form editors (issue #641).
 */

export type ProtectedFormSaveStatus = 'clean' | 'dirty' | 'draft-only' | 'saving';

export function deriveProtectedFormSaveStatus(opts: {
  dirty: boolean;
  saving: boolean;
  hasStoredDraft: boolean;
}): ProtectedFormSaveStatus {
  if (opts.saving) return 'saving';
  if (opts.dirty) return 'dirty';
  if (opts.hasStoredDraft) return 'draft-only';
  return 'clean';
}

export function protectedFormSaveStatusLabel(status: ProtectedFormSaveStatus): string {
  switch (status) {
    case 'dirty':
      return 'Unsaved changes';
    case 'draft-only':
      return 'Draft saved locally — not on the server yet';
    case 'saving':
      return 'Saving…';
    case 'clean':
    default:
      return '';
  }
}

/** Shallow string-key record equality — enough for sheet stat maps in tests. */
export function recordsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}
