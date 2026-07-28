export type SaveFeedbackState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export type SaveFeedbackSnapshot = { state: SaveFeedbackState; error: string | null; savedAt: Date | null };

export const initialSaveFeedback: SaveFeedbackSnapshot = { state: 'idle', error: null, savedAt: null };

export function reduceSaveFeedback(snapshot: SaveFeedbackSnapshot, event:
  | { type: 'edit' } | { type: 'begin' } | { type: 'succeed'; at: Date } | { type: 'fail'; error: string } | { type: 'reset' },
): SaveFeedbackSnapshot {
  switch (event.type) {
    case 'edit': return { state: 'dirty', error: null, savedAt: null };
    case 'begin': return { state: 'saving', error: null, savedAt: null };
    case 'succeed': return { state: 'saved', error: null, savedAt: event.at };
    case 'fail': return { state: 'error', error: event.error, savedAt: null };
    case 'reset': return initialSaveFeedback;
  }
}
