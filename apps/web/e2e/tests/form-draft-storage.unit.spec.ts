import { expect, test } from '@playwright/test';
import {
  buildFormDraftEnvelope,
  clearFormDraft,
  formDraftStorageKey,
  isFormDraftStale,
  readFormDraft,
  writeFormDraft,
  type FormDraftEnvelope,
} from '../../src/lib/formDraftStorage';
import {
  deriveProtectedFormSaveStatus,
  protectedFormSaveStatusLabel,
  recordsEqual,
} from '../../src/lib/protectedFormState';
import {
  isRecapEditorDirty,
  isNewRecapDraftMeaningful,
  recapEditorDraftsEqual,
} from '../../src/features/sessions/recapFormFields';
import {
  isSessionZeroCharterDirty,
  sessionZeroCharterDraftsEqual,
} from '../../src/features/session-zero/sessionZeroFormState';
import {
  characterSheetDraftFrom,
  characterSheetDraftsEqual,
  isCharacterSheetDirty,
  normalizeRestoredDraft,
} from '../../src/features/characters/characterSheetFormState';
import { Dnd5eAdapter, OpenLegendAdapter } from '@campfire/schema';
import type { Character } from '@campfire/schema';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length() {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function character(overrides: Partial<Character> = {}): Character {
  return {
    id: 9,
    campaignId: 4,
    ownerUserId: '42',
    name: 'Astra',
    species: 'Human',
    className: 'Fighter',
    level: 3,
    xp: 0,
    background: 'Soldier',
    status: 'active',
    stats: { STR: 16, DEX: 12 },
    ac: 16,
    eac: null,
    kac: null,
    speed: null,
    hpCurrent: 20,
    hpMax: 20,
    spCurrent: 0,
    spMax: 0,
    rpCurrent: 0,
    rpMax: 0,
    hpTemp: 0,
    deathState: 'none',
    deathSaveSuccesses: 0,
    deathSaveFailures: 0,
    conditions: [],
    conditionInstances: [],
    saveProficiencies: [],
    skills: {},
    actions: [],
    spellSlots: {},
    resources: {},
    portraitUrl: null,
    ddbId: null,
    notes: '',
    dmSecret: '',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

/**
 * Issue #641 — local draft persistence, stale detection, and dirty helpers.
 */
test.describe('form draft storage (issue #641)', () => {
  test('keys are namespaced by user, campaign, and form id', () => {
    expect(formDraftStorageKey(7, 4, 'session-zero-charter')).toBe(
      'cf.formDraft.v1:7:4:session-zero-charter',
    );
  });

  test('write/read/clear round-trip', () => {
    const store = new MemoryStorage();
    const key = formDraftStorageKey(1, 2, 'session-recap:5');
    const envelope = buildFormDraftEnvelope({ title: 'Ash', recap: 'We fought.' }, '2026-07-01T12:00:00.000Z');
    expect(writeFormDraft(key, envelope, store)).toBe(true);
    expect(readFormDraft<{ title: string; recap: string }>(key, store)).toEqual(envelope);
    clearFormDraft(key, store);
    expect(readFormDraft(key, store)).toBeNull();
  });

  test('stale detection compares baselineUpdatedAt to the live server revision', () => {
    const fresh: FormDraftEnvelope<{ body: string }> = {
      v: 1,
      savedAt: '2026-07-02T00:00:00.000Z',
      baselineUpdatedAt: '2026-07-01T12:00:00.000Z',
      data: { body: 'draft' },
    };
    expect(isFormDraftStale(fresh, '2026-07-01T12:00:00.000Z')).toBe(false);
    expect(isFormDraftStale(fresh, '2026-07-02T08:00:00.000Z')).toBe(true);
    expect(isFormDraftStale(fresh, null)).toBe(false);
    expect(isFormDraftStale(fresh, '2026-07-01T12:00:00Z')).toBe(false);
  });
});

test.describe('protected form state (issue #641)', () => {
  test('save status labels distinguish dirty server work from local-only drafts', () => {
    expect(protectedFormSaveStatusLabel(deriveProtectedFormSaveStatus({ dirty: true, saving: false, hasStoredDraft: true }))).toBe(
      'Unsaved changes',
    );
    expect(
      protectedFormSaveStatusLabel(
        deriveProtectedFormSaveStatus({ dirty: false, saving: false, hasStoredDraft: true }),
      ),
    ).toBe('Draft saved locally — not on the server yet');
  });

  test('recordsEqual compares stat maps', () => {
    expect(recordsEqual({ STR: '16' }, { STR: '16' })).toBe(true);
    expect(recordsEqual({ STR: '16' }, { STR: '14' })).toBe(false);
  });
});

test.describe('session-zero charter dirty detection (issue #641)', () => {
  const baseline = {
    lines: ['No torture'],
    veils: [],
    safetyTools: ['X-card'],
    houseRules: 'Phones down',
    toneAndExpectations: 'Heroic',
  };

  test('detects meaningful charter edits and ignores identical drafts', () => {
    expect(sessionZeroCharterDraftsEqual(baseline, { ...baseline })).toBe(true);
    expect(isSessionZeroCharterDirty({ ...baseline, houseRules: 'Phones away' }, baseline)).toBe(true);
  });
});

test.describe('recap editor dirty detection (issue #641)', () => {
  test('new recap drafts are meaningful after title or recap input', () => {
    expect(isNewRecapDraftMeaningful({ title: 'Vault', playedAt: '', recap: '' })).toBe(true);
    expect(isNewRecapDraftMeaningful({ title: '', playedAt: '', recap: '' })).toBe(false);
  });

  test('edit recap dirty detection ignores unchanged loaded recap', () => {
    const baseline = { title: 'Vault', playedAt: '2026-07-01', recap: 'We escaped.' };
    expect(recapEditorDraftsEqual(baseline, { ...baseline })).toBe(true);
    expect(isRecapEditorDirty({ ...baseline, recap: 'We escaped!\n' }, baseline)).toBe(true);
  });
});

test.describe('character sheet dirty detection (issue #641)', () => {
  test('sheet draft snapshot round-trips from a character record', () => {
    const baseline = characterSheetDraftFrom(character(), Dnd5eAdapter);
    expect(isCharacterSheetDirty({ ...baseline, level: '4' }, baseline)).toBe(true);
    expect(characterSheetDraftsEqual(baseline, characterSheetDraftFrom(character(), Dnd5eAdapter))).toBe(true);
  });

  test('Open Legend drafts include adapter-native and custom stats', () => {
    const ol = character({
      className: '',
      stats: {
        AGILITY: 4,
        MIGHT: 5,
        ENERGY: 3,
        CUSTOM_NATIVE: 7,
      },
    });
    const baseline = characterSheetDraftFrom(ol, OpenLegendAdapter);
    expect(baseline.className).toBe('');
    expect(baseline.stats.AGILITY).toBe('4');
    expect(baseline.stats.ENERGY).toBe('3');
    expect(baseline.stats.CUSTOM_NATIVE).toBe('7');
    expect(Object.keys(baseline.stats)).toContain('PRESCIENCE');
  });

  // Issue #1910: a character created before the `speed` column existed reads null —
  // the draft must render that as an empty field, not a fabricated "0" or "30", and a
  // real value must round-trip so editing then clearing it back to null is detectable.
  test('speed is empty for a legacy null-speed character and round-trips a real value', () => {
    const legacy = characterSheetDraftFrom(character({ speed: null }), Dnd5eAdapter);
    expect(legacy.speed).toBe('');

    const dwarf = characterSheetDraftFrom(character({ speed: 25 }), Dnd5eAdapter);
    expect(dwarf.speed).toBe('25');
    expect(isCharacterSheetDirty(legacy, dwarf)).toBe(true);
    expect(characterSheetDraftsEqual(dwarf, characterSheetDraftFrom(character({ speed: 25 }), Dnd5eAdapter))).toBe(true);

    // Clearing a set speed back to '' (-> null on save) must register as a change.
    expect(isCharacterSheetDirty({ ...dwarf, speed: '' }, dwarf)).toBe(true);
  });

  // Devin review on PR #1980: readFormDraft validates only the storage
  // envelope, never the persisted field set — a draft saved before `speed` joined
  // CharacterSheetDraft restores with `speed: undefined`. CharacterPage's save()
  // later calls `speed.trim()` unconditionally; `undefined.trim()` throws a
  // TypeError inside the async onClick handler (`void save()`), an unhandled
  // rejection — no PATCH, no error banner, the Save button silently does nothing.
  // normalizeRestoredDraft is the fix: it fills every field defensively so
  // restoring a legacy (or otherwise partial) draft always yields real strings.
  test('a legacy draft missing speed normalizes to an empty string, not undefined, so save() never throws', () => {
    // Simulates exactly what JSON.parse of a pre-#1910 persisted draft produces:
    // no `speed` key at all, not `speed: undefined` written out (JSON has no way
    // to serialize `undefined` as a value either way — the key is just absent).
    const legacyPersisted = {
      name: 'Pre-Speed Hero',
      species: 'Human',
      className: 'Fighter',
      background: '',
      level: '5',
      ac: '15',
      hpMax: '30',
      status: 'active' as const,
      stats: { STR: '16' },
    };

    // Reproduces save()'s exact guard clause (`if (speed.trim() !== '')`). Restoring
    // the RAW legacy object (the pre-fix code path: `setSpeed(restored.speed)` with
    // no fallback) would leave `speed` undefined in state, and this line is what
    // later throws inside the async handler.
    expect(() => (legacyPersisted as { speed?: string }).speed!.trim()).toThrow(TypeError);

    const normalized = normalizeRestoredDraft(legacyPersisted);
    expect(normalized.speed).toBe('');
    // The fixed shape never throws save()'s guard clause.
    expect(() => normalized.speed.trim()).not.toThrow();
    // Every other field passes through unchanged — this isn't a lossy reset.
    expect(normalized.name).toBe('Pre-Speed Hero');
    expect(normalized.ac).toBe('15');
    expect(normalized.stats).toEqual({ STR: '16' });
  });

  test('normalizeRestoredDraft is a no-op for an already-complete draft', () => {
    const complete = characterSheetDraftFrom(character({ speed: 30 }), Dnd5eAdapter);
    expect(normalizeRestoredDraft(complete)).toEqual(complete);
  });
});
