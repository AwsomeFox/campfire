/**
 * Pure helpers for My Notes author editing (issue #784).
 *
 * Covers draft/baseline dirty detection, save payload construction (including the
 * optimistic-concurrency `expectedUpdatedAt` guard), save-status labels, conflict
 * compare, and the audience/recipient expansion check that mirrors the server's
 * notify-only-on-share gate — so UI copy and unit tests stay aligned with
 * notes.service update().
 */
import type { Note } from '@campfire/schema';
import type { EntityLink } from './EntityPicker';

export type NoteEditDraft = {
  body: string;
  visibility: Note['visibility'];
  /** Empty string when not a whisper (or recipient not yet chosen). */
  recipientUserId: string;
  attach: EntityLink | null;
};

export type NoteEditBaseline = NoteEditDraft & {
  updatedAt: string;
};

export type NoteSaveStatus = 'clean' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

export type NoteUpdatePayload = {
  body: string;
  visibility: Note['visibility'];
  recipientUserId: string | null;
  entityType: Note['entityType'];
  entityId: number | null;
  expectedUpdatedAt: string;
};

export type NoteConflictCompare = {
  bodyChanged: boolean;
  audienceChanged: boolean;
  anchorChanged: boolean;
  draft: NoteEditDraft;
  server: NoteEditDraft;
};

export function draftFromNote(note: Note): NoteEditBaseline {
  const attach =
    note.entityType && note.entityId != null
      ? { entityType: note.entityType as EntityLink['entityType'], entityId: note.entityId }
      : null;
  return {
    body: note.body,
    visibility: note.visibility,
    recipientUserId: note.visibility === 'whisper' ? (note.recipientUserId ?? '') : '',
    attach,
    updatedAt: note.updatedAt,
  };
}

function attachKey(attach: EntityLink | null): string {
  return attach ? `${attach.entityType}:${attach.entityId}` : '';
}

function audienceKey(draft: Pick<NoteEditDraft, 'visibility' | 'recipientUserId'>): string {
  if (draft.visibility !== 'whisper') return draft.visibility;
  return `whisper:${draft.recipientUserId}`;
}

export function isNoteEditDirty(draft: NoteEditDraft, baseline: NoteEditDraft): boolean {
  return (
    draft.body !== baseline.body ||
    audienceKey(draft) !== audienceKey(baseline) ||
    attachKey(draft.attach) !== attachKey(baseline.attach)
  );
}

/** Whisper requires a recipient; body must be non-empty after trim. */
export function noteEditCanSave(draft: NoteEditDraft): boolean {
  if (!draft.body.trim()) return false;
  if (draft.visibility === 'whisper' && !draft.recipientUserId.trim()) return false;
  return true;
}

export function buildNoteUpdatePayload(draft: NoteEditDraft, expectedUpdatedAt: string): NoteUpdatePayload {
  return {
    body: draft.body.trim(),
    visibility: draft.visibility,
    recipientUserId: draft.visibility === 'whisper' ? draft.recipientUserId : null,
    entityType: draft.attach?.entityType ?? null,
    entityId: draft.attach?.entityId ?? null,
    expectedUpdatedAt,
  };
}

/**
 * Mirrors notes.service update() notify gates: DM/party share transitions and
 * whisper enter/retarget — not body or anchor typo fixes.
 */
export function audienceExpandedOrChanged(
  before: Pick<NoteEditDraft, 'visibility' | 'recipientUserId'>,
  after: Pick<NoteEditDraft, 'visibility' | 'recipientUserId'>,
): boolean {
  if (after.visibility === 'dm_shared' && before.visibility !== 'dm_shared') return true;
  if (after.visibility === 'party_shared' && before.visibility !== 'party_shared') return true;
  if (
    after.visibility === 'whisper' &&
    (before.visibility !== 'whisper' || before.recipientUserId !== after.recipientUserId)
  ) {
    return true;
  }
  return false;
}

export function compareNoteConflict(draft: NoteEditDraft, serverNote: Note): NoteConflictCompare {
  const server = draftFromNote(serverNote);
  return {
    bodyChanged: draft.body !== server.body,
    audienceChanged: audienceKey(draft) !== audienceKey(server),
    anchorChanged: attachKey(draft.attach) !== attachKey(server.attach),
    draft,
    server,
  };
}

export function noteSaveStatusLabel(status: NoteSaveStatus): string {
  switch (status) {
    case 'dirty':
      return 'Unsaved changes';
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Saved';
    case 'error':
      return "Couldn't save";
    case 'conflict':
      return 'Conflict — compare below';
    case 'clean':
    default:
      return '';
  }
}

/** Derive the footer status from editor flags (pure — easy to unit-test). */
export function deriveNoteSaveStatus(opts: {
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  error: boolean;
  conflict: boolean;
}): NoteSaveStatus {
  if (opts.saving) return 'saving';
  if (opts.conflict) return 'conflict';
  if (opts.error) return 'error';
  if (opts.saved && !opts.dirty) return 'saved';
  if (opts.dirty) return 'dirty';
  return 'clean';
}
