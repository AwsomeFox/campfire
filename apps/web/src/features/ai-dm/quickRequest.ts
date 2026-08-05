/**
 * Merging a #874 quick request (Simplify / Recap / Repeat turn cue / Explain) into whatever
 * the player already has in the AI table composer.
 *
 * The quick actions are SHORTCUTS into the one freeform field, which is the constraint the
 * issue's own title states. That makes assignment the wrong operation: the buttons sit
 * directly above the textarea and are live whenever the composer is unlocked, so replacing
 * its contents discards a half-written action on one stray click, with no undo. Filling only
 * when the field is empty avoids the data loss but makes the button do nothing visible
 * mid-composition, which reads as broken. Appending keeps both, and the player edits or
 * deletes either before sending — the composer is still just a textarea.
 *
 * Extracted as a pure function so the behaviour is asserted directly, rather than inferred
 * from the shape of a JSX click handler.
 */
export function appendQuickRequest(current: string, request: string): string {
  const existing = current.trim();
  return existing ? `${existing}\n\n${request}` : request;
}
