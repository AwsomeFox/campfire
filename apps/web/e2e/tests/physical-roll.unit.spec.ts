import { expect, test } from '@playwright/test';
import type { DiceRoll } from '@campfire/schema';
import { d20Flavor } from '../../src/lib/d20Flavor';
import { diceRollSummaryLine, showRolledDice } from '../../src/features/dice/diceRollDisplay';
import {
  EMPTY_PHYSICAL_ROLL_FORM,
  parsePhysicalRollForm,
  physicalRollActorName,
} from '../../src/features/dice/physicalRollForm';
import { formatDiceRollAnnouncement } from '../../src/features/dice/diceLogAccessibility';
import diceEn from '../../src/i18n/locales/en/dice.json';

function mockT(key: string, opts?: Record<string, unknown>): string {
  const short = key.startsWith('dice.') ? key.slice('dice.'.length) : key;
  const entry = (diceEn.dice as Record<string, unknown>)[short];
  let template = typeof entry === 'string' ? entry : key;
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      template = template.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
    }
  }
  return template;
}

function manualRoll(partial: Partial<DiceRoll> = {}): DiceRoll {
  return {
    id: 1,
    campaignId: 1,
    rollerUserId: 'dm-1',
    rollerName: 'DM',
    expr: 'physical',
    rolls: [],
    total: 18,
    source: 'manual',
    visibility: 'party_shared',
    createdAt: '2026-07-23T12:00:00.000Z',
    ...partial,
  };
}

test.describe('physical roll logging (#673)', () => {
  test('parsePhysicalRollForm accepts total, label, actor, natural d20, and DC', () => {
    const parsed = parsePhysicalRollForm({
      total: '22',
      label: 'DEX save',
      actor: 'Thorin',
      natural20: '17',
      dc: '15',
    });
    expect(parsed).toEqual({
      ok: true,
      payload: { total: 22, label: 'DEX save', actor: 'Thorin', natural20: 17, dc: 15 },
    });
  });

  test('parsePhysicalRollForm rejects missing total and invalid natural d20', () => {
    expect(parsePhysicalRollForm({ ...EMPTY_PHYSICAL_ROLL_FORM, total: '' }).ok).toBe(false);
    expect(parsePhysicalRollForm({ ...EMPTY_PHYSICAL_ROLL_FORM, total: '12', natural20: '21' }).ok).toBe(false);
  });

  test('manual rolls do not get crit/fumble flavor or fabricated dice UI', () => {
    const roll = manualRoll({ natural20: 20, total: 25 });
    expect(d20Flavor(roll)).toBeNull();
    expect(showRolledDice(roll)).toBe(false);
    expect(diceRollSummaryLine(roll, 'physical roll')).toBe('physical roll (nat 20)');
  });

  test('actor attribution prefers the table actor over the logger', () => {
    expect(physicalRollActorName(manualRoll({ actor: 'Goblin #2' }))).toBe('Goblin #2');
    expect(diceRollSummaryLine(manualRoll({ label: 'Attack', actor: 'Rogue' }), 'physical roll')).toContain('Attack: physical roll');
  });

  test('announcement describes a physical roll without dice faces or crit flourish', () => {
    const spoken = formatDiceRollAnnouncement(
      manualRoll({ label: 'Perception', actor: 'Scout', total: 14, natural20: 9, dc: 12, success: true }),
      mockT as never,
    );
    expect(spoken).toMatch(/Scout/i);
    expect(spoken).toMatch(/14/);
    expect(spoken).toMatch(/natural d20 9/i);
    expect(spoken).toMatch(/DC 12/i);
    expect(spoken).not.toMatch(/critical/i);
    expect(spoken).not.toMatch(/\[.*\]/);
  });
});
