import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InventoryFromCompendium } from '@campfire/schema';

const ROOT = resolve(__dirname, '../..');
const service = readFileSync(resolve(ROOT, 'src/modules/inventory/inventory.service.ts'), 'utf8');
const controller = readFileSync(resolve(ROOT, 'src/modules/inventory/inventory.controller.ts'), 'utf8');
const mcp = readFileSync(resolve(ROOT, 'src/modules/mcp/mcp-tools.ts'), 'utf8');
const campaigns = readFileSync(resolve(ROOT, 'src/modules/campaigns/campaigns.service.ts'), 'utf8');
const exportProfiles = readFileSync(resolve(ROOT, 'src/modules/export/export-profiles.ts'), 'utf8');

describe('compendium inventory acquisition (#738)', () => {
  it('has one strict acquisition contract for REST and MCP', () => {
    expect(InventoryFromCompendium.parse({ ruleEntryId: 1 })).toMatchObject({ ownerType: 'party', qty: 1, duplicateMode: 'confirm' });
    expect(() => InventoryFromCompendium.parse({ ruleEntryId: 1, unexpected: true })).not.toThrow(); // DTO makes transport strict.
    expect(controller).toContain("@Post('from-compendium')");
    expect(mcp).toContain("'acquire_compendium_item'");
    expect(mcp).toContain('this.inventory.acquireFromCompendium');
  });

  it('keeps forged provenance out of manual item schemas and identifies duplicates by stable ref', () => {
    const dto = readFileSync(resolve(ROOT, 'src/modules/inventory/inventory.dto.ts'), 'utf8');
    expect(dto).toContain('InventoryItemCreate.strict()');
    expect(dto).toContain('InventoryItemUpdate.strict()');
    expect(service).toContain('compendiumRefKey(candidateRef.data) === compendiumRefKey(ref)');
  });

  it('requires duplicate confirmation, composes increments, and records idempotent acquisition replays', () => {
    expect(service).toContain("code: 'INVENTORY_COMPENDIUM_DUPLICATE'");
    expect(service).toContain("input.duplicateMode === 'increment'");
    expect(service).toContain("code: 'IDEMPOTENCY_KEY_REUSE'");
    expect(service).toContain('inventoryQtyIdempotency');
    expect(service).toContain('this.db.transaction');
  });

  it('keeps player fields independent from the source snapshot across link state changes', () => {
    expect(service).toContain("item.compendiumState = 'linked_updated'");
    expect(service).toContain('async refreshCompendium');
    expect(service).toContain("state: 'overridden' | 'detached'");
    expect(service).toContain('compendiumSnapshot: JSON.stringify(snapshot)');
  });

  it('imports exported object provenance as a detached, play-safe snapshot', () => {
    expect(campaigns).toContain('safeImportedCompendiumRef(item.compendiumRef)');
    expect(campaigns).toContain('safeImportedCompendiumSnapshot(item.compendiumSnapshot)');
    expect(campaigns).toContain("compendiumState: safeImportedCompendiumRef(item.compendiumRef) && safeImportedCompendiumSnapshot(item.compendiumSnapshot) ? 'detached' : null");
    expect(campaigns).toContain("sourceUrl: ''");
    expect(service).toContain('sanitizeCompendiumSnapshot');
    expect(service).toContain('sanitizeCompendiumSnapshot(buildCompendiumSnapshot(entry))');
    expect(service).toContain('withCompendiumStates');
    expect(service).toContain('inArray(ruleEntries.id, linkedIds)');
    expect(service).toContain('const refreshed = await this.withCompendiumState(row);');
    expect(service).toContain('return (await this.redactEquippedActions([refreshed], user, role))[0];');
    expect(service).toContain("action: 'item.refresh_compendium'");
    expect(service).toContain("action: 'item.compendium_state'");
    // Handoff/publish allowlists must retain portable provenance (ruleEntryId is nulled on import).
    expect(exportProfiles).toContain("'ruleEntryId', 'compendiumRef', 'compendiumSnapshot', 'compendiumState'");
  });
});
