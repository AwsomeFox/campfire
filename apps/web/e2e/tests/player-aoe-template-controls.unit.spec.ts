import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const ROOT = resolve(__dirname, '../../src');
const BATTLE_MAP = readFileSync(resolve(ROOT, 'features/encounters/map/BattleMap.tsx'), 'utf8');
const RUN_SESSION = readFileSync(resolve(ROOT, 'features/encounters/RunSessionPage.tsx'), 'utf8');

test.describe('player AoE template controls (issue #1913)', () => {
  test('players use scoped declare/update/remove callbacks while DM whole-list editing remains available', () => {
    expect(BATTLE_MAP).toContain('effectiveCanDeclareAoe');
    expect(BATTLE_MAP).toContain('const { declaredByUserId: _serverOwnedDeclarer, ...declaration } = t;');
    expect(BATTLE_MAP).toContain('onDeclareAoe(declaration)');
    expect(BATTLE_MAP).toContain('onUpdateAoe(id, patch)');
    expect(BATTLE_MAP).toContain('onRemoveAoe(id)');
    expect(BATTLE_MAP).toContain('if (effectiveCanDmWrite) onSetAoe');
    expect(RUN_SESSION).toContain('/aoe-templates');
  });

  test('player declarations are visibly attributed and the DM can clear only player templates', () => {
    expect(BATTLE_MAP).toContain("strokeDasharray={playerDeclared ? '6 4' : undefined}");
    expect(BATTLE_MAP).toContain('declaredByUserId != null');
    expect(BATTLE_MAP).toContain('aoeDeclarerNames.get(template.declaredByUserId)');
    expect(BATTLE_MAP).toContain("t('encounters.map.aoe.declaredBy'");
    expect(BATTLE_MAP).toContain('onClearPlayerAoe');
    expect(RUN_SESSION).toContain('clearPlayerAoeTemplates');
    expect(RUN_SESSION).toContain('queryKeys.campaignMembers(cid)');
  });

  test('player numeric drafts preserve typing but resync after an unfocused marker move', () => {
    expect(BATTLE_MAP).toContain('const [editingAoeDraft, setEditingAoeDraft] = useState(false);');
    expect(BATTLE_MAP).toContain('if (editingAoeDraft) return;');
    expect(BATTLE_MAP).toContain('onFocus={() => setEditingAoeDraft(true)}');
    expect(BATTLE_MAP).toContain('setEditingAoeDraft(false);');
    expect(BATTLE_MAP).toContain('pendingAoeDraftRef.current = selectedAoe.id;');
    expect(BATTLE_MAP).toContain('function updatePlayerAoeFromDraft');
    expect(BATTLE_MAP).toContain('setAoeDraft(null);');
    expect(RUN_SESSION).toContain('onUpdateAoe={async (templateId, patch) =>');
    expect(RUN_SESSION).toContain('throw error;');
  });

  test('player movement updates the local encounter before the scoped PATCH settles', () => {
    const updateAoe = RUN_SESSION.slice(RUN_SESSION.indexOf('const updateAoeTemplate'), RUN_SESSION.indexOf('const removeAoeTemplate'));
    expect(updateAoe).toContain('queryClient.setQueryData<EncounterWithCombatants>(queryKeys.encounter(eid)');
    expect(updateAoe).toContain('current.aoe.map((template) => (template.id === templateId ? { ...template, ...patch } : template))');
    expect(updateAoe).toContain('invalidateEncounter(queryClient, eid);');
  });

  test('the new declaration callbacks do not extend the existing damage-application surface', () => {
    const damageBar = RUN_SESSION.slice(RUN_SESSION.indexOf('<ApplyDamageBar'));
    expect(damageBar).not.toContain('onDeclareAoe');
    expect(damageBar).not.toContain('onUpdateAoe');
  });
});
