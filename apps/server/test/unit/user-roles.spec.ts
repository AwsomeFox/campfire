import type { Role } from '@campfire/schema';
import {
  ROLE_RANK,
  roleAtLeast,
  minRole,
  auditActor,
  auditActorRole,
  hasServerAdminPower,
  type RequestUser,
  type TokenContext,
} from '../../src/common/user.types';

/**
 * Unit tests for role ranking, scope capping, and server-admin gating
 * (issue #79). `minRole` is the primitive behind a PAT's scope cap
 * (RoleResolver's min(scope, membership role) and the mint-time
 * min(requested, callingToken.scope)); `hasServerAdminPower` is the
 * privilege-escalation guard the token-cap e2e exercises end-to-end.
 */
const ROLES: Role[] = ['viewer', 'player', 'dm'];

function user(over: Partial<RequestUser> = {}): RequestUser {
  return { id: 'u1', name: 'Ada', serverRole: 'user', ...over };
}

function tokenCtx(over: Partial<TokenContext> = {}): TokenContext {
  return { tokenId: 1, name: 'agent', scope: 'viewer', writeScope: 'direct', campaignId: null, adminEnabled: false, ...over };
}

describe('roles — ranking', () => {
  it('ranks dm > player > viewer', () => {
    expect(ROLE_RANK.dm).toBeGreaterThan(ROLE_RANK.player);
    expect(ROLE_RANK.player).toBeGreaterThan(ROLE_RANK.viewer);
  });

  it.each<[Role, Role, boolean]>([
    ['dm', 'player', true],
    ['player', 'player', true],
    ['viewer', 'player', false],
    ['dm', 'viewer', true],
    ['viewer', 'dm', false],
  ])('roleAtLeast(%s, %s) === %s', (role, min, expected) => {
    expect(roleAtLeast(role, min)).toBe(expected);
  });
});

describe('roles — minRole (scope cap primitive)', () => {
  it('returns the lower of the two roles', () => {
    expect(minRole('dm', 'viewer')).toBe('viewer');
    expect(minRole('player', 'dm')).toBe('player');
    expect(minRole('dm', 'dm')).toBe('dm');
  });

  it('is commutative for every pair', () => {
    for (const a of ROLES) {
      for (const b of ROLES) {
        expect(minRole(a, b)).toBe(minRole(b, a));
      }
    }
  });

  it('a viewer scope caps any membership role down to viewer', () => {
    for (const membership of ROLES) {
      expect(minRole('viewer', membership)).toBe('viewer');
    }
  });

  it('never elevates: result is <= both inputs by rank', () => {
    for (const a of ROLES) {
      for (const b of ROLES) {
        const m = minRole(a, b);
        expect(ROLE_RANK[m]).toBeLessThanOrEqual(ROLE_RANK[a]);
        expect(ROLE_RANK[m]).toBeLessThanOrEqual(ROLE_RANK[b]);
      }
    }
  });
});

describe('roles — auditActor', () => {
  it('uses the user id for a cookie session', () => {
    expect(auditActor(user({ id: 'dev:ada' }))).toBe('dev:ada');
  });

  it('uses token:<name> when acting through a PAT', () => {
    expect(auditActor(user({ tokenContext: tokenCtx({ name: 'ci-bot' }) }))).toBe('token:ci-bot');
  });
});

describe('roles — hasServerAdminPower (privilege-escalation guard)', () => {
  it('a non-admin never has server-admin power', () => {
    expect(hasServerAdminPower(user({ serverRole: 'user' }))).toBe(false);
  });

  it('an admin on a cookie session (no token) has power', () => {
    expect(hasServerAdminPower(user({ serverRole: 'admin' }))).toBe(true);
  });

  it('an admin acting through a NON-admin-enabled token is capped to no power', () => {
    // This is the least-privilege PAT an operator hands an AI agent — it must
    // NOT silently carry the admin's server power.
    expect(
      hasServerAdminPower(user({ serverRole: 'admin', tokenContext: tokenCtx({ adminEnabled: false }) })),
    ).toBe(false);
  });

  it('an admin acting through an adminEnabled token keeps power', () => {
    expect(
      hasServerAdminPower(user({ serverRole: 'admin', tokenContext: tokenCtx({ adminEnabled: true }) })),
    ).toBe(true);
  });

  it('a token scope alone never grants server power to a non-admin', () => {
    expect(
      hasServerAdminPower(user({ serverRole: 'user', tokenContext: tokenCtx({ scope: 'dm', adminEnabled: true }) })),
    ).toBe(false);
  });
});

/**
 * Issue #526: auditActorRole maps a RequestUser to the audit-log actor role for
 * a SERVER-scoped admin action — 'admin' when the actor holds real server-admin
 * power (mirroring hasServerAdminPower), otherwise 'dm' (the honest attribution
 * for a caller that reached an admin route via a DM-equivalent path, e.g. a DM
 * installing a rule pack). A scope-capped PAT owned by an admin does NOT count.
 */
describe('roles — auditActorRole (issue #526 admin attribution)', () => {
  it('an admin on a cookie session attributes "admin"', () => {
    expect(auditActorRole(user({ serverRole: 'admin' }))).toBe('admin');
  });

  it('a non-admin attributes "dm" (campaign-DM equivalent on admin routes)', () => {
    expect(auditActorRole(user({ serverRole: 'user' }))).toBe('dm');
  });

  it('an admin acting through a NON-admin-enabled token attributes "dm" (power is capped)', () => {
    expect(
      auditActorRole(user({ serverRole: 'admin', tokenContext: tokenCtx({ adminEnabled: false }) })),
    ).toBe('dm');
  });

  it('an admin acting through an adminEnabled token attributes "admin"', () => {
    expect(
      auditActorRole(user({ serverRole: 'admin', tokenContext: tokenCtx({ adminEnabled: true }) })),
    ).toBe('admin');
  });
});
