import {
  extractToolResourceIdentity,
  projectAiDmToolEventForRole,
} from '../../src/modules/ai-driver/ai-dm-tool-resource';

/**
 * Pure helpers for AI-DM tool resource identity (#825) — extract from validated
 * args/results and role-project so hidden encounter ids never reach non-DMs.
 */
describe('ai-dm tool resource identity (#825)', () => {
  describe('extractToolResourceIdentity', () => {
    it('reads encounterId from validated args for encounter mutations', () => {
      expect(
        extractToolResourceIdentity('update_combatant', { encounterId: 42, combatantId: 7 }, undefined, false),
      ).toEqual({ encounterId: 42 });
      expect(extractToolResourceIdentity('next_turn', { encounterId: 9 }, undefined, false)).toEqual({
        encounterId: 9,
      });
      expect(extractToolResourceIdentity('add_combatant', { encounterId: 3 }, undefined, true)).toEqual({
        encounterId: 3,
      });
    });

    it('derives create_encounter identity from the result id (not model text)', () => {
      expect(
        extractToolResourceIdentity(
          'create_encounter',
          { campaignId: 1, name: 'Ambush', hidden: true },
          JSON.stringify({ id: 55, name: 'Ambush', hidden: true }),
          false,
        ),
      ).toEqual({ encounterId: 55, encounterHidden: true });
    });

    it('ignores create_encounter on error (no fabricated id)', () => {
      expect(
        extractToolResourceIdentity(
          'create_encounter',
          { campaignId: 1, name: 'Ambush' },
          JSON.stringify({ error: { status: 400, code: 'bad', message: 'nope' } }),
          true,
        ),
      ).toEqual({});
    });

    it('captures update_encounter hidden toggles from args when result is absent', () => {
      expect(
        extractToolResourceIdentity('update_encounter', { encounterId: 12, hidden: false }, undefined, false),
      ).toEqual({ encounterId: 12, encounterHidden: false });
    });

    it('rejects non-positive / non-integer encounter ids', () => {
      expect(extractToolResourceIdentity('next_turn', { encounterId: 0 }, undefined, false)).toEqual({});
      expect(extractToolResourceIdentity('next_turn', { encounterId: 1.5 }, undefined, false)).toEqual({});
      expect(extractToolResourceIdentity('next_turn', { encounterId: '9' }, undefined, false)).toEqual({});
    });

    it('leaves non-encounter tools without identity', () => {
      expect(extractToolResourceIdentity('roll_dice', { campaignId: 1, expr: '2d6' }, undefined, false)).toEqual({});
    });
  });

  describe('projectAiDmToolEventForRole', () => {
    const base = {
      type: 'tool' as const,
      campaignId: 1,
      name: 'add_combatant',
      isError: false,
      proposed: false,
      at: '2026-07-23T12:00:00.000Z',
    };

    it('keeps encounterId for DMs even when the encounter is hidden', () => {
      expect(
        projectAiDmToolEventForRole({ ...base, encounterId: 8, encounterHidden: true }, 'dm'),
      ).toEqual({ ...base, encounterId: 8 });
    });

    it('strips encounterId (and the hidden flag) for non-DMs on hidden encounters', () => {
      expect(
        projectAiDmToolEventForRole({ ...base, encounterId: 8, encounterHidden: true }, 'player'),
      ).toEqual(base);
      expect(
        projectAiDmToolEventForRole({ ...base, encounterId: 8, encounterHidden: true }, 'viewer'),
      ).toEqual(base);
    });

    it('reveals encounterId to players when the encounter is not hidden', () => {
      expect(
        projectAiDmToolEventForRole({ ...base, encounterId: 8, encounterHidden: false }, 'player'),
      ).toEqual({ ...base, encounterId: 8 });
    });

    it('never forwards the internal encounterHidden flag on the wire', () => {
      const projected = projectAiDmToolEventForRole(
        { ...base, encounterId: 8, encounterHidden: false },
        'dm',
      );
      expect(projected).not.toHaveProperty('encounterHidden');
    });
  });
});
