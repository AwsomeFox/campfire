import { expect, test } from '@playwright/test';
import type { DiceRoll } from '@campfire/schema';
import {
  advanceDiceRollAnnouncements,
  DICE_LOG_LIVE_REGION,
  formatDiceRollAnnouncement,
  formatDiceRollAnnouncementBatch,
} from '../../src/features/dice/diceLogAccessibility';
import diceEn from '../../src/i18n/locales/en/dice.json';

function mockT(key: string, opts?: Record<string, unknown>): string {
  const short = key.startsWith('dice.') ? key.slice('dice.'.length) : key;
  let template = (diceEn.dice as Record<string, string>)[short] ?? key;
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      template = template.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
    }
  }
  return template;
}

function roll(partial: Partial<DiceRoll> & Pick<DiceRoll, 'id' | 'expr' | 'total' | 'rolls'>): DiceRoll {
  return {
    campaignId: 1,
    rollerUserId: 'user:2',
    rollerName: 'Mira',
    createdAt: '2026-07-23T12:00:00.000Z',
    kept: undefined,
    dc: undefined,
    success: undefined,
    label: '',
    terms: undefined,
    ...partial,
  };
}

test.describe('shared dice log accessibility (#590)', () => {
  test('visual feed exposes role=log with aria-live=off', () => {
    expect(DICE_LOG_LIVE_REGION).toEqual({ role: 'log', 'aria-live': 'off' });
  });

  test('silences hydrated history then announces only new roll ids', () => {
    const baseline = [roll({ id: 1, expr: '1d20', total: 12, rolls: [12] })];
    const first = advanceDiceRollAnnouncements(baseline, null);
    expect(first.appendedRolls).toEqual([]);

    const remote = [
      roll({ id: 2, expr: '2d6+3', total: 11, rolls: [4, 4], kept: [4, 4] }),
      ...baseline,
    ];
    const second = advanceDiceRollAnnouncements(remote, first.cursor);
    expect(second.appendedRolls.map((r) => r.id)).toEqual([2]);

    const third = advanceDiceRollAnnouncements(remote, second.cursor);
    expect(third.appendedRolls).toEqual([]);
  });

  test('remote announcement names roller, expression, kept dice, total, and DC outcome', () => {
    const spoken = formatDiceRollAnnouncement(
      roll({
        id: 3,
        expr: '1d20+5',
        total: 22,
        rolls: [17],
        dc: 15,
        success: true,
      }),
      mockT as never,
    );
    expect(spoken).toMatch(/Mira/i);
    expect(spoken).toMatch(/1d20\+5/);
    expect(spoken).toMatch(/22/);
    expect(spoken).toMatch(/17/);
    expect(spoken).toMatch(/DC 15/i);
  });

  test('batch formatter preserves chronological order for reconnect bursts', () => {
    const newer = roll({ id: 5, expr: '1d4', total: 3, rolls: [3] });
    const older = roll({ id: 4, expr: '1d6', total: 6, rolls: [6] });
    const message = formatDiceRollAnnouncementBatch([newer, older], mockT as never);
    expect(message).toMatch(/2 new dice rolls/);
    expect(message.indexOf('1d6')).toBeLessThan(message.indexOf('1d4'));
  });
});
