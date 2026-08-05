import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import {
  formatCastingTime,
  formatLevelName,
  filterSpells,
  groupSpellsByLevel,
  isResolvableSpell,
  hasSpellbookContent,
  buildSpellCastContext,
  type SpellItem,
} from '../../src/features/encounters/SpellbookPanel';
import { deriveTurnSpells, TurnWorkspace as TurnWorkspaceSchema, type TurnSuggestedAction, type ActionSpec } from '@campfire/schema';
import { applyOptimisticSpellSlotDelta } from '../../src/features/encounters/optimisticSpellSlots';

const SPELLBOOK_PANEL_PATH = resolve(__dirname, '../../src/features/encounters/SpellbookPanel.tsx');
const TURN_WORKSPACE_PATH = resolve(__dirname, '../../src/features/encounters/TurnWorkspace.tsx');
const RUN_SESSION_PAGE_PATH = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

/** Minimal-but-valid ActionSpec builder for spell-derivation fixtures. */
function spec(overrides: { spellLevel?: number; concentration?: boolean; slot?: string } = {}): ActionSpec {
  return {
    mode: 'none',
    attack: { bonus: '', ability: '', proficient: true, vs: 'ac' },
    save: { ability: '', dc: { kind: 'none', dc: 10, ability: '', proficient: true, bonus: 0, base: 8 } },
    cost: { slot: overrides.slot ?? 'action', count: 1 },
    uses: {
      max: 0,
      recharge: '',
      concentration: overrides.concentration ?? false,
      repeatSave: false,
      spellLevel: overrides.spellLevel ?? 0,
      resourceKey: '',
      resourceCost: 0,
    },
    range: { range: '', shape: '', size: '' },
    targets: { count: 1, allow: 'any' },
    outcomes: {},
    provenance: { ruleSystem: '', source: '', ref: '' },
  } as unknown as ActionSpec;
}

function suggestedAction(overrides: Partial<TurnSuggestedAction>): TurnSuggestedAction {
  return {
    name: 'Action',
    source: 'action',
    summary: '',
    toHit: '',
    damage: '',
    resolvable: false,
    spec: null,
    ...overrides,
  } as TurnSuggestedAction;
}

test.describe('In-combat Spellbook — real data, no fabrication (issue #1900)', () => {
  test('the fabricated fallback is gone: no invented spell facts anywhere in apps/web/src', () => {
    // Direct regression guard for the issue's own acceptance criterion.
    const turnWorkspaceSrc = readFileSync(TURN_WORKSPACE_PATH, 'utf8');
    expect(turnWorkspaceSrc).not.toContain('Evocation');
    expect(turnWorkspaceSrc).not.toContain('effectiveSpells');
    expect(turnWorkspaceSrc).not.toContain("'60 ft'");
    expect(turnWorkspaceSrc).not.toContain("range: '60 ft'");

    const spellbookSrc = readFileSync(SPELLBOOK_PANEL_PATH, 'utf8');
    expect(spellbookSrc).not.toContain('Evocation');
  });

  test('SpellbookPanel.tsx keeps its real-data affordances and drops the dead pact/stats surface', () => {
    const src = readFileSync(SPELLBOOK_PANEL_PATH, 'utf8');

    expect(src).toContain('useTranslation');

    // Issue #1900: PactSlotPool UI and the spellcasting-stats header were removed —
    // no data model backs either (out of scope; #1513 owns any new sheet fields).
    expect(src).not.toContain('pact-magic-slots-row');
    expect(src).not.toContain('pact-slot-pips');
    expect(src).not.toContain('spellbook-stats-header');
    expect(src).not.toContain('PactSlotPool');
    expect(src).not.toContain('SpellcastingStats');
    expect(src).not.toContain('onToggleSlotPip');
    expect(src).not.toContain('onCastSpell');

    // Search and filter input
    expect(src).toContain('spellbook-search-input');

    // Collapsible level sections and slot pips — driven ONLY by the real spellSlots prop.
    expect(src).toContain('spell-level-section-');
    expect(src).toContain('aria-expanded');
    expect(src).toContain('slot-pips-level-');

    // Per-spell row details & actions
    expect(src).toContain('cast-spell-');
    expect(src).toContain('upcast-spell-');
    expect(src).toContain('upcast-popover-');
    expect(src).toContain('concentration-indicator');
    expect(src).toContain('🔮 Conc');

    // Concentration warning modal
    expect(src).toContain('concentration-warning-modal');
    expect(src).toContain('confirm-concentration-replace');
    expect(src).toContain('cancel-concentration-replace');
  });

  test('TurnWorkspace.tsx integrates SpellbookPanel, hides the toggle with no data, and fetches /turn exactly once', () => {
    const src = readFileSync(TURN_WORKSPACE_PATH, 'utf8');

    expect(src).toContain('SpellbookPanel');
    expect(src).toContain('toggle-spellbook-btn');
    expect(src).toContain('🔮 Spellbook');
    expect(src).toContain('showSpellbook');

    // Issue #1900: the toggle is gated on real data, not always rendered.
    expect(src).toContain('hasSpellbookData &&');

    // Issue #1900: the duplicate child /turn query is gone — TurnWorkspace now takes the
    // already-fetched workspace as a `turn` prop from the parent's single query instead of
    // running its own `useQuery` against the same endpoint.
    expect(src).not.toContain('useQuery(');
    expect(src).not.toContain('api.get<TurnWorkspaceData>');
  });

  test('RunSessionPage.tsx owns the single /turn query and passes it straight to TurnWorkspace', () => {
    const src = readFileSync(RUN_SESSION_PAGE_PATH, 'utf8');
    expect(src).toContain('turn={turnWorkspace}');
    expect(src).toContain('onUpdateSpellSlot');
    // The mutation reverts its optimistic cache write on error (acceptance criterion:
    // a forced 4xx/5xx shows a toast and the pip state reverts).
    expect(src).toContain('context?.previous');
    expect(src).toContain("fallbackKey: 'encounters.errors.spellSlot'");
  });

  // Review fix: a REMOTE client's Spellbook (spells/slots sourced exclusively from the /turn
  // cache) must also refresh on a `character.updated` SSE frame, not just the campaign
  // character read. Without this, another open tab shows stale slot pips until an unrelated
  // encounter event happens to invalidate the turn workspace.
  test('RunSessionPage.tsx invalidates the turn workspace on character.updated, reconnect, and stream recovery', () => {
    const src = readFileSync(RUN_SESSION_PAGE_PATH, 'utf8');
    const characterUpdatedStart = src.indexOf('if (shouldInvalidateInlineCharacters(event))');
    const characterUpdatedBranch = src.slice(
      characterUpdatedStart,
      src.indexOf('// Issue #415:', characterUpdatedStart),
    );
    expect(characterUpdatedBranch).toContain("event.type === 'character.updated'");
    expect(characterUpdatedBranch).toContain('queryKeys.encounterTurn(eid)');

    const onReconnectBranch = src.slice(src.indexOf('onReconnect: useCallback'), src.indexOf('onReconnect: useCallback') + 600);
    expect(onReconnectBranch).toContain('queryKeys.encounterTurn(eid)');

    const onStreamRecoveryBranch = src.slice(
      src.indexOf('onStreamRecovery: useCallback'),
      src.indexOf('onStreamRecovery: useCallback') + 500,
    );
    expect(onStreamRecoveryBranch).toContain('queryKeys.encounterTurn(eid)');
  });

  test('formatCastingTime converts verbose strings to standard abbreviations', () => {
    expect(formatCastingTime('1 Action')).toBe('1A');
    expect(formatCastingTime('action')).toBe('1A');
    expect(formatCastingTime('1 Bonus Action')).toBe('1BA');
    expect(formatCastingTime('bonus action')).toBe('1BA');
    expect(formatCastingTime('1 Reaction')).toBe('1R');
    expect(formatCastingTime('reaction')).toBe('1R');
    expect(formatCastingTime('10 Minutes')).toBe('10 Minutes');
    // The real derivation feeds the raw adapter slot key straight in — must format cleanly.
    expect(formatCastingTime('bonus')).toBe('1BA');
  });

  test('formatLevelName formats levels accurately', () => {
    expect(formatLevelName(0)).toBe('Cantrips');
    expect(formatLevelName(1)).toBe('1st Level');
    expect(formatLevelName(2)).toBe('2nd Level');
    expect(formatLevelName(3)).toBe('3rd Level');
    expect(formatLevelName(4)).toBe('4th Level');
  });

  test('filterSpells filters by name, school, or casting time', () => {
    const sampleSpells: SpellItem[] = [
      { id: '1', name: 'Fireball', level: 3, school: 'Evocation', castingTime: '1 Action', range: '150 ft' },
      { id: '2', name: 'Shield', level: 1, school: 'Abjuration', castingTime: '1 Reaction', range: 'Self' },
      { id: '3', name: 'Healing Word', level: 1, school: 'Evocation', castingTime: '1 Bonus Action', range: '60 ft' },
    ];

    expect(filterSpells(sampleSpells, 'fire')).toHaveLength(1);
    expect(filterSpells(sampleSpells, 'fire')[0].name).toBe('Fireball');

    expect(filterSpells(sampleSpells, 'Abjuration')).toHaveLength(1);
    expect(filterSpells(sampleSpells, 'Abjuration')[0].name).toBe('Shield');

    expect(filterSpells(sampleSpells, '1BA')).toHaveLength(1);
    expect(filterSpells(sampleSpells, '1BA')[0].name).toBe('Healing Word');

    expect(filterSpells(sampleSpells, '')).toHaveLength(3);
  });

  test('filterSpells tolerates spells with no castingTime/range data (no fabrication to fall back on)', () => {
    const sampleSpells: SpellItem[] = [
      { id: '1', name: 'Guidance', level: 0 },
      { id: '2', name: 'Fireball', level: 3, castingTime: 'bonus' },
    ];
    expect(filterSpells(sampleSpells, 'guidance')).toHaveLength(1);
    expect(filterSpells(sampleSpells, '1ba')).toHaveLength(1);
    expect(filterSpells(sampleSpells, '')).toHaveLength(2);
  });

  test('groupSpellsByLevel groups spells by level accurately', () => {
    const sampleSpells: SpellItem[] = [
      { id: '1', name: 'Fire Bolt', level: 0, castingTime: '1A', range: '120 ft' },
      { id: '2', name: 'Magic Missile', level: 1, castingTime: '1A', range: '120 ft' },
      { id: '3', name: 'Shield', level: 1, castingTime: '1R', range: 'Self' },
      { id: '4', name: 'Misty Step', level: 2, castingTime: '1BA', range: 'Self' },
    ];

    const grouped = groupSpellsByLevel(sampleSpells);
    expect(grouped.get(0)).toHaveLength(1);
    expect(grouped.get(1)).toHaveLength(2);
    expect(grouped.get(2)).toHaveLength(1);
    expect(grouped.get(3)).toBeUndefined();
  });

  test('deriveTurnSpells picks a leveled spell (spec.uses.spellLevel >= 1) off the same rows as suggestedActions', () => {
    const actions: TurnSuggestedAction[] = [
      suggestedAction({ name: 'Fireball', source: 'spell', actionIndex: 0, resolvable: true, spec: spec({ spellLevel: 3, slot: 'action' }) }),
      suggestedAction({ name: 'Attack', source: 'action', actionIndex: 1, resolvable: true, spec: spec({ spellLevel: 0 }) }),
    ];
    const spells = deriveTurnSpells(actions);
    expect(spells).toHaveLength(1);
    expect(spells[0]).toMatchObject({ name: 'Fireball', level: 3, castingSlot: 'action', actionIndex: 0 });
  });

  test('deriveTurnSpells picks a level-0 row only when its source/kind reads as spell or cantrip', () => {
    const actions: TurnSuggestedAction[] = [
      suggestedAction({ name: 'Fire Bolt', source: 'cantrip', actionIndex: 0, spec: spec({ spellLevel: 0 }) }),
      suggestedAction({ name: 'Guidance', source: 'Spell', actionIndex: 1, spec: spec({ spellLevel: 0 }) }),
      suggestedAction({ name: 'Unarmed Strike', source: 'action', actionIndex: 2, spec: spec({ spellLevel: 0 }) }),
    ];
    const spells = deriveTurnSpells(actions);
    expect(spells.map((s) => s.name)).toEqual(['Fire Bolt', 'Guidance']);
  });

  test('deriveTurnSpells never invents school/range/casting-time — only real spec-derived fields', () => {
    const actions: TurnSuggestedAction[] = [
      suggestedAction({ name: 'Bless', source: 'spell', actionIndex: 0, spec: spec({ spellLevel: 1, concentration: true, slot: 'bonus' }) }),
    ];
    const [entry] = deriveTurnSpells(actions);
    expect(entry).toMatchObject({ name: 'Bless', level: 1, castingSlot: 'bonus', concentration: true, actionIndex: 0 });
    expect(entry).not.toHaveProperty('school');
    expect(entry).not.toHaveProperty('range');
  });

  test('TurnWorkspace schema parses real spellSlots + derived spells, and null/empty for a non-character actor', () => {
    const base = {
      encounterId: 1,
      status: 'running' as const,
      round: 1,
      current: null,
      next: null,
      isYourTurn: false,
      canEndTurn: false,
      dmControlsTurns: false,
      requireDmTurnConfirmation: false,
      actionEconomy: [],
      movement: null,
      reactionAvailable: false,
      concentration: null,
      activeEffects: [],
      suggestedActions: [],
      startPrompts: [],
      endPrompts: [],
    };

    const withSpells = TurnWorkspaceSchema.parse({
      ...base,
      spellSlots: { '1': { max: 2, used: 1 } },
      spells: [{ name: 'Bless', level: 1, castingSlot: 'bonus', concentration: true, actionIndex: 0, resolvable: true, spec: null }],
    });
    expect(withSpells.spellSlots).toEqual({ '1': { max: 2, used: 1 } });
    expect(withSpells.spells).toHaveLength(1);

    const nonCharacter = TurnWorkspaceSchema.parse({ ...base, spellSlots: null, spells: [] });
    expect(nonCharacter.spellSlots).toBeNull();
    expect(nonCharacter.spells).toEqual([]);
  });

  test('applyOptimisticSpellSlotDelta clamps used to [0, max], matching the server clamp', () => {
    const slots = { '1': { max: 2, used: 1 } };
    expect(applyOptimisticSpellSlotDelta(slots, 1, 1)).toEqual({ '1': { max: 2, used: 2 } });
    // Spending past max clamps rather than overshoots.
    expect(applyOptimisticSpellSlotDelta({ '1': { max: 2, used: 2 } }, 1, 1)).toEqual({ '1': { max: 2, used: 2 } });
    // Restoring below 0 clamps rather than undershoots.
    expect(applyOptimisticSpellSlotDelta({ '1': { max: 2, used: 0 } }, 1, -1)).toEqual({ '1': { max: 2, used: 0 } });
    // A level with no configured pool is left alone (nothing to estimate).
    expect(applyOptimisticSpellSlotDelta(slots, 9, 1)).toBe(slots);
    expect(applyOptimisticSpellSlotDelta(null, 1, 1)).toBeNull();
  });

  // Review fix (copilot + devin threads on PR #1952): a spec can exist but be purely
  // descriptive — no attack bonus/ability, no DC source — and must NOT be treated as
  // resolver-eligible, or the Cast button either errors or silently spends nothing while the
  // upcast picker for its real spell level stays permanently unreachable dead code.
  test('isResolvableSpell distinguishes a resolvable spec from a descriptive/spec-less one', () => {
    const attackResolvable = spec({ spellLevel: 2 });
    attackResolvable.mode = 'attack';
    attackResolvable.attack = { bonus: '+5', ability: '', proficient: true, vs: 'ac' };
    expect(isResolvableSpell({ spec: attackResolvable })).toBe(true);

    const saveDescriptive = spec({ spellLevel: 3 });
    saveDescriptive.mode = 'save';
    saveDescriptive.save = { ability: 'wis', dc: { kind: 'none', dc: 10, ability: '', proficient: true, bonus: 0, base: 8 } };
    expect(isResolvableSpell({ spec: saveDescriptive })).toBe(false);

    expect(isResolvableSpell({ spec: null })).toBe(false);
    expect(isResolvableSpell({})).toBe(false);
  });

  // Review fix: a persisted slots map can legitimately hold a level entry with `max: 0`
  // (a slot tier the character hasn't reached yet) — that must not count as "has slots" for
  // the Spellbook toggle-visibility acceptance criterion.
  test('hasSpellbookContent ignores zero-max slot pools and requires either a spell or a usable pool', () => {
    expect(hasSpellbookContent([], undefined)).toBe(false);
    expect(hasSpellbookContent([], {})).toBe(false);
    expect(hasSpellbookContent([], { '1': { max: 0, used: 0 }, '2': { max: 0, used: 0 } })).toBe(false);
    expect(hasSpellbookContent([], { '1': { max: 2, used: 0 } })).toBe(true);
    expect(hasSpellbookContent([{ id: '1', name: 'Fire Bolt', level: 0 }], undefined)).toBe(true);
  });

  test('TurnWorkspace.tsx computes the toggle from hasSpellbookContent, not a raw key check', () => {
    const src = readFileSync(TURN_WORKSPACE_PATH, 'utf8');
    expect(src).toContain('hasSpellbookContent(spellItems, spellSlotsMap)');
    expect(src).not.toContain('Object.keys(spellSlotsMap).length > 0');
  });

  // Review fix (P1, chatgpt-codex-connector on PR #1952): a descriptive-but-structured spec
  // never reaches the resolve/apply flow, so its action-economy cost and concentration have
  // no other write path than this direct slot-patch branch. `buildSpellCastContext` must
  // source both fields from the spec itself — never invent a cost/concentration the spec
  // doesn't declare — and return `undefined` for a genuinely spec-less row.
  test('buildSpellCastContext derives cost slot / concentration only from real spec data', () => {
    const descriptiveConcentration = spec({ spellLevel: 2, concentration: true, slot: 'action' });
    expect(buildSpellCastContext({ spec: descriptiveConcentration, isConcentration: true, name: 'Bane' })).toEqual({
      costSlot: 'action',
      concentrationName: 'Bane',
    });

    const descriptiveNoConcentration = spec({ spellLevel: 1, slot: 'bonus' });
    expect(buildSpellCastContext({ spec: descriptiveNoConcentration, isConcentration: false, name: 'Guidance' })).toEqual({
      costSlot: 'bonus',
      concentrationName: undefined,
    });

    // Spec-less row: nothing to derive, nothing invented.
    expect(buildSpellCastContext({ spec: null, isConcentration: false, name: 'Whatever' })).toBeUndefined();
    expect(buildSpellCastContext({ isConcentration: false, name: 'Whatever' })).toBeUndefined();
  });

  // Review fix (P2 codex + devin on PR #1952, treated as one bug): the encounter and /turn
  // queries refetch independently, so right after a turn advance one can briefly hold the
  // new actor while the other still holds the previous one. Binding the spell-slot write to
  // `currentCombatant` (the encounter query) instead of `turnWorkspace.current` (the SAME
  // data the Spellbook renders) could debit a different character's slots than the one on
  // screen. Also folds in the archived-campaign gate: `canDmWrite`, not just `isDm`.
  test('RunSessionPage.tsx binds spell-slot writes to turnWorkspace.current, gated on canDmWrite', () => {
    const src = readFileSync(RUN_SESSION_PAGE_PATH, 'utf8');
    const onUpdateSpellSlotSrc = src.slice(src.indexOf('onUpdateSpellSlot={'), src.indexOf('onUseSuggestedAction={'));

    // Bound to the SAME data the panel renders, not the separately-fetched encounter query.
    expect(onUpdateSpellSlotSrc).toContain('turnWorkspace?.current?.characterId');
    expect(onUpdateSpellSlotSrc).not.toContain('currentCombatant?.characterId != null');
    expect(onUpdateSpellSlotSrc).not.toContain('currentCombatant.characterId!');

    // Archived-campaign gate: the DM branch checks canDmWrite, not just isDm.
    expect(onUpdateSpellSlotSrc).toMatch(/isDm\s*&&\s*canDmWrite/);
  });

  // Review fix (P1 codex, atomicity): two separate REST resources (character spell slots,
  // combatant turn-state) can never be one DB transaction without a new combined endpoint.
  // Spend the slot FIRST — it rejects loudly with nothing else touched on insufficient slots
  // — and compensate (refund) if the turn-state patch that follows is rejected, so a partial
  // failure never leaves visible half-applied state either direction.
  test('RunSessionPage.tsx spends the slot before the cast-context patch, and refunds on patch failure', () => {
    const src = readFileSync(RUN_SESSION_PAGE_PATH, 'utf8');
    const onUpdateSpellSlotSrc = src.slice(src.indexOf('onUpdateSpellSlot={'), src.indexOf('onUseSuggestedAction={'));

    // The slot mutation fires FIRST, with the cast-context patch wired as its onSuccess
    // follow-up (applyCastContext is defined above its use, so this checks the wiring, not
    // textual order — the wiring is what actually determines execution sequence).
    expect(onUpdateSpellSlotSrc).toContain(
      'updateSpellSlot.mutate({ characterId, level, delta }, { onSuccess: applyCastContext });',
    );
    expect(onUpdateSpellSlotSrc).toContain('combatantTurnState.mutate(');

    // A cantrip (no slot to spend) still applies its cast context directly.
    expect(onUpdateSpellSlotSrc).toContain('applyCastContext();');

    // Compensating refund on turn-state failure: same delta, negated.
    expect(onUpdateSpellSlotSrc).toContain('onError: () => {');
    expect(onUpdateSpellSlotSrc).toContain('updateSpellSlot.mutate({ characterId, level, delta: -delta })');
  });

  // Review fix (P1 codex): after a turn advance, the /turn and encounter queries can
  // temporarily disagree. `onUseSuggestedAction` used to resolve the actor through the
  // encounter-query-derived `orderedCombatants`/`currentCombatantId` while the Spellbook
  // renders `turnWorkspace` — the exact same drift class as the spell-slot fix.
  test('RunSessionPage.tsx binds resolvable-action casts to turnWorkspace.current too', () => {
    const src = readFileSync(RUN_SESSION_PAGE_PATH, 'utf8');
    const onUseSuggestedActionSrc = src.slice(src.indexOf('onUseSuggestedAction={'), src.indexOf('onEndTurn={'));

    expect(onUseSuggestedActionSrc).toContain('turnWorkspace?.current != null');
    expect(onUseSuggestedActionSrc).toContain('turnWorkspace.current!');
    expect(onUseSuggestedActionSrc).not.toContain('orderedCombatants.find');
    expect(onUseSuggestedActionSrc).not.toContain('currentCombatantId != null &&');
  });

  // Review fix (codex P1 + two devin threads on PR #1952): a resolvable spec has EXACTLY one
  // valid write path (the resolver) — it must never fall through to the direct slot patch, or
  // a slot burns with nothing ever resolved. A non-resolvable CANTRIP (level 0) has no slot to
  // spend but may still declare a real action-economy cost / concentration, which must still
  // reach `onUpdateSlot` instead of being silently dropped.
  test('SpellbookPanel.tsx: executeCast is terminal for a resolvable spell, and a cantrip with cast context still calls onUpdateSlot', () => {
    const src = readFileSync(SPELLBOOK_PANEL_PATH, 'utf8');
    const executeCastSrc = src.slice(src.indexOf('const executeCast ='), src.indexOf('const initiateCast ='));

    // Resolvable branch is terminal (unconditional early return) — the slot-patch code below
    // it is only reachable for a NON-resolvable spell, never as a fallback for a resolvable
    // one whose resolver handler happens not to be wired.
    expect(executeCastSrc).toContain('if (isResolvableSpell(spell)) {');
    expect(executeCastSrc).toContain('return;\n    }\n    // Non-resolvable');

    // The non-resolvable branch calls onUpdateSlot when EITHER a slot is spendable OR a cast
    // context was derived — not only when a level is spendable (the cantrip case).
    expect(executeCastSrc).toContain('levelToSpend != null || castContext != null');
    expect(executeCastSrc).toContain('onUpdateSlot(levelToSpend, levelToSpend != null ? 1 : 0, castContext)');
  });

  test('SpellbookPanel.tsx: Cast is disabled for a resolvable spell when the resolver handler is not wired', () => {
    const src = readFileSync(SPELLBOOK_PANEL_PATH, 'utf8');
    expect(src).toContain("const canCastBase = hasSlotRemaining && !disabled && (!resolvable || onUseActionRequested != null);");
  });
});
