import { getTableColumns } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { campaigns } from '../../src/db/schema';
import {
  CATALOG_CAMPAIGN_COLUMNS,
  CATALOG_CAMPAIGN_COLUMN_NAMES,
  CATALOG_PRIVACY_DEFAULTS,
  effectiveVisibility,
  redactedCampaignName,
  searchPredicate,
} from '../../src/modules/admin-catalog/catalog-projection';

/**
 * Issue #587 — the projection guard.
 *
 * The catalog's safety rests on an allowlist, and an allowlist is only as good as the
 * pressure to keep it honest. These are the tests that turn "we enumerated the columns"
 * from a comment into a build failure.
 */
describe('#587 catalog projection', () => {
  it('exposes exactly the enumerated campaign columns and nothing else', () => {
    // A literal, hand-written expectation on purpose: if someone adds a column to the
    // projection, this test must be edited in the same commit, which is precisely the
    // review moment the allowlist exists to create.
    expect([...CATALOG_CAMPAIGN_COLUMN_NAMES].sort()).toEqual(
      [
        'aiExternalContentPolicy',
        'catalogPrivacy',
        'createdAt',
        'deletedAt',
        'description',
        'id',
        'name',
        'publicInvitesEnabled',
        'ruleSystem',
        'sessionCount',
        'status',
        'storageQuotaBytes',
        'updatedAt',
      ].sort(),
    );
  });

  it('never projects a campaign column that carries a secret or points into content', () => {
    // The denylist is the belt to the allowlist's braces. It is written in terms of the
    // REAL table, so it keeps meaning something as `campaigns` grows.
    const forbidden = [
      'icsToken', // a live bearer capability for the campaign's calendar feed
      'icsTokenExpiresAt',
      'currentLocationId', // pointers into campaign content
      'activeEncounterId',
      'mapAttachmentId',
    ];
    for (const column of forbidden) {
      expect(CATALOG_CAMPAIGN_COLUMN_NAMES).not.toContain(column);
    }
  });

  it('leaves every unprojected campaign column accounted for, so a new one is a decision', () => {
    // This is the drift alarm: when someone adds a column to `campaigns`, this test
    // fails until they classify it — either into the projection above, or into the
    // known-excluded list here with a reason. Silence is not an option, which is the
    // whole point of design bullet 1.
    const knownExcluded = [
      'currentLocationId',
      'dangerLevel',
      'dmControlsProgression',
      'dmControlsTurns',
      'requireDmTurnConfirmation',
      'publicRecapSharingEnabled',
      'narrationLanguage',
      'mapAttachmentId',
      'icsToken',
      'icsTokenExpiresAt',
      'activeEncounterId',
      'latestSessionNumber', // denormalized session-position stat; not needed in the catalog
      // Additional content selection is campaign configuration, not operational metadata.
      // The catalog exposes the primary ruleSystem only; listing every enabled supplement
      // would disclose campaign content choices to an admin who is not a member.
      'enabledPackSlugs',
      // Homebrew mechanics profile (issue #1502): a 13-field combat-math blob the catalog has
      // no use for. `ruleSystem` — the slug it pairs with — is already projected, which is the
      // only part a catalog browser needs to know; the profile itself is read by the adapter
      // factory on the campaign's own paths.
      'customMechanicsProfile',
      // Homebrew condition definitions (issue #1505): campaign-custom condition rules blob
      // the catalog has no use for.
      'conditionDefinitions',
    ];
    const all = Object.keys(getTableColumns(campaigns));
    const unclassified = all.filter(
      (c) => !CATALOG_CAMPAIGN_COLUMN_NAMES.includes(c) && !knownExcluded.includes(c),
    );
    expect(unclassified).toEqual([]);
    // And the projection must only name columns that actually exist.
    expect(all).toEqual(expect.arrayContaining([...CATALOG_CAMPAIGN_COLUMN_NAMES]));
    expect(Object.keys(CATALOG_CAMPAIGN_COLUMNS)).toEqual([...CATALOG_CAMPAIGN_COLUMN_NAMES]);
  });

  describe('privacy is tighten-only', () => {
    it('lets a campaign override a permissive server default toward privacy', () => {
      const permissive = { names: 'visible', descriptions: 'visible' } as const;
      expect(effectiveVisibility(permissive, 'redacted')).toEqual({
        names: 'redacted',
        descriptions: 'redacted',
      });
    });

    it('never lets a campaign loosen a restrictive server default', () => {
      const restrictive = { names: 'redacted', descriptions: 'redacted' } as const;
      // `inherit` is the ONLY other campaign-level value; there is deliberately no
      // 'visible' opt-in, so this is exhaustive over the enum.
      expect(effectiveVisibility(restrictive, 'inherit')).toEqual({
        names: 'redacted',
        descriptions: 'redacted',
      });
    });

    it('defaults descriptions to redacted and names to visible', () => {
      expect(CATALOG_PRIVACY_DEFAULTS).toEqual({ names: 'visible', descriptions: 'redacted' });
    });
  });

  describe('the redacted-name placeholder', () => {
    it('is derived only from the id, so it discloses nothing the row does not already', () => {
      expect(redactedCampaignName(42)).toBe('Campaign #42');
    });

    it('is neither blank nor a hint at the withheld string', () => {
      const secret = 'Tuesday Trauma Processing Group';
      const placeholder = redactedCampaignName(7);
      expect(placeholder).not.toBe('');
      // No substring of the real name, no initialism, and no length signal.
      expect(placeholder.toLowerCase()).not.toContain('tuesday');
      expect(placeholder).not.toContain(String(secret.length));
      // Two campaigns are still distinguishable, which is what an operator needs to act.
      expect(redactedCampaignName(7)).not.toBe(redactedCampaignName(8));
    });
  });

  describe('search cannot become an oracle for a withheld name', () => {
    const visible = { names: 'visible', descriptions: 'visible' } as const;
    const namesHidden = { names: 'redacted', descriptions: 'visible' } as const;

    /** Compile the predicate to real SQL + bound params, exactly as the driver sees it. */
    function compile(policy: Parameters<typeof searchPredicate>[1], q?: string): { sql: string; params: unknown[] } {
      const predicate = searchPredicate(q, policy);
      if (!predicate) return { sql: '', params: [] };
      const query = new SQLiteSyncDialect().sqlToQuery(predicate);
      return { sql: query.sql, params: query.params };
    }

    it('is skipped entirely for an empty query', () => {
      expect(searchPredicate(undefined, visible)).toBeUndefined();
      expect(searchPredicate('   ', visible)).toBeUndefined();
    });

    it('does not reference the name column when names are server-redacted', () => {
      const { sql } = compile(namesHidden, 'trauma');
      expect(sql).not.toContain('"name"');
      // …and the row is still findable by the operational identifiers that are
      // disclosed anyway, so redaction narrows search rather than breaking it.
      expect(sql).toContain('"rule_system"');
    });

    it('still searches names when they are disclosed', () => {
      expect(compile(visible, 'trauma').sql).toContain('"name"');
    });

    it('only matches rows that have not individually opted out, even when names are visible', () => {
      // The per-campaign opt-out has to bind the search path too — otherwise an
      // operator recovers a redacted name by probing substrings and watching which
      // queries return the row.
      expect(compile(visible, 'trauma').sql).toContain("<> 'redacted'");
    });

    it('escapes LIKE wildcards so a query is literal, not a match-everything', () => {
      const { params } = compile(visible, '100%');
      expect(params).toContain('%100\\%%');
    });

    it('matches the id exactly for a numeric query', () => {
      const { params } = compile(visible, '412');
      expect(params).toContain(412);
    });

    it('is a self-contained group, so ANDed filters cannot be escaped by an OR branch', () => {
      // The predicate is combined with the trash/status filters via drizzle's `and()`,
      // which parenthesises the group it builds but not the individual operands. Since
      // AND binds tighter than OR, an unwrapped chain lets every branch after the first
      // escape those filters — a trashed campaign then shows up in an operator's search
      // and in the `total` beside it. Asserting the emitted shape here means the e2e
      // regression is not the only thing standing between this and a repeat.
      const { sql: emitted } = compile(visible, 'dnd5e');
      expect(emitted).toContain(' OR ');
      expect(emitted.startsWith('(')).toBe(true);
      expect(emitted.endsWith(')')).toBe(true);

      // …and that must be one real enclosing group, not merely a leading `(` from the
      // first branch plus a trailing `)` from the last. Walk the nesting depth: it may
      // only return to zero at the very end of the string.
      let depth = 0;
      let closedEarly = false;
      for (let i = 0; i < emitted.length; i += 1) {
        if (emitted[i] === '(') depth += 1;
        else if (emitted[i] === ')') {
          depth -= 1;
          if (depth === 0 && i < emitted.length - 1) closedEarly = true;
        }
      }
      expect(closedEarly).toBe(false);
      expect(depth).toBe(0);
    });
  });
});
