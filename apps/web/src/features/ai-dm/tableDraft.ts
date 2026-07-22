/**
 * Local AI Table composer drafts (issue #878).
 *
 * Drafts are deliberately client-only and scoped by both campaign and user. They
 * never participate in runtime authority: the server still owns role, mode, pause,
 * budget, and per-campaign turn-concurrency checks when Send is explicitly invoked.
 */

export interface AiTableDraftScope {
  campaignId: number;
  userId: number | string;
}

export interface AiTableDraft {
  input: string;
  scene: string;
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredAiTableDraft extends AiTableDraft {
  version: 1;
}

export const EMPTY_AI_TABLE_DRAFT: AiTableDraft = { input: '', scene: '' };

const memoryDrafts = new Map<string, AiTableDraft>();

export function aiTableDraftStorageKey({ campaignId, userId }: AiTableDraftScope): string {
  return `cf.aiDm.tableDraft.v1.${encodeURIComponent(String(userId))}.${campaignId}`;
}

function defaultStorage(): DraftStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function parseDraft(raw: string | null): AiTableDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAiTableDraft>;
    if (parsed?.version !== 1 || typeof parsed.input !== 'string' || typeof parsed.scene !== 'string') {
      return null;
    }
    return { input: parsed.input, scene: parsed.scene };
  } catch {
    return null;
  }
}

/** Load a scoped draft from durable storage, falling back to this tab's memory. */
export function loadAiTableDraft(scope: AiTableDraftScope, storage = defaultStorage()): AiTableDraft {
  const key = aiTableDraftStorageKey(scope);
  const inMemory = memoryDrafts.get(key);
  if (inMemory) return { ...inMemory };
  try {
    const stored = storage ? parseDraft(storage.getItem(key)) : null;
    if (stored) {
      memoryDrafts.set(key, stored);
      return { ...stored };
    }
  } catch {
    // A blocked/corrupt store must not make the composer unusable.
  }
  return { ...(memoryDrafts.get(key) ?? EMPTY_AI_TABLE_DRAFT) };
}

/**
 * Save immediately on every controlled-field change. Returns whether the draft is
 * durable across reload; a false result still remains available across SPA routes
 * through the in-memory fallback.
 */
export function saveAiTableDraft(
  scope: AiTableDraftScope,
  draft: AiTableDraft,
  storage = defaultStorage(),
): boolean {
  const key = aiTableDraftStorageKey(scope);
  const snapshot = { input: draft.input, scene: draft.scene };
  memoryDrafts.set(key, snapshot);
  if (!storage) return false;
  try {
    const stored: StoredAiTableDraft = { version: 1, ...snapshot };
    storage.setItem(key, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

/** Remove a draft only after the caller has obtained explicit discard consent. */
export function clearAiTableDraft(scope: AiTableDraftScope, storage = defaultStorage()): boolean {
  const key = aiTableDraftStorageKey(scope);
  // Keep an in-tab tombstone so a failed storage removal cannot resurrect stale
  // text on an SPA route remount.
  memoryDrafts.set(key, { ...EMPTY_AI_TABLE_DRAFT });
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    // Some constrained stores permit replacing an existing item but not removing
    // it. An explicit empty value is equivalent on the next reload.
    try {
      const empty: StoredAiTableDraft = { version: 1, ...EMPTY_AI_TABLE_DRAFT };
      storage.setItem(key, JSON.stringify(empty));
      return true;
    } catch {
      return false;
    }
  }
}

export function aiTableDraftEquals(a: AiTableDraft, b: AiTableDraft): boolean {
  return a.input === b.input && a.scene === b.scene;
}

export type AiTableConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export type AiTableSendBlockReason =
  | 'composing'
  | 'submitting'
  | 'connecting'
  | 'reconnecting'
  | 'connection_unavailable'
  | 'session_loading'
  | 'session_unavailable'
  | 'turn_active'
  | 'paused'
  | 'human_control'
  | 'awaiting_players'
  | 'budget_exhausted'
  | 'empty';

export interface AiTableSendState {
  input: string;
  composing: boolean;
  submitting: boolean;
  connection: AiTableConnectionState;
  sessionLoading: boolean;
  sessionError: boolean;
  streaming: boolean;
  sessionStatus?: 'idle' | 'running' | 'paused';
  sessionState?: 'running' | 'awaiting_players' | 'paused' | 'human_control';
  tokensUsed: number;
  tokenBudget: number;
}

/**
 * One deterministic client-side reason for Send being unavailable. This is UX
 * feedback only; a null result never bypasses the authoritative POST guards.
 */
export function aiTableSendBlockReason(state: AiTableSendState): AiTableSendBlockReason | null {
  if (state.composing) return 'composing';
  if (state.submitting) return 'submitting';
  if (state.connection === 'connecting') return 'connecting';
  if (state.connection === 'reconnecting') return 'reconnecting';
  if (state.connection === 'closed') return 'connection_unavailable';
  if (state.sessionLoading) return 'session_loading';
  if (state.sessionError || state.sessionStatus === undefined || state.sessionState === undefined) {
    return 'session_unavailable';
  }
  if (state.streaming || state.sessionStatus === 'running') return 'turn_active';
  if (state.sessionState === 'human_control') return 'human_control';
  if (state.sessionStatus === 'paused' || state.sessionState === 'paused') return 'paused';
  if (state.sessionState === 'awaiting_players') return 'awaiting_players';
  if (state.tokenBudget <= state.tokensUsed) return 'budget_exhausted';
  if (!state.input.trim()) return 'empty';
  return null;
}
