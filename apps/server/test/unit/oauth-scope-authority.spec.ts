import { roleScopeFromScope, narrowRoleToScope } from '../../src/modules/oauth/oauth.service';

/**
 * Issue #680 — OAuth scopes must enforce authority instead of defaulting
 * independently to DM. The advertised `scope` (the thing the user sees and
 * consents to on the screen) is the single source of truth for the granted
 * role cap; the consent form may only narrow further, never widen.
 *
 * These unit tests pin the pure derivation helpers so the contract is
 * documented independently of the HTTP / MCP plumbing covered by the e2e spec.
 */
describe('OAuth scope -> authority derivation (#680)', () => {
  describe('roleScopeFromScope', () => {
    it('returns the explicit role when a single role scope is requested', () => {
      expect(roleScopeFromScope('viewer')).toBe('viewer');
      expect(roleScopeFromScope('player')).toBe('player');
      expect(roleScopeFromScope('dm')).toBe('dm');
    });

    it('ignores the non-authoritative "mcp" connector scope', () => {
      // 'mcp' grants MCP access, not campaign authority — on its own it must
      // never yield a write-capable token.
      expect(roleScopeFromScope('mcp')).toBe('viewer');
    });

    it('intersects multiple role scopes to the narrowest', () => {
      expect(roleScopeFromScope('dm viewer')).toBe('viewer');
      expect(roleScopeFromScope('player viewer')).toBe('viewer');
      expect(roleScopeFromScope('dm player')).toBe('player');
    });

    it('keeps the narrowest role when mcp is mixed in', () => {
      expect(roleScopeFromScope('mcp dm')).toBe('dm');
      expect(roleScopeFromScope('mcp viewer')).toBe('viewer');
      expect(roleScopeFromScope('mcp player dm')).toBe('player');
    });

    it('falls back to least-privilege viewer when no role scope is present', () => {
      expect(roleScopeFromScope(null)).toBe('viewer');
      expect(roleScopeFromScope(undefined)).toBe('viewer');
      expect(roleScopeFromScope('')).toBe('viewer');
      expect(roleScopeFromScope('   ')).toBe('viewer');
    });

    it('ignores unknown scope tokens', () => {
      expect(roleScopeFromScope('openid email')).toBe('viewer');
      expect(roleScopeFromScope('openid viewer')).toBe('viewer');
      expect(roleScopeFromScope('custom-scope dm')).toBe('dm');
    });

    it('handles whitespace-separated and multi-space inputs (RFC 6749 §3.3)', () => {
      expect(roleScopeFromScope('  viewer  ')).toBe('viewer');
      expect(roleScopeFromScope('viewer\tdm')).toBe('viewer');
      expect(roleScopeFromScope('dm  player')).toBe('player');
    });
  });

  describe('narrowRoleToScope', () => {
    it('returns the form role when it is at or below the requested scope', () => {
      expect(narrowRoleToScope('viewer', 'dm')).toBe('viewer');
      expect(narrowRoleToScope('player', 'dm')).toBe('player');
      expect(narrowRoleToScope('dm', 'dm')).toBe('dm');
    });

    it('caps the form role to the requested scope — the critical #680 fix', () => {
      // A request for scope=viewer with role=dm on the consent form MUST yield
      // a viewer-scoped token, never a DM one. Previously the form's role
      // selector defaulted to 'dm' and won, so the token REPORTED viewer while
      // carrying DM authority.
      expect(narrowRoleToScope('dm', 'viewer')).toBe('viewer');
      expect(narrowRoleToScope('dm', 'player')).toBe('player');
      expect(narrowRoleToScope('player', 'viewer')).toBe('viewer');
    });

    it('defaults to viewer when the form omits the role', () => {
      // The previous default was 'dm' — least privilege replaces it.
      expect(narrowRoleToScope(undefined, 'dm')).toBe('viewer');
      expect(narrowRoleToScope(undefined, 'viewer')).toBe('viewer');
      expect(narrowRoleToScope(undefined, undefined)).toBe('viewer');
    });

    it('treats mcp-only requests as viewer-capped (no implicit DM)', () => {
      expect(narrowRoleToScope('dm', 'mcp')).toBe('viewer');
      expect(narrowRoleToScope(undefined, 'mcp')).toBe('viewer');
    });

    it('narrows across mixed mcp + role scopes', () => {
      expect(narrowRoleToScope('dm', 'mcp player')).toBe('player');
      expect(narrowRoleToScope('viewer', 'mcp dm')).toBe('viewer');
    });
  });
});
