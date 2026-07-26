/**
 * Issue #585 — the pure parts of campaign modules: semver range satisfaction (which the
 * compatibility and dependency contracts are evaluated with) and the three-way merge
 * algebra that decides whether a publisher's correction may touch a table's edit.
 *
 * These are unit tests on purpose: the merge rules are the part of the feature that must
 * be exhaustively correct, and every case below is reachable from the HTTP surface but
 * far cheaper to pin down here.
 */
import {
  compareVersionStrings,
  isValidSemver,
  parseSemver,
  parseSemverRange,
  satisfiesSemverRange,
  semverTransition,
} from '@campfire/schema';
import {
  applyOverlay,
  computeOverlay,
  hashPortable,
  projectPortable,
  threeWayMerge,
} from '../../src/modules/campaign-modules/module-content';

describe('semver (issue #585)', () => {
  it('parses and rejects', () => {
    expect(parseSemver('1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver('1.2.3-rc.1+build.5')).toMatchObject({ prerelease: ['rc', 1], build: ['build', '5'] });
    expect(isValidSemver('1.2')).toBe(false);
    expect(isValidSemver('01.2.3')).toBe(false);
    expect(isValidSemver('v1.2.3')).toBe(false);
    expect(isValidSemver('')).toBe(false);
  });

  it('orders releases above their prereleases', () => {
    expect(compareVersionStrings('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersionStrings('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareVersionStrings('1.0.0-rc.1', '1.0.0-rc.2')).toBe(-1);
    expect(compareVersionStrings('2.0.0', '10.0.0')).toBe(-1);
    expect(compareVersionStrings('1.2.3', '1.2.3')).toBe(0);
  });

  it('satisfies caret, tilde, comparator and union ranges', () => {
    expect(satisfiesSemverRange('1.4.0', '^1.2.0')).toBe(true);
    expect(satisfiesSemverRange('2.0.0', '^1.2.0')).toBe(false);
    // 0.x is unstable: ^0.2.3 allows patches but not 0.3.0.
    expect(satisfiesSemverRange('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfiesSemverRange('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfiesSemverRange('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfiesSemverRange('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfiesSemverRange('1.5.0', '>=1.2.0 <2.0.0')).toBe(true);
    expect(satisfiesSemverRange('2.0.0', '>=1.2.0 <2.0.0')).toBe(false);
    expect(satisfiesSemverRange('2.1.0', '^1.0.0 || ^2.0.0')).toBe(true);
    expect(satisfiesSemverRange('3.0.0', '^1.0.0 || ^2.0.0')).toBe(false);
    expect(satisfiesSemverRange('9.9.9', '*')).toBe(true);
    expect(satisfiesSemverRange('1.2.3', '1.2.3')).toBe(true);
  });

  it('keeps prereleases out of ranges that do not name them', () => {
    expect(satisfiesSemverRange('2.0.0-rc.1', '^1.0.0')).toBe(false);
    expect(satisfiesSemverRange('1.3.0-rc.1', '>=1.2.0')).toBe(false);
    expect(satisfiesSemverRange('1.3.0-rc.1', '>=1.3.0-rc.0')).toBe(true);
  });

  it('reports an unparseable range distinctly from a non-match', () => {
    expect(parseSemverRange('not a range')).toBeNull();
    expect(parseSemverRange('^1.2.0')).not.toBeNull();
    expect(satisfiesSemverRange('1.0.0', 'not a range')).toBe(false);
  });

  it('classifies version transitions', () => {
    expect(semverTransition('1.0.0', '1.1.0')).toBe('upgrade');
    expect(semverTransition('1.1.0', '1.0.0')).toBe('downgrade');
    expect(semverTransition('1.0.0', '1.0.0')).toBe('same');
    expect(semverTransition('nope', '1.0.0')).toBe('unknown');
  });
});

describe('portable content projection (issue #585)', () => {
  it('is a closed whitelist — unknown keys can never reach a write', () => {
    const projected = projectPortable('npc', {
      name: 'Vex',
      body: 'A fence.',
      id: 99,
      campaignId: 7,
      deletedAt: '2026-01-01T00:00:00.000Z',
      portraitUrl: '/uploads/9.png',
    });
    expect(projected).not.toHaveProperty('id');
    expect(projected).not.toHaveProperty('campaignId');
    expect(projected).not.toHaveProperty('deletedAt');
    expect(projected).not.toHaveProperty('portraitUrl');
    expect(projected.name).toBe('Vex');
  });

  it('normalizes absent/null/undefined to the same canonical value, so hashes compare across installs', () => {
    const a = hashPortable('location', { name: 'Keep', body: null, mapX: undefined, parentKey: '' });
    const b = hashPortable('location', { name: 'Keep', body: '', mapX: null, parentKey: null });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('hashes differently per kind, so a key collision across kinds is not a content collision', () => {
    expect(hashPortable('npc', { name: 'X' })).not.toBe(hashPortable('faction', { name: 'X' }));
  });

  it('defaults enum-backed columns instead of normalizing them to an out-of-range empty string', () => {
    // `''` is not a member of LocationStatus, and a location whose status is not
    // `unexplored` is visible to players — so an omitted status must land on the enum's
    // canonical value, and must do so HERE so the baseline and the live row agree.
    expect(projectPortable('location', { name: 'Keep' }).status).toBe('unexplored');
    expect(projectPortable('npc', { name: 'Vex' }).disposition).toBe('neutral');
    expect(projectPortable('quest', { title: 'Rescue' }).status).toBe('available');
    expect(projectPortable('faction', { name: 'Hand' }).standing).toBe('neutral');
    // An explicit value still wins, and null/'' collapse onto the same default.
    expect(projectPortable('location', { status: 'explored' }).status).toBe('explored');
    expect(hashPortable('location', { name: 'Keep', status: '' })).toBe(
      hashPortable('location', { name: 'Keep', status: null }),
    );
  });

  it('drops quest-objective play state (`done`) from the publisher-owned payload', () => {
    const withDone = projectPortable('quest', { objectives: [{ text: 'Find it', sortOrder: 0, done: true }] });
    const without = projectPortable('quest', { objectives: [{ text: 'Find it', sortOrder: 0 }] });
    expect(withDone).toEqual(without);
  });
});

describe('three-way merge (issue #585)', () => {
  const base = { name: 'Old Keep', kind: 'fort', status: 'unexplored', body: 'A ruin.', dmSecret: '', mapX: null, mapY: null, parentKey: null };

  it('takes upstream for a field only the publisher changed', () => {
    const result = threeWayMerge('location', base, base, { ...base, body: 'A ruin, rebuilt.' });
    expect(result.merged.body).toBe('A ruin, rebuilt.');
    expect(result.conflictFields).toEqual([]);
  });

  it('keeps local for a field only the table changed', () => {
    const local = { ...base, dmSecret: 'the vault is behind the hearth' };
    const result = threeWayMerge('location', base, local, base);
    expect(result.merged.dmSecret).toBe('the vault is behind the hearth');
    expect(result.conflictFields).toEqual([]);
  });

  it('merges cleanly when both sides changed DIFFERENT fields', () => {
    const local = { ...base, status: 'explored' };
    const upstream = { ...base, body: 'A ruin, rebuilt.' };
    const result = threeWayMerge('location', base, local, upstream);
    expect(result.merged.status).toBe('explored');
    expect(result.merged.body).toBe('A ruin, rebuilt.');
    expect(result.conflictFields).toEqual([]);
  });

  it('flags a conflict only when both sides changed the SAME field to different values', () => {
    const local = { ...base, body: 'A ruin the party burned.' };
    const upstream = { ...base, body: 'A ruin, rebuilt.' };
    const result = threeWayMerge('location', base, local, upstream);
    expect(result.conflictFields).toEqual(['body']);
    // Default winner is the table — a publisher never silently overwrites local work.
    expect(result.merged.body).toBe('A ruin the party burned.');
    expect(threeWayMerge('location', base, local, upstream, 'upstream').merged.body).toBe('A ruin, rebuilt.');
  });

  it('treats convergence (both sides changed to the same value) as not a conflict', () => {
    const same = { ...base, body: 'Identical correction.' };
    const result = threeWayMerge('location', base, same, same);
    expect(result.conflictFields).toEqual([]);
    expect(result.merged.body).toBe('Identical correction.');
  });

  it('reports every moved field with all three legs for display', () => {
    const local = { ...base, status: 'explored' };
    const upstream = { ...base, body: 'New.' };
    const fields = threeWayMerge('location', base, local, upstream).fields;
    expect(fields.map((f) => f.field).sort()).toEqual(['body', 'status']);
    const bodyField = fields.find((f) => f.field === 'body');
    expect(bodyField).toMatchObject({ base: 'A ruin.', local: 'A ruin.', upstream: 'New.', conflict: false });
  });
});

describe('overlays (issue #585)', () => {
  const baseline = { name: 'Vex', role: 'fence', disposition: 'neutral', body: 'A fence.', dmSecret: '', iconSlug: '', hidden: false, locationKey: null, factionKey: null };

  it('captures only the diverging fields, and is null when nothing diverges', () => {
    expect(computeOverlay('npc', baseline, baseline)).toBeNull();
    const overlay = computeOverlay('npc', baseline, { ...baseline, dmSecret: 'informant' });
    expect(overlay).toEqual({ dmSecret: 'informant' });
  });

  it('round-trips: baseline + overlay reproduces the effective content exactly', () => {
    const current = { ...baseline, dmSecret: 'informant', role: 'double agent' };
    const overlay = computeOverlay('npc', baseline, current)!;
    expect(applyOverlay('npc', baseline, overlay)).toEqual(projectPortable('npc', current));
  });

  it('is expressed against the NEW baseline after an update, so drift does not accumulate', () => {
    // Publisher rewrites the body; the table keeps its own dmSecret.
    const upstream = { ...baseline, body: 'A fence with a new patron.' };
    const local = { ...baseline, dmSecret: 'informant' };
    const merged = threeWayMerge('npc', baseline, local, upstream).merged;
    const overlay = computeOverlay('npc', upstream, merged);
    // Only the local secret remains as divergence — the publisher's body edit was absorbed.
    expect(overlay).toEqual({ dmSecret: 'informant' });
  });
});
