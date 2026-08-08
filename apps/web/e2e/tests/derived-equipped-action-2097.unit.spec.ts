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

  test('the editor is gated on `editable`, never rendered for a read-only viewer', () => {
    // A campaign member who is neither DM nor the owning player receives
    // `equippedAction: null` from the server's fail-closed redaction; offering them an
    // editor would invite a write that overwrites an action they were never shown.
    expect(inventoryShared).toContain('{editable && !actionOpen && (');
    expect(inventoryShared).toContain('{editable && actionOpen && actionDraft && (');
  });

  test('saving preserves the action `spec` rather than rebuilding it from the text fields', () => {
    // A derived attack carries a structured spec the resolver auto-resolves. The five text
    // inputs cannot reconstruct one, so the draft is spread — dropping it would silently
    // downgrade a resolvable attack to a text-only row on any edit, including a typo fix.
    expect(inventoryShared).toContain('equippedAction: { ...actionDraft, name }');
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
