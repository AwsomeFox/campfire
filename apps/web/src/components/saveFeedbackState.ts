export type SaveFeedbackState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export type SaveFeedbackSnapshot = {
  state: SaveFeedbackState;
  error: string | null;
  savedAt: Date | null;
  genericError: boolean;
};

export const initialSaveFeedback: SaveFeedbackSnapshot = {
  state: 'idle',
  error: null,
  savedAt: null,
  genericError: false,
};

export function reduceSaveFeedback(snapshot: SaveFeedbackSnapshot, event:
  | { type: 'edit' }
  | { type: 'begin' }
  | { type: 'succeed'; at: Date }
  | { type: 'fail'; error: string; generic?: boolean }
  | { type: 'reset' },
): SaveFeedbackSnapshot {
  switch (event.type) {
    case 'edit': return { state: 'dirty', error: null, savedAt: null, genericError: false };
    case 'begin': return { state: 'saving', error: null, savedAt: null, genericError: false };
    case 'succeed': return { state: 'saved', error: null, savedAt: event.at, genericError: false };
    case 'fail': return { state: 'error', error: event.error, savedAt: null, genericError: event.generic ?? false };
    case 'reset': return initialSaveFeedback;
  }
}
