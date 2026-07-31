import type { InboxSweepItemResult, Note } from '@campfire/schema';

/**
 * Resolves the display body/title for an inbox sweep item (issue #1718).
 *
 * Precedence:
 * 1. `item.body` returned directly by the server in the sweep result (bypasses client page limits).
 * 2. `itemBodies[item.noteId]` pre-sweep snapshot.
 * 3. `knownNotes[item.noteId]` from loaded open/history lists.
 * 4. undefined (triggers fallback "Note #id" in UI).
 */
export function resolveSweepItemBody(
  item: Pick<InboxSweepItemResult, 'noteId'> & { body?: string },
  itemBodies?: Record<number, string>,
  knownNotes?: Record<number, string>,
): string | undefined {
  if (item.body && item.body.trim() !== '') {
    return item.body;
  }
  if (itemBodies && itemBodies[item.noteId] && itemBodies[item.noteId].trim() !== '') {
    return itemBodies[item.noteId];
  }
  if (knownNotes && knownNotes[item.noteId] && knownNotes[item.noteId].trim() !== '') {
    return knownNotes[item.noteId];
  }
  return undefined;
}

/**
 * Collects bodies from all currently loaded notes (open + history) into a map by noteId.
 */
export function buildNoteBodiesMap(openNotes: Note[] = [], historyNotes: Note[] = []): Record<number, string> {
  const result: Record<number, string> = {};
  for (const n of historyNotes) {
    if (n.id && n.body) result[n.id] = n.body;
  }
  for (const n of openNotes) {
    if (n.id && n.body) result[n.id] = n.body;
  }
  return result;
}
