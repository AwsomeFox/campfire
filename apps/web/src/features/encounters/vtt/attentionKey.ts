/**
 * The cockpit's "something is waiting on you" signal.
 *
 * The shell reopens (and scrolls back to) the panel whenever this key CHANGES, so the key
 * has to name every prompt that is currently up rather than whichever one wins a priority
 * order. With a priority ternary a second prompt arriving under a first left the key
 * untouched — a damage roll from the still-reachable dice tray while a concentration save
 * was already pending kept it at `concentration:<same id>` — and the new prompt stayed
 * inside a panel the viewer had collapsed or scrolled away from.
 *
 * Dismissing one of several also changes the key, which is right: the remaining prompts
 * shift up, and the panel should show where they now are.
 */
/** Ids are per-prompt sequences or opaque strings depending on the source; both work. */
export type WaitingPrompt = { id: string | number } | null | undefined;

/** `null` when nothing is waiting — the shell treats that as "no attention needed". */
export function waitingPromptsKey(entries: ReadonlyArray<readonly [string, WaitingPrompt]>): string | null {
  const parts: string[] = [];
  for (const [kind, prompt] of entries) {
    if (prompt) parts.push(`${kind}:${prompt.id}`);
  }
  return parts.length > 0 ? parts.join('|') : null;
}
