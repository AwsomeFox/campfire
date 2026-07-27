import { getTableColumns } from 'drizzle-orm';
import {
  CharterPreview,
  SessionZeroCharterVersion,
  SessionZeroGuardianConsentRequest,
} from '@campfire/schema';
import { BOOTSTRAP_SQL } from '../../src/db/bootstrap.sql';
import {
  sessionZeroAcknowledgments,
  sessionZeroBoundarySubmissions,
  sessionZeroCharterVersions,
  sessionZeroGuardianConsents,
} from '../../src/db/schema';

/**
 * Issue #600 — structural guarantees, asserted against the source of truth.
 *
 * The guardian requirement ("without exact birth dates") is the kind of promise that
 * decays into a comment. These tests read the live table definitions and the live DDL, so
 * the day somebody adds a `birth_date` column "just to compute the boolean properly", the
 * build stops.
 */
describe('#600 session-zero consent structure', () => {
  /** Anything that encodes when a person was born, however indirectly. */
  const AGE_IDENTIFIERS = [
    'birth',
    'birthdate',
    'birth_date',
    'birthday',
    'dob',
    'date_of_birth',
    'age',
    'birthyear',
    'birth_year',
    'yearofbirth',
  ];

  function mentionsAgeIdentifier(name: string): boolean {
    const normalized = name.toLowerCase().replace(/[^a-z]/g, '');
    return AGE_IDENTIFIERS.some((bad) => normalized.includes(bad.replace(/[^a-z]/g, '')));
  }

  describe('the guardian flow never collects a birth date', () => {
    it('has no age-encoding column on the guardian consent table', () => {
      const columns = Object.keys(getTableColumns(sessionZeroGuardianConsents));
      const offenders = columns.filter(mentionsAgeIdentifier);
      expect(offenders).toEqual([]);
      // …and the one thing it DOES record about age is a boolean attestation.
      expect(columns).toContain('minorAttested');
    });

    it('has no age-encoding column in the bootstrap DDL either', () => {
      // The drizzle table and the DDL are two separate declarations; a column could be
      // added to one without the other, so both are checked.
      const ddl = BOOTSTRAP_SQL.slice(
        BOOTSTRAP_SQL.indexOf('CREATE TABLE IF NOT EXISTS session_zero_guardian_consents'),
      );
      const body = ddl.slice(0, ddl.indexOf(');'));
      const columnNames = body
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+/)[0])
        .filter((name) => name && !name.startsWith('--') && name !== 'UNIQUE(campaign_id,');
      expect(columnNames.filter(mentionsAgeIdentifier)).toEqual([]);
      expect(body).toContain('minor_attested');
    });

    it('rejects a request that tries to supply one, rather than silently dropping it', () => {
      // The realistic failure: an integrator sends a birth date, gets a 201, and believes
      // the server stored and is honouring it. `.strict()` is what turns that into a 400.
      const base = {
        versionId: 1,
        guardianName: 'A. Guardian',
        guardianEmail: 'guardian@example.test',
        guardianRelationship: 'parent',
        minorAttested: true as const,
      };
      expect(SessionZeroGuardianConsentRequest.safeParse(base).success).toBe(true);

      for (const extra of [
        { birthDate: '2012-04-01' },
        { dateOfBirth: '2012-04-01' },
        { age: 13 },
        { birthYear: 2012 },
      ]) {
        const parsed = SessionZeroGuardianConsentRequest.safeParse({ ...base, ...extra });
        expect(parsed.success).toBe(false);
      }
    });

    it('requires the attestation to be an explicit true, not merely present', () => {
      const base = {
        versionId: 1,
        guardianName: 'A. Guardian',
        guardianEmail: 'guardian@example.test',
        minorAttested: false,
      };
      expect(SessionZeroGuardianConsentRequest.safeParse(base).success).toBe(false);
    });
  });

  describe('the pre-join preview is an enumerated projection', () => {
    it('carries the safety floor and nothing that identifies the table or its members', () => {
      expect(Object.keys(CharterPreview.shape).sort()).toEqual(
        [
          'aiExternalContentPolicy',
          'houseRules',
          'lines',
          'previewPolicy',
          'publishedAt',
          'safetyTools',
          'toneAndExpectations',
          'veils',
          'version',
        ].sort(),
      );
    });

    it('omits every field that would identify who is at the table or what they play', () => {
      const forbidden = [
        'members',
        'memberCount',
        'primaryDm',
        'description',
        'quests',
        'notes',
        'sessions',
        'boundarySubmissions',
        'acknowledgments',
        'campaignId',
      ];
      for (const field of forbidden) {
        expect(Object.keys(CharterPreview.shape)).not.toContain(field);
      }
    });
  });

  describe('immutability is visible in the shape', () => {
    it('a charter version has a publish stamp but no updatedAt', () => {
      // An `updatedAt` on a version row would be the first sign somebody had added an
      // edit path to a table whose whole purpose is that it cannot be edited.
      const keys = Object.keys(SessionZeroCharterVersion.shape);
      expect(keys).toContain('publishedAt');
      expect(keys).not.toContain('updatedAt');
    });

    it('acknowledgments and versions are separate tables joined by id', () => {
      // The bolted-on alternative — a version column on the mutable charter row — cannot
      // express "which version did this person agree to", so assert the indirection.
      expect(Object.keys(getTableColumns(sessionZeroAcknowledgments))).toContain('versionId');
      expect(Object.keys(getTableColumns(sessionZeroCharterVersions))).toContain('version');
    });

    it('private boundary submissions keep the submitter separable from the text', () => {
      const columns = Object.keys(getTableColumns(sessionZeroBoundarySubmissions));
      expect(columns).toEqual(expect.arrayContaining(['anonymous', 'submitterUserId', 'text']));
    });
  });
});
