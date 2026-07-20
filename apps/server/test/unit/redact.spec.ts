import type { Role } from '@campfire/schema';
import { redactSecret, redactSecrets, isVisibleTo, filterHidden } from '../../src/common/redact';

/**
 * Unit tests for DM-secret stripping and hidden-entity gating (issue #79).
 * These pin the exact visibility rules the e2e suite only exercises through HTTP.
 */
describe('redact — redactSecret / redactSecrets', () => {
  const quest = { id: 1, title: 'The Vault', dmSecret: 'trapdoor at the altar' };

  it('keeps dmSecret intact for a dm', () => {
    expect(redactSecret(quest, 'dm').dmSecret).toBe('trapdoor at the altar');
  });

  it.each<Role>(['player', 'viewer'])('blanks dmSecret for %s', (role) => {
    const out = redactSecret(quest, role);
    expect(out.dmSecret).toBe('');
    expect(out.title).toBe('The Vault'); // non-secret fields survive
  });

  it('does not mutate the source entity', () => {
    const original = { ...quest };
    redactSecret(quest, 'viewer');
    expect(quest).toEqual(original);
  });

  it('redacts every element for a non-dm (redactSecrets)', () => {
    const list = [
      { id: 1, dmSecret: 'a' },
      { id: 2, dmSecret: 'b' },
    ];
    const out = redactSecrets(list, 'player');
    expect(out.map((e) => e.dmSecret)).toEqual(['', '']);
  });

  it('leaves every element intact for a dm (redactSecrets)', () => {
    const list = [{ id: 1, dmSecret: 'a' }];
    expect(redactSecrets(list, 'dm')[0].dmSecret).toBe('a');
  });
});

describe('redact — isVisibleTo / filterHidden (issue #42 whole-entity secrecy)', () => {
  const hidden = { id: 1, name: 'Secret Door', hidden: true };
  const shown = { id: 2, name: 'Town Square', hidden: false };

  it('a dm sees hidden entities', () => {
    expect(isVisibleTo(hidden, 'dm')).toBe(true);
  });

  it.each<Role>(['player', 'viewer'])('%s cannot see a hidden entity', (role) => {
    expect(isVisibleTo(hidden, role)).toBe(false);
  });

  it('everyone sees a non-hidden entity', () => {
    expect(isVisibleTo(shown, 'viewer')).toBe(true);
  });

  it('treats a missing hidden flag as visible', () => {
    const noFlag: { id: number; hidden?: boolean } = { id: 3 };
    expect(isVisibleTo(noFlag, 'viewer')).toBe(true);
  });

  it('filterHidden drops hidden rows for a non-dm', () => {
    expect(filterHidden([hidden, shown], 'player')).toEqual([shown]);
  });

  it('filterHidden keeps everything for a dm', () => {
    expect(filterHidden([hidden, shown], 'dm')).toEqual([hidden, shown]);
  });
});
