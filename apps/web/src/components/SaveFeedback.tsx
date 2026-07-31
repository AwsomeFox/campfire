import { useId, useReducer } from 'react';
import { useTranslation } from 'react-i18next';
import { initialSaveFeedback, reduceSaveFeedback, type SaveFeedbackState } from './saveFeedbackState';
import { formatDateTime } from '../lib/format';

export type { SaveFeedbackState } from './saveFeedbackState';

export function formatSavedAt(at: Date): string {
  return formatDateTime(at);
}

export interface SaveFailureCopy {
  generic: (subject: string) => string;
  withDetail: (subject: string, error: string) => string;
}

const DEFAULT_SAVE_FAILURE_COPY: SaveFailureCopy = {
  generic: (subject) => `Save failed for ${subject}. Your edits are still here; try again.`,
  withDetail: (subject, error) => `Save failed for ${subject}. ${error}. Your edits are still here; try again.`,
};

export function formatSaveFailure(
  subject: string,
  error: string,
  copy: SaveFailureCopy = DEFAULT_SAVE_FAILURE_COPY,
  generic = false,
): string {
  // Collapse ONLY the app's own generic no-detail fallback strings (e.g. "Couldn't save
  // changes.", "Couldn't save the provider.") into the standard message below. The object
  // is matched with `[^.]+` (not the greedy `.+` this used to be) so a single-line match
  // cannot cross a sentence boundary — a multi-sentence server error like "Couldn't save
  // the provider. Check your API key." no longer matches, and its actionable detail past
  // the first period survives into the generic branch below instead of being discarded
  // (issue #756 review: Devin).
  if (generic || /^could(?:n['’]t| not) save\s+[^.]+[.]?$/i.test(error)) {
    return copy.generic(subject);
  }
  return copy.withDetail(subject, error.replace(/[.]$/, ''));
}

/** Shared explicit-save state. A result stays visible until the next edit or reset. */
export function useSaveFeedback(subject: string) {
  const [{ state, error, savedAt, genericError }, dispatch] = useReducer(reduceSaveFeedback, initialSaveFeedback);
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
    fail: (message: string, options?: { generic?: boolean }) => dispatch({
      type: 'fail',
      error: message,
      generic: options?.generic,
    }),
    reset: () => dispatch({ type: 'reset' }),
    announcement: (
      <SaveFeedback
        subject={subject}
        state={state}
        error={error}
        savedAt={savedAt}
        genericError={genericError}
        id={statusId}
      />
    ),
  };
}

export function SaveFeedback({ subject, state, error, savedAt, genericError = false, id }: {
  subject: string;
  state: SaveFeedbackState;
  error: string | null;
  savedAt: Date | null;
  genericError?: boolean;
  id?: string;
}) {
  const { t } = useTranslation();
  if (state === 'error' && error) {
    return <p id={id} role="alert" aria-live="assertive" className="text-xs text-rose-400" style={{ margin: 0 }}>
      {formatSaveFailure(
        subject,
        error,
        {
          generic: (failureSubject) => t('common.saveFeedback.failure', { subject: failureSubject }),
          withDetail: (failureSubject, failureError) => t('common.saveFeedback.failureWithDetail', {
            subject: failureSubject,
            error: failureError,
          }),
        },
        genericError,
      )}
    </p>;
  }
  const message = state === 'dirty' ? t('common.saveFeedback.dirty', { subject })
    : state === 'saving' ? t('common.saveFeedback.saving', { subject })
    : state === 'saved' && savedAt ? t('common.saveFeedback.saved', { subject, savedAt: formatSavedAt(savedAt) })
    : '';
  return <p id={id} role="status" aria-live="polite" aria-atomic="true" className="text-xs text-muted" style={{ margin: 0 }}>
    {message}
  </p>;
}
