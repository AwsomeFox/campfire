import type { Role } from '@campfire/schema';
import type { RequestUser } from './user.types';

/**
 * Can `user` see this note? private -> author only; dm_shared -> author+dm;
 * party_shared -> everyone; whisper -> author + the single targeted recipient + any
 * DM (oversight, so the whisper still enters the campaign record — issue #127). A
 * non-target, non-DM member must NEVER see a whisper, and this is the single
 * server-side chokepoint every read path (GET, list, MCP) funnels through.
 *
 * Lifted out of NotesService into `common/` for issue #601: the moderation module
 * must apply the EXACT same rule when authorizing "may this reporter report this
 * note/whisper", and importing it from notes.service.ts would create a circular
 * module edge (NotesService now depends on ModerationService for pre-mutation
 * evidence capture). Re-exported from notes.service.ts so existing importers are
 * unaffected. The rule itself is unchanged.
 *
 * NOTE: this predicate deliberately does NOT know about soft-delete or moderation
 * quarantine — callers apply `deleted_at IS NULL` / `quarantined_at IS NULL`
 * themselves, because the moderation read paths must be able to reach a
 * quarantined row that every normal read hides.
 */
export function canSee(
  note: { authorUserId: string; visibility: string; recipientUserId?: string | null },
  user: RequestUser,
  role: Role,
): boolean {
  if (note.visibility === 'party_shared') return true;
  if (note.authorUserId === user.id) return true;
  if (note.visibility === 'dm_shared' && role === 'dm') return true;
  if (note.visibility === 'whisper') {
    if (note.recipientUserId === user.id) return true;
    if (role === 'dm') return true;
  }
  return false;
}
