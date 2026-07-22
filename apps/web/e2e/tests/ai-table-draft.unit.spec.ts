import { expect, test } from '@playwright/test';
import {
  aiTableDraftStorageKey,
  aiTableSendBlockReason,
  clearAiTableDraft,
  isAiTableDraftPersisted,
  loadAiTableDraft,
  saveAiTableDraft,
  type AiTableDraftScope,
  type AiTableSendState,
  type DraftStorage,
} from '../../src/features/ai-dm/tableDraft';

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('quota');
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.failWrites) throw new Error('blocked');
    this.values.delete(key);
  }
}

const BASE_SEND_STATE: AiTableSendState = {
  input: 'I open the rune-marked door.',
  composing: false,
  submitting: false,
  connection: 'connected',
  sessionLoading: false,
  sessionError: false,
  streaming: false,
  sessionStatus: 'idle',
  sessionState: 'running',
  tokensUsed: 100,
  tokenBudget: 1_000,
};

test.describe('AI Table local draft persistence', () => {
  test('scopes drafts by user and campaign, survives reload-style reads, and clears explicitly', () => {
    const storage = new MemoryStorage();
    const first: AiTableDraftScope = { campaignId: 87801, userId: 11 };
    const otherCampaign: AiTableDraftScope = { campaignId: 87802, userId: 11 };
    const otherUser: AiTableDraftScope = { campaignId: 87801, userId: 12 };

    expect(new Set([
      aiTableDraftStorageKey(first),
      aiTableDraftStorageKey(otherCampaign),
      aiTableDraftStorageKey(otherUser),
    ]).size).toBe(3);

    expect(saveAiTableDraft(first, { input: 'first action', scene: 'first scene' }, storage)).toBe(true);
    expect(isAiTableDraftPersisted(first, { input: 'first action', scene: 'first scene' }, storage)).toBe(true);
    expect(isAiTableDraftPersisted(first, { input: 'edited action', scene: 'first scene' }, storage)).toBe(false);
    expect(saveAiTableDraft(otherCampaign, { input: 'second action', scene: '' }, storage)).toBe(true);
    expect(loadAiTableDraft(first, storage)).toEqual({ input: 'first action', scene: 'first scene' });
    expect(loadAiTableDraft(otherCampaign, storage)).toEqual({ input: 'second action', scene: '' });
    expect(loadAiTableDraft(otherUser, storage)).toEqual({ input: '', scene: '' });

    expect(clearAiTableDraft(first, storage)).toBe(true);
    expect(loadAiTableDraft(first, storage)).toEqual({ input: '', scene: '' });
    expect(loadAiTableDraft(otherCampaign, storage)).toEqual({ input: 'second action', scene: '' });
  });

  test('keeps an in-tab fallback when storage is blocked and ignores malformed durable data', () => {
    const storage = new MemoryStorage();
    const blockedScope = { campaignId: 87803, userId: 'blocked-user' };
    storage.failWrites = true;

    expect(saveAiTableDraft(blockedScope, { input: 'protected in memory', scene: '' }, storage)).toBe(false);
    expect(loadAiTableDraft(blockedScope, storage)).toEqual({ input: 'protected in memory', scene: '' });

    const malformedScope = { campaignId: 87804, userId: 'malformed-user' };
    storage.failWrites = false;
    storage.values.set(aiTableDraftStorageKey(malformedScope), '{"version":1,"input":9}');
    expect(loadAiTableDraft(malformedScope, storage)).toEqual({ input: '', scene: '' });
  });
});

test.describe('AI Table Send gating', () => {
  test('keeps one precise reason through rapid runtime, reconnect, composition, and budget transitions', () => {
    const transitions: Array<[Partial<AiTableSendState>, ReturnType<typeof aiTableSendBlockReason>]> = [
      [{ streaming: true }, 'turn_active'],
      [{ sessionStatus: 'running' }, 'turn_active'],
      [{ sessionStatus: 'paused', sessionState: 'paused' }, 'paused'],
      [{ sessionState: 'human_control' }, 'human_control'],
      [{ sessionState: 'awaiting_players' }, 'awaiting_players'],
      [{ connection: 'reconnecting' }, 'reconnecting'],
      [{ connection: 'connecting' }, 'connecting'],
      [{ connection: 'closed' }, 'connection_unavailable'],
      [{ sessionLoading: true }, 'session_loading'],
      [{ sessionError: true }, 'session_unavailable'],
      [{ composing: true }, 'composing'],
      [{ submitting: true }, 'submitting'],
      [{ tokensUsed: 1_000 }, 'budget_exhausted'],
      [{ input: '   ' }, 'empty'],
      [{}, null],
    ];

    for (const [change, expected] of transitions) {
      expect(aiTableSendBlockReason({ ...BASE_SEND_STATE, ...change })).toBe(expected);
    }
  });

  test('prioritizes unsafe in-flight and authority states over stale lower-priority reasons', () => {
    expect(aiTableSendBlockReason({
      ...BASE_SEND_STATE,
      input: '',
      streaming: true,
      sessionState: 'awaiting_players',
      connection: 'reconnecting',
    })).toBe('reconnecting');

    expect(aiTableSendBlockReason({
      ...BASE_SEND_STATE,
      input: '',
      sessionStatus: 'running',
      submitting: true,
    })).toBe('submitting');
  });
});
