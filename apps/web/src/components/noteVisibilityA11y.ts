/**
 * Note visibility selector a11y vocabulary (issue #452).
 *
 * Exactly-one Private / DM / Party / Whisper choice with clear secret
 * implications for assistive tech.
 */

import type { Note } from '@campfire/schema';

export const NOTE_VISIBILITY_ORDER: ReadonlyArray<Note['visibility']> = [
  'private',
  'dm_shared',
  'party_shared',
  'whisper',
];

export const NOTE_VISIBILITY_GROUP_LABEL = 'Note visibility';

export const NOTE_VISIBILITY_LABEL: Record<Note['visibility'], string> = {
  private: 'Private',
  dm_shared: 'DM',
  party_shared: 'Party',
  whisper: 'Whisper',
};

/** Short consequence text for each scope — secrets are called out explicitly. */
export const NOTE_VISIBILITY_HELP: Record<Note['visibility'], string> = {
  private: 'Only you can read this note. The DM cannot see private notes.',
  dm_shared: 'Shared with the DM. Other players cannot read it.',
  party_shared: 'Visible to the whole party on this entity.',
  whisper: 'Secret to exactly one player plus the DM. Choose a recipient.',
};

export function noteVisibilityOptionLabel(visibility: Note['visibility']): string {
  return `${NOTE_VISIBILITY_LABEL[visibility]} — ${NOTE_VISIBILITY_HELP[visibility]}`;
}

export const NOTE_BODY_LABEL = 'Note body';
export const NOTE_BODY_HELP = 'Private by default until you pick a visibility scope below.';
export const NOTE_EDIT_BODY_LABEL = 'Note';
export const NOTE_EDIT_BODY_HELP = 'Edit the note body. Markdown is supported.';
export const NOTE_EDIT_ANCHOR_LABEL = 'Attach to';
export const NOTE_EDIT_AUDIENCE_LABEL = 'Who can see this';
