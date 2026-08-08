import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Issue #2097 — source-level guards for the web half of the derived-action loop. Same
 * static-assertion style as equipped-actions-1901.unit.spec.ts (no browser, no backend);
 * interactive coverage lives in the Playwright e2e suite.
 *
 * The two things worth pinning here are the ones a future refactor would quietly break:
 * the editor must not be offered to a reader the server redacts the action away from, and
 * saving an edit must not drop the structured `spec` a derived attack carries.
 */
const inventoryShared = readFileSync(resolve(__dirname, '../../src/features/inventory/inventoryShared.tsx'), 'utf8');

test.describe('editable equipped-item actions (#2097)', () => {
  test('the row offers an editor for the equipped action', () => {
    expect(inventoryShared).toContain('data-testid="inventory-action-editor"');
    expect(inventoryShared).toContain('data-testid="inventory-edit-action-btn"');
    expect(inventoryShared).toContain('data-testid="inventory-action-save-btn"');
  });

  test('the editor is gated on a CHARACTER owner, never offered on the party stash', () => {
    // Review (chatgpt-codex-connector P2): `canEditItem` makes every party-stash row editable
    // on the campaign Inventory page, so gating on `editable` alone put an Add-action button
    // across the whole stash section — where the server rejects the payload outright
    // ("Only character-owned items may carry an equipped action"). A control that can never
    // succeed is worse than no control.
    expect(inventoryShared).toContain("const isCharacterOwned = committed.ownerType === 'character' && committed.characterId != null;");
    expect(inventoryShared).toContain('{editable && isCharacterOwned && !actionOpen && (');
    expect(inventoryShared).toContain('{editable && isCharacterOwned && actionOpen && actionDraft && (');
  });

  test('the editor is gated on `editable`, never rendered for a read-only viewer', () => {
    // A campaign member who is neither DM nor the owning player receives
    // `equippedAction: null` from the server's fail-closed redaction; offering them an
    // editor would invite a write that overwrites an action they were never shown.
    expect(inventoryShared).toContain('{editable && isCharacterOwned && !actionOpen && (');
    expect(inventoryShared).toContain('{editable && isCharacterOwned && actionOpen && actionDraft && (');
  });

  test('saving drops the stale `spec` when a combat field changed, and keeps it otherwise', () => {
    // Review (chatgpt-codex-connector P1, Copilot): the resolver ROLLS the structured spec;
    // toHit/damage are only what it shows. Round-tripping the old spec after editing those
    // numbers displayed the correction and kept rolling the original — the exact failure the
    // editor was built to fix. The server rebuilds one from the edited values; a prose-only
    // edit keeps the existing spec so an MCP-authored action survives a typo fix.
    expect(inventoryShared).toContain('const combatFieldsChanged =');
    expect(inventoryShared).toContain('prior.toHit !== actionDraft.toHit');
    expect(inventoryShared).toContain('prior.damage !== actionDraft.damage');
    expect(inventoryShared).toContain('spec: combatFieldsChanged ? undefined : actionDraft.spec');
  });

  test('a server-derived action is labelled as derived', () => {
    expect(inventoryShared).toContain("committed.equippedActionSource === 'derived'");
    expect(inventoryShared).toContain('data-testid="inventory-action-derived-badge"');
    expect(inventoryShared).toContain("t('inventory.equip.derivedBadge')");
  });

  test('an empty name is rejected client-side before the PATCH', () => {
    expect(inventoryShared).toContain("setActionError(t('inventory.equip.actionNameRequired'))");
  });

  test('the action can be removed, which re-opens the item to derivation', () => {
    expect(inventoryShared).toContain('data-testid="inventory-action-remove-btn"');
    expect(inventoryShared).toContain('equippedAction: null');
  });
});
