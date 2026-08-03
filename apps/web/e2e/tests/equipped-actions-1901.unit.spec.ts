import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Issue #1901 — source-level regression guards for the web side of the equipment loop:
 * (1) the in-encounter character card fetches the server's MERGED action list (sheet +
 *     equipped-item actions, one stable index space) instead of mapping the raw
 *     `character.actions` array, and Use always passes the index/name/spec straight from
 *     that fetched row — never re-derived by indexing into `character.actions`, which is
 *     exactly the lookup that silently dropped equipped-item actions;
 * (2) the shared inventory item row (used by both the campaign Inventory page and the
 *     character-sheet inventory section) offers an equip/unequip control, a free-text slot
 *     field with common-slot suggestions, an "equipped" badge, an equipped-action line, and
 *     a one-tap swap on the 409 INVENTORY_SLOT_CONFLICT response;
 * (3) the API client surfaces the conflict body's `conflictingItemId`/`conflictingItemName`/
 *     `equipSlot` fields the swap flow depends on.
 *
 * These are static-source assertions (no browser, no seeded backend), same style as
 * combat-mobile-target-size.unit.spec.ts and compendium-inventory-1782.unit.spec.ts — full
 * interactive coverage lives in the Playwright e2e suite.
 */
const characterStatCard = readFileSync(resolve(__dirname, '../../src/components/CharacterStatCard.tsx'), 'utf8');
const inventoryShared = readFileSync(resolve(__dirname, '../../src/features/inventory/inventoryShared.tsx'), 'utf8');
const runSessionPage = readFileSync(resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx'), 'utf8');
const apiLib = readFileSync(resolve(__dirname, '../../src/lib/api.ts'), 'utf8');
const actionUseFlow = readFileSync(resolve(__dirname, '../../src/features/encounters/ActionUseFlow.tsx'), 'utf8');

test.describe('equipped-item actions in the encounter card (#1901)', () => {
  test('CharacterStatCard fetches the merged actions endpoint scoped to the combatant', () => {
    expect(characterStatCard).toContain("api.get<UsableAction[]>(`${API}/encounters/${encounterId}/combatants/${combatantId}/actions`)");
    // Same cache key shape CombatantActionsList uses, so SSE invalidation of the encounter
    // query prefix busts both.
    expect(characterStatCard).toContain("[...queryKeys.encounter(encounterId!), 'actions', combatantId!]");
  });

  test('the Actions section renders from the merged displayActions list, not raw character.actions', () => {
    expect(characterStatCard).toContain('displayActions.map((a) =>');
    expect(characterStatCard).not.toMatch(/character\.actions\.map\(\(a,\s*i\)\s*=>/);
  });

  test('Use always passes the fetched row\'s own index/name/spec — never a raw character.actions lookup', () => {
    expect(characterStatCard).toContain('onClick={() => a.spec && onUseAction(a.index, a.name, a.spec)}');
  });

  test('an equipped-item row renders its "equipped: <item>" source tag', () => {
    expect(characterStatCard).toContain('data-testid="action-source-tag"');
    expect(characterStatCard).toContain('{a.source}');
  });

  test('RunSessionPage wires encounterId/combatantId into the card and no longer re-derives the action from ch.actions[actionIndex]', () => {
    expect(runSessionPage).toContain('encounterId={encounterId}');
    expect(runSessionPage).toContain('combatantId={combatant.id}');
    expect(runSessionPage).not.toContain('ch?.actions[actionIndex]');
  });

  test('an inventory equip/unequip (character.updated) invalidates this encounter\'s cached action lists', () => {
    expect(runSessionPage).toContain('invalidateEncounter(queryClient, eid)');
  });
});

test.describe('inventory equip/unequip UI (#1901)', () => {
  test('a character-owned item offers Equip / Unequip controls, gated on ownerType', () => {
    expect(inventoryShared).toContain("committed.ownerType === 'character'");
    expect(inventoryShared).toContain('data-testid="inventory-equip-btn"');
    expect(inventoryShared).toContain('data-testid="inventory-unequip-btn"');
    expect(inventoryShared).toContain('data-testid="inventory-equipped-badge"');
  });

  test('the slot field is free text with common-slot suggestions, not a hardcoded enum', () => {
    expect(inventoryShared).toContain('list={`inventory-slot-suggestions-${committed.id}`}');
    expect(inventoryShared).toContain('<datalist');
    expect(inventoryShared).toContain("t('inventory.equip.slotSuggestions'");
  });

  test('an equipped item with an authored equippedAction shows a "grants combat action" line', () => {
    expect(inventoryShared).toContain('data-testid="inventory-grants-action"');
    expect(inventoryShared).toContain("t('inventory.equip.grantsAction', { name: committed.equippedAction.name })");
  });

  test('a 409 INVENTORY_SLOT_CONFLICT surfaces a one-tap swap', () => {
    expect(inventoryShared).toContain("err.code === 'INVENTORY_SLOT_CONFLICT'");
    expect(inventoryShared).toContain('data-testid="inventory-slot-swap-btn"');
    expect(inventoryShared).toContain('async function swapEquip()');
  });

  // Rework round (PR #1951 re-review): the swap used to be two client-orchestrated
  // requests — unequip the incumbent, then retry the original equip — with a real
  // half-applied window (another writer claims the slot between requests, or the second
  // request fails) and a swallowed-failure path (submitEquip silently returns without
  // touching equipBusy when given an empty slot, so the controls froze disabled forever).
  // The fix is server-side atomicity, not client rollback: one PATCH on THIS item with
  // `displaceEquipped: true` unequips the incumbent and equips this item in the SAME
  // server transaction, so there is no intermediate state to land in or roll back.
  test('the swap is ONE atomic PATCH (displaceEquipped), not an unequip-then-equip sequence', () => {
    expect(inventoryShared).toMatch(
      /inventory\/\$\{committed\.id\}`,\s*\{\s*equipped:\s*true,\s*equipSlot:\s*slotConflict\.slot,\s*displaceEquipped:\s*true,\s*\}/,
    );
    // No separate PATCH against the incumbent (slotConflict.itemId) inside swapEquip —
    // the server displaces it as part of the equip write above.
    expect(inventoryShared).not.toMatch(/inventory\/\$\{slotConflict\.itemId\}`,\s*\{\s*equipped:\s*false\s*\}/);
    // Always clears equipBusy via finally — no early return before the try/finally that
    // could leave the controls stuck disabled (the bug the old submitEquip(slotDraft)
    // delegation had on an empty slot).
    expect(inventoryShared).toMatch(/async function swapEquip\(\)[\s\S]{0,1200}?finally\s*\{\s*setEquipBusy\(false\);/);
  });

  // Rework round 3 (PR #1951 re-review, devin-ai-integration): the "Replace <incumbent>"
  // button and its warning text both name `slotConflict.itemName`/`.slot` — that is the
  // confirmed thing the player is agreeing to displace. The slot text input stays open and
  // editable while that warning shows, so if swapEquip read `slotDraft` instead, editing the
  // box after seeing the conflict could silently displace a DIFFERENT item than the one the
  // button names.
  test('swapEquip targets the CONFIRMED conflict slot, never the editable slotDraft', () => {
    const bodyIdx = inventoryShared.indexOf('async function swapEquip()');
    expect(bodyIdx).toBeGreaterThan(-1);
    const bodyEnd = inventoryShared.indexOf('\n  async function unequip()', bodyIdx);
    expect(bodyEnd).toBeGreaterThan(bodyIdx);
    // Executable code only — the doc comment above legitimately mentions `slotDraft` in
    // prose to explain why it's NOT used, which would otherwise false-fail a raw substring
    // check over the whole slice.
    const codeStart = inventoryShared.indexOf('{', bodyIdx);
    const swapEquipCode = inventoryShared.slice(codeStart, bodyEnd);
    expect(swapEquipCode).not.toContain('slotDraft');
    expect(swapEquipCode).toContain('slotConflict.slot');
  });
});

test.describe('API client surfaces the slot-conflict body (#1901)', () => {
  test('ApiError carries conflictingItemId/conflictingItemName/equipSlot from a 409 body', () => {
    expect(apiLib).toContain('public conflictingItemId?: number');
    expect(apiLib).toContain('public conflictingItemName?: string');
    expect(apiLib).toContain('public equipSlot?: string');
    expect(apiLib).toContain('parseInventorySlotConflictFields(body)');
  });
});

// Rework round 3 (PR #1951 re-review, chatgpt-codex-connector P1): if an equipped item's
// action is removed/unequipped/reordered while the Use panel is open, a different action
// can shift into the captured `actionIndex`. The server's resolveSpec already guards
// against this — it 400s when actionIndex AND actionName are both supplied and the name at
// that index no longer matches (see action-resolver.service.ts) — but the panel used to
// post only actionIndex, so that guard was unreachable for the equipment loop.
test.describe('ActionUsePanel binds resolve to the selected action name (#1901)', () => {
  test('the resolve-preview request includes actionName alongside actionIndex', () => {
    const mutationStart = actionUseFlow.indexOf('const resolvePreview = useMutation({');
    expect(mutationStart).toBeGreaterThan(-1);
    const mutationEnd = actionUseFlow.indexOf('const commit = useMutation({', mutationStart);
    expect(mutationEnd).toBeGreaterThan(mutationStart);
    const resolvePreviewSource = actionUseFlow.slice(mutationStart, mutationEnd);
    expect(resolvePreviewSource).toMatch(/actorCombatantId,/);
    expect(resolvePreviewSource).toMatch(/\bactionIndex,/);
    expect(resolvePreviewSource).toMatch(/\bactionName,/);
    // Order within the request body: actorCombatantId, then actionIndex, then actionName
    // (a comment explaining why sits between actionIndex and actionName).
    const iActor = resolvePreviewSource.indexOf('actorCombatantId,');
    const iIndex = resolvePreviewSource.indexOf('actionIndex,');
    const iName = resolvePreviewSource.indexOf('actionName,');
    expect(iActor).toBeGreaterThan(-1);
    expect(iIndex).toBeGreaterThan(iActor);
    expect(iName).toBeGreaterThan(iIndex);
  });
});
