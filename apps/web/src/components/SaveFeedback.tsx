import { useId, useReducer } from 'react';
import { initialSaveFeedback, reduceSaveFeedback, type SaveFeedbackState } from './saveFeedbackState';

export type { SaveFeedbackState } from './saveFeedbackState';

export function formatSavedAt(at: Date): string {
  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatSaveFailure(subject: string, error: string): string {
  // Collapse ONLY the app's own generic no-detail fallback strings (e.g. "Couldn't save
  // changes.", "Couldn't save the provider.") into the standard message below. The object
  // is matched with `[^.]+` (not the greedy `.+` this used to be) so a single-line match
  // cannot cross a sentence boundary — a multi-sentence server error like "Couldn't save
  // the provider. Check your API key." no longer matches, and its actionable detail past
  // the first period survives into the generic branch below instead of being discarded
  // (issue #756 review: Devin).
  if (/^could(?:n['’]t| not) save\s+[^.]+[.]?$/i.test(error)) {
    return `Save failed for ${subject}. Your edits are still here; try again.`;
  }
  return `Save failed for ${subject}. ${error.replace(/[.]$/, '')}. Your edits are still here; try again.`;
}

/** Shared explicit-save state. A result stays visible until the next edit or reset. */
export function useSaveFeedback(subject: string) {
  const [{ state, error, savedAt }, dispatch] = useReducer(reduceSaveFeedback, initialSaveFeedback);
  const statusId = useId();

  return {
    state, error, savedAt, statusId,
    markDirty: () => dispatch({ type: 'edit' }),
    /** Reconcile an editor's real draft-vs-baseline result; no-op edits retain Saved. */
    syncDirty: (dirty: boolean) => {
      if (dirty) dispatch({ type: 'edit' });
      else if (state !== 'saved' && state !== 'idle') dispatch({ type: 'reset' });
    },
    begin: () => dispatch({ type: 'begin' }),
    succeed: () => dispatch({ type: 'succeed', at: new Date() }),
    fail: (message: string) => dispatch({ type: 'fail', error: message }),
    reset: () => dispatch({ type: 'reset' }),
    announcement: <SaveFeedback subject={subject} state={state} error={error} savedAt={savedAt} id={statusId} />,
  };
}

export function SaveFeedback({ subject, state, error, savedAt, id }: {
  subject: string; state: SaveFeedbackState; error: string | null; savedAt: Date | null; id?: string;
}) {
  if (state === 'error' && error) {
    return <p id={id} role="alert" aria-live="assertive" className="text-xs text-rose-400" style={{ margin: 0 }}>
      {formatSaveFailure(subject, error)}
    </p>;
  }
  const message = state === 'dirty' ? `${subject} has unsaved changes.`
    : state === 'saving' ? `Saving ${subject}…`
    : state === 'saved' && savedAt ? `${subject} saved ${formatSavedAt(savedAt)}.`
    : '';
  return <p id={id} role="status" aria-live="polite" aria-atomic="true" className="text-xs text-muted" style={{ margin: 0 }}>
    {message}
  </p>;
}
