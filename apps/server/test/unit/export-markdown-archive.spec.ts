import JSZip from 'jszip';
import {
  archiveDisplayStem,
  archiveRecordFilename,
  ARCHIVE_STEM_MAX_BYTES,
  buildMarkdownArchiveManifest,
  MACHINE_EXPORT_MODULES,
  MARKDOWN_ARCHIVE_FORMAT_VERSION,
  MARKDOWN_ARCHIVE_KIND,
  MARKDOWN_ARCHIVE_SECRECY_PROFILE,
  sha256Hex,
} from '../../src/modules/export/markdown-archive';
import { ExportService } from '../../src/modules/export/export.service';
import type { RequestUser } from '../../src/common/user.types';

/**
 * Regression tests for markdown-archive collision handling + verifiability
 * (issue #863). Paths must be collision-proof via stable record ids, preserve
 * Unicode display stems, and ship a versioned archive-manifest.json that covers
 * every machine-export module.
 */

function campaignRow() {
  return {
    id: 1,
    name: 'Test Campaign',
    description: 'A campaign.',
    status: 'active',
    dangerLevel: 'medium',
    sessionCount: 0,
    latestSessionNumber: 0,
    mapAttachmentId: null,
  };
}

function buildService(entities: {
  quests?: any[];
  npcs?: any[];
  locations?: any[];
  sessions?: any[];
  characters?: any[];
  encounters?: any[];
  factions?: any[];
  notes?: any[];
  comments?: any[];
  attachments?: any[];
  auditEntries?: any[];
  auditTruncated?: number;
  scheduledSessions?: any[];
}): ExportService {
  const noop = async () => [];
  const auditEntries = entities.auditEntries ?? [];
  const auditTruncated = entities.auditTruncated ?? 0;
  const campaign = campaignRow();
  const emptyWhereResult = (selection?: any) => {
    const rows = selection && typeof selection === 'object' && 'count' in selection ? [{ count: 0 }] : [];
    return Object.assign(Promise.resolve(rows), {
      limit: async () => [],
      orderBy: () => Object.assign(Promise.resolve([]), { limit: async () => [] }),
    });
  };
  const emptyDbQuery = (selection?: any) => ({
    from: () => ({ where: () => emptyWhereResult(selection) }),
  });
  return new ExportService(
    { select: (selection?: any) => emptyDbQuery(selection) } as any, // db (AI seat + scribe reads)
    { getOrThrow: async () => campaign } as any,
    { listForCampaignWithObjectives: async () => entities.quests ?? [] } as any,
    { listForCampaign: async () => entities.npcs ?? [] } as any,
    { listForCampaign: async () => entities.locations ?? [] } as any,
    { listRecapsForCampaign: async () => entities.sessions ?? [], listAttendanceForCampaign: async () => [] } as any,
    // scheduling — the archive reads listForExport, deliberately the RAW rows (#504);
    // exposing only that method keeps the stub honest if the call site ever changes back.
    { listForExport: async () => entities.scheduledSessions ?? [] } as any,
    // characters — #1667: the archive reads listForExport, which also resolves
    // conditionInstances (not on the public Character schema); exposing only that
    // method keeps the stub honest if the call site ever changes back.
    { listForExport: async () => entities.characters ?? [] } as any,
    // Pagination (#608): export walks the full set via listAllForCampaign.
    { listAllForCampaign: async () => entities.notes ?? [] } as any,
    { listForCampaign: async () => entities.comments ?? [] } as any,
    { listForCampaign: noop as any } as any, // members
    {
      listForCampaign: noop as any,
      listForCampaignExport: async () => ({
        entries: auditEntries,
        meta: {
          total: auditEntries.length + auditTruncated,
          exported: auditEntries.length,
          truncated: auditTruncated,
          cutoff: { snapshotMaxId: 1000, capturedAt: new Date(0).toISOString(), oldestExportedCreatedAt: null },
        },
      }),
      finalizeCampaignExportMeta: async (_campaignId: number, meta: unknown) => meta,
    } as any, // audit
    { listForCampaign: noop as any } as any, // proposals
    {
      listForCampaign: async () => (entities.encounters ?? []).map((e: any) => ({ id: e.id, name: e.name })),
      getWithCombatantsOrThrow: async (id: number) => (entities.encounters ?? []).find((e: any) => e.id === id),
      listEvents: async () => [],
      listEventsForEncounters: async () => new Map(),
    } as any,
    {
      listRowsForCampaign: async () => entities.attachments ?? [],
      hasBytesOnDisk: () => false,
      readBytesIfPresent: () => null,
    } as any,
    { listForCampaign: async () => entities.factions ?? [] } as any,
    { listArcsWithBeats: noop as any } as any,
    { listEvents: noop as any, getCalendar: async () => null } as any,
    { get: async () => null } as any,
    { getOwn: async () => null } as any,
    { listForCampaign: noop as any, getTreasury: async () => null } as any, // inventory
    { listForCampaign: noop as any } as any, // revisions
    { listForCampaign: noop as any } as any, // rolls
    { listForCampaign: noop as any } as any, // library
  );
}

const USER: RequestUser = { id: 'user-1', name: 'Tester', role: 'dm' } as any;

describe('archiveDisplayStem / archiveRecordFilename (issue #863)', () => {
  it('preserves CJK, Arabic, emoji, and mixed case', () => {
    expect(archiveDisplayStem('東京')).toBe('東京');
    expect(archiveDisplayStem('القاهرة')).toBe('القاهرة');
    expect(archiveDisplayStem('Dragon 🐉')).toBe('Dragon 🐉');
    expect(archiveDisplayStem('Bob')).toBe('Bob');
    expect(archiveDisplayStem('bob')).toBe('bob');
  });

  it('sanitizes path separators; keeps punctuation-only stems, falls back only when sanitized result is empty', () => {
    expect(archiveDisplayStem('a/b\\c:d')).toBe('a-b-c-d');
    // Punctuation-only stems that survive sanitization are KEPT (ids still disambiguate).
    expect(archiveDisplayStem('!!!')).toBe('!!!');
    // `?` is Windows-forbidden → stripped to empty → fallback to untitled.
    expect(archiveDisplayStem('???')).toBe('untitled');
    expect(archiveDisplayStem('')).toBe('untitled');
    expect(archiveDisplayStem('   ')).toBe('untitled');
  });

  it('truncates long multibyte stems to a UTF-8 byte budget so filenames stay extractable', () => {
    const longEmoji = '🐉'.repeat(200); // 200 code points, 800 UTF-8 bytes
    const stem = archiveDisplayStem(longEmoji);
    // Must stay within the byte budget that reserves room for the `__{type}-{id}.md` suffix.
    expect(Buffer.byteLength(stem, 'utf8')).toBeLessThanOrEqual(ARCHIVE_STEM_MAX_BYTES);
    // Never splits a multi-byte code point (every char is a whole dragon).
    expect([...stem].every((cp) => cp === '🐉')).toBe(true);
    // The full record filename (stem + suffix) stays under the 255-byte component limit.
    expect(Buffer.byteLength(archiveRecordFilename('npc', 2147483647, longEmoji), 'utf8')).toBeLessThanOrEqual(255);

    const longCjk = '東'.repeat(200); // 3 bytes each
    expect(Buffer.byteLength(archiveDisplayStem(longCjk), 'utf8')).toBeLessThanOrEqual(ARCHIVE_STEM_MAX_BYTES);
  });

  it('embeds stable typed ids so duplicate stems never collide', () => {
    expect(archiveRecordFilename('npc', 1, 'Bob')).toBe('Bob__npc-1.md');
    expect(archiveRecordFilename('npc', 2, 'Bob')).toBe('Bob__npc-2.md');
    expect(archiveRecordFilename('npc', 3, 'bob')).toBe('bob__npc-3.md');
    expect(archiveRecordFilename('npc', 4, '!!!')).toBe('!!!__npc-4.md');
    expect(archiveRecordFilename('location', 9, '東京')).toBe('東京__location-9.md');
  });
});

describe('buildMarkdownArchiveManifest coverage', () => {
  it('requires every machine-export module to be represented or excluded', () => {
    const modules = Object.fromEntries(
      MACHINE_EXPORT_MODULES.map((k) => [k, { kind: 'excluded' as const, reason: 'test' }]),
    );
    const manifest = buildMarkdownArchiveManifest({
      campaignId: 1,
      counts: {},
      campaignJson: '{}',
      fileChecksums: {},
      modules,
      records: [],
    });
    expect(manifest.kind).toBe(MARKDOWN_ARCHIVE_KIND);
    expect(manifest.formatVersion).toBe(MARKDOWN_ARCHIVE_FORMAT_VERSION);
    expect(manifest.secrecyProfile).toBe(MARKDOWN_ARCHIVE_SECRECY_PROFILE);
    expect(manifest.checksums.campaignJson).toBe(sha256Hex('{}'));
    for (const key of MACHINE_EXPORT_MODULES) {
      expect(manifest.modules[key]).toBeDefined();
    }
  });

  it('throws when a machine-export module is missing from the modules map', () => {
    expect(() =>
      buildMarkdownArchiveManifest({
        campaignId: 1,
        counts: {},
        campaignJson: '{}',
        fileChecksums: {},
        modules: { campaign: { kind: 'markdown-file', path: 'campaign.md' } },
        records: [],
      }),
    ).toThrow(/missing module representation/);
  });
});

describe('buildMarkdownZip — collisions + Unicode + determinism (issue #863)', () => {
  function unicodeCollisionService(): ExportService {
    return buildService({
      npcs: [
        { id: 1, name: 'Bob', role: 'a', disposition: 'friendly', body: 'latin-1', dmSecret: null, locationId: null, factionId: null },
        { id: 2, name: 'bob', role: 'b', disposition: 'neutral', body: 'latin-2', dmSecret: null, locationId: null, factionId: null },
        { id: 3, name: 'BOB', role: 'c', disposition: 'hostile', body: 'latin-3', dmSecret: null, locationId: null, factionId: null },
        { id: 4, name: '東京', role: 'd', disposition: 'neutral', body: 'cjk', dmSecret: null, locationId: null, factionId: null },
        { id: 5, name: 'القاهرة', role: 'e', disposition: 'neutral', body: 'arabic', dmSecret: null, locationId: null, factionId: null },
        { id: 6, name: '!!!', role: 'f', disposition: 'neutral', body: 'punct', dmSecret: null, locationId: null, factionId: null },
        { id: 7, name: '???', role: 'g', disposition: 'neutral', body: 'punct-2', dmSecret: null, locationId: null, factionId: null },
        { id: 8, name: 'Dragon 🐉', role: 'h', disposition: 'neutral', body: 'emoji', dmSecret: null, locationId: null, factionId: null },
      ],
      quests: [
        { id: 10, title: 'Lost Mine', status: 'active', reward: '', body: 'q1', objectives: [], dmSecret: null, parentId: null },
        { id: 11, title: 'Lost Mine', status: 'active', reward: '', body: 'q2', objectives: [], dmSecret: null, parentId: null },
      ],
      encounters: [
        {
          id: 20,
          name: 'Ambush',
          status: 'active',
          round: 1,
          locationId: null,
          questId: null,
          sessionId: null,
          mapAttachmentId: 99,
          gridType: 'square',
          gridSize: 5,
          gridScale: 5,
          gridUnit: 'ft',
          gridSnap: true,
          fog: { enabled: true, revealed: [{ x: 0, y: 0, w: 10, h: 10 }] },
          combatants: [
            {
              id: 1,
              name: 'Troll',
              kind: 'monster',
              initiative: 12,
              hpCurrent: 40,
              hpMax: 40,
              conditions: [],
              tokenX: 10,
              tokenY: 20,
              tokenSize: 'med',
              characterId: null,
              npcId: null,
            },
          ],
        },
      ],
      characters: [
        {
          id: 30,
          name: 'Hero',
          species: 'human',
          className: 'fighter',
          level: 1,
          xp: 0,
          hpCurrent: 10,
          hpMax: 10,
          ac: 16,
          notes: 'n',
          dmSecret: null,
          portraitUrl: '/api/v1/attachments/55/file',
          actions: [{ name: 'Longsword', kind: 'melee', toHit: '+5', damage: '1d8+3', notes: '' }],
          spellSlots: { '1': { max: 2, used: 1 } },
        },
      ],
      attachments: [
        {
          id: 55,
          kind: 'portrait',
          filename: 'hero.png',
          mime: 'image/png',
          size: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 99,
          kind: 'map',
          filename: 'battle.png',
          mime: 'image/png',
          size: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
  }

  it('writes one distinct id-suffixed file per entity (no silent overwrite)', async () => {
    const service = unicodeCollisionService();
    const { buffer } = await service.buildMarkdownZip(1, USER);
    const zip = await JSZip.loadAsync(buffer);
    const npcFiles = Object.keys(zip.files)
      .filter((n) => n.startsWith('npcs/') && n.endsWith('.md'))
      .sort();
    // `???` sanitizes to path-unsafe `?` → empty stem → `untitled`; id still
    // keeps it distinct from every other record.
    expect(npcFiles).toEqual([
      'npcs/!!!__npc-6.md',
      'npcs/BOB__npc-3.md',
      'npcs/Bob__npc-1.md',
      'npcs/Dragon 🐉__npc-8.md',
      'npcs/bob__npc-2.md',
      'npcs/untitled__npc-7.md',
      'npcs/القاهرة__npc-5.md',
      'npcs/東京__npc-4.md',
    ].sort());

    // Contents are not collapsed — each body is present.
    expect(await zip.file('npcs/Bob__npc-1.md')!.async('string')).toContain('latin-1');
    expect(await zip.file('npcs/bob__npc-2.md')!.async('string')).toContain('latin-2');
    expect(await zip.file('npcs/BOB__npc-3.md')!.async('string')).toContain('latin-3');
    expect(await zip.file('npcs/東京__npc-4.md')!.async('string')).toContain('cjk');
  });

  it('is deterministic across export runs (stable id paths + sorted records)', async () => {
    const service = unicodeCollisionService();
    const a = await service.buildMarkdownZip(1, USER);
    const b = await service.buildMarkdownZip(1, USER);
    const zipA = await JSZip.loadAsync(a.buffer);
    const zipB = await JSZip.loadAsync(b.buffer);
    const namesA = Object.keys(zipA.files).filter((n) => n.endsWith('.md')).sort();
    const namesB = Object.keys(zipB.files).filter((n) => n.endsWith('.md')).sort();
    expect(namesA).toEqual(namesB);

    const manifestA = JSON.parse(await zipA.file('archive-manifest.json')!.async('string'));
    const manifestB = JSON.parse(await zipB.file('archive-manifest.json')!.async('string'));
    expect(manifestA.checksums.campaignJson).toBe(manifestB.checksums.campaignJson);
    expect(manifestA.records.map((r: { path: string }) => r.path)).toEqual(
      manifestB.records.map((r: { path: string }) => r.path),
    );
  });

  it('embeds a versioned archive-manifest covering every machine-export module', async () => {
    const service = unicodeCollisionService();
    const { buffer } = await service.buildMarkdownZip(1, USER);
    const zip = await JSZip.loadAsync(buffer);
    const manifest = JSON.parse(await zip.file('archive-manifest.json')!.async('string'));

    expect(manifest.app).toBe('campfire');
    expect(manifest.kind).toBe(MARKDOWN_ARCHIVE_KIND);
    expect(manifest.formatVersion).toBe(MARKDOWN_ARCHIVE_FORMAT_VERSION);
    expect(manifest.secrecyProfile).toBe(MARKDOWN_ARCHIVE_SECRECY_PROFILE);
    expect(typeof manifest.appVersion).toBe('string');
    expect(typeof manifest.schemaVersion).toBe('number');
    expect(manifest.checksums.campaignJson).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.exclusions.some((e: { module: string }) => e.module === 'participantSupportNote')).toBe(true);
    // This fixture's audit snapshot dropped no rows (auditMeta.truncated === 0), so the
    // manifest must NOT claim an audit truncation (the note is conditional, not unconditional).
    expect(manifest.truncations.some((t: { module: string }) => t.module === 'audit')).toBe(false);

    for (const key of MACHINE_EXPORT_MODULES) {
      expect(manifest.modules[key]).toBeDefined();
      const rep = manifest.modules[key];
      expect(['markdown-file', 'markdown-folder', 'embedded', 'excluded']).toContain(rep.kind);
    }

    // Coverage independent of the MACHINE_EXPORT_MODULES constant: every key actually
    // returned by buildExport must have a manifest representation, so a newly-exported
    // field can't silently escape the archive (issue #863).
    const exported = await service.buildExport(1, USER);
    for (const key of Object.keys(exported)) {
      expect(manifest.modules[key]).toBeDefined();
    }

    // Record checksums match file contents.
    const bob = manifest.records.find((r: { path: string }) => r.path === 'npcs/Bob__npc-1.md');
    expect(bob).toBeDefined();
    const body = await zip.file('npcs/Bob__npc-1.md')!.async('string');
    expect(bob.checksum).toBe(sha256Hex(body));
  });

  it('records an audit truncation only when auditMeta.truncated > 0', async () => {
    const service = buildService({
      npcs: [{ id: 1, name: 'Bob' }],
      auditEntries: [{ createdAt: 't', action: 'create', entityType: 'npc', entityId: 1, actor: 'dm', detail: '' }],
      auditTruncated: 3,
    });
    const { buffer } = await service.buildMarkdownZip(1, USER);
    const zip = await JSZip.loadAsync(buffer);
    const manifest = JSON.parse(await zip.file('archive-manifest.json')!.async('string'));

    const auditTruncation = manifest.truncations.find((t: { module: string }) => t.module === 'audit');
    expect(auditTruncation).toBeDefined();
    expect(auditTruncation.note).toContain('3 audit row(s)');
    // audit.md surfaces the truncation for a human reader too.
    const auditMd = await zip.file('audit.md')!.async('string');
    expect(auditMd).toContain('3 older/concurrent row(s) are omitted');
  });

  it('escapes pipe/newline in free-text table cells so the manifest table stays intact', async () => {
    const service = buildService({
      npcs: [{ id: 1, name: 'Bob' }],
      attachments: [
        { id: 5, kind: 'image', filename: 'evil|name\nsecond', file: 'uploads/5.png', fileRoute: '/api/v1/attachments/5/file', present: false, mime: 'image/png' },
      ],
    });
    const { buffer } = await service.buildMarkdownZip(1, USER);
    const zip = await JSZip.loadAsync(buffer);
    const attachmentsMd = await zip.file('attachments.md')!.async('string');
    const row = attachmentsMd.split('\n').find((l) => l.startsWith('| 5 |'))!;
    expect(row).toBeDefined();
    // The literal pipe is escaped and the newline collapsed, so the row keeps
    // its 8 columns (ID/Kind/Title/Filename/License/Source/File/Referenced by).
    expect(row).toContain('evil\\|name second');
    expect(row.split(' | ').length).toBe(8);
  });

  it('embeds campaign-portable scheduled-session rows in campaign.json, completed status and all (#504/#1548)', async () => {
    // The archive reads SchedulingService.listForExport, NOT the link-reconciled read
    // every API projection uses: a recap that merely happens to be in the Trash at
    // export time must not permanently downgrade a completed night to 'scheduled' in
    // the portable copy. (The read-vs-export divergence itself is pinned end-to-end by
    // "exports the RAW schedule row even while its linked recap is trashed" in
    // schedule.e2e-spec.ts, against the real service; this pins that the archive writer
    // preserves the campaign-local fields rather than re-deriving anything.)
    const service = buildService({
      npcs: [{ id: 1, name: 'Bob' }],
      scheduledSessions: [
        {
          id: 7,
          campaignId: 1,
          scheduledAt: '2099-01-02T18:00:00.000Z',
          durationMinutes: 240,
          title: 'Played, recap trashed',
          location: '',
          notes: '',
          status: 'completed',
          cancelledAt: null,
          cancelledBy: null,
          cancellationReason: '',
          sessionId: 42,
          assignedDmUserId: 'dev:op-dm',
          roomId: 99,
          capacity: 6,
          createdAt: '2098-01-01T00:00:00.000Z',
          updatedAt: '2098-01-01T00:00:00.000Z',
          rsvps: [],
        },
      ],
    });
    const { buffer } = await service.buildMarkdownZip(1, USER);
    const zip = await JSZip.loadAsync(buffer);
    const campaignJson = JSON.parse(await zip.file('campaign.json')!.async('string'));
    expect(campaignJson.scheduledSessions).toEqual([
      expect.objectContaining({ id: 7, status: 'completed', sessionId: 42 }),
    ]);
    expect(campaignJson.scheduledSessions[0]).not.toHaveProperty('assignedDmUserId');
    expect(campaignJson.scheduledSessions[0]).not.toHaveProperty('roomId');
    expect(campaignJson.scheduledSessions[0]).not.toHaveProperty('capacity');

    const manifest = JSON.parse(await zip.file('archive-manifest.json')!.async('string'));
    expect(manifest.counts.scheduledSessions).toBe(1);
  });

  it('projects scheduled-session rows without reparsing stored values (#1548)', async () => {
    const legacyRsvp = {
      id: 'legacy-rsvp-id',
      scheduledSessionId: 7,
      userId: 123,
      userName: null,
      status: 'legacy-imported-status',
      note: 99,
    };
    const service = buildService({
      scheduledSessions: [
        {
          id: 7,
          campaignId: 1,
          scheduledAt: 'legacy-imported-instant',
          durationMinutes: 'all-day',
          title: 'Legacy imported night',
          location: '',
          notes: '',
          status: 'scheduled',
          cancelledAt: null,
          cancelledBy: null,
          cancellationReason: '',
          sessionId: null,
          createdAt: 'legacy-created-at',
          updatedAt: 'legacy-updated-at',
          seriesId: 'series-1',
          occurrenceIndex: 'first',
          venueId: 'venue-1',
          roomId: 'room-1',
          assignedDmUserId: 'dev:op-dm',
          capacity: 'six',
          eventId: 'event-1',
          seasonId: 'season-1',
          icsUid: 123,
          icsSequence: 'bad-sequence',
          originalScheduledAt: 'not-nullable-iso',
          rsvps: [legacyRsvp],
        },
      ],
    });

    const data = await service.buildExport(1, USER);
    const [scheduled] = data.scheduledSessions as Array<Record<string, unknown>>;
    expect(scheduled).toEqual(
      expect.objectContaining({
        id: 7,
        scheduledAt: 'legacy-imported-instant',
        durationMinutes: 'all-day',
        rsvps: [legacyRsvp],
      }),
    );
    for (const key of [
      'seriesId',
      'occurrenceIndex',
      'venueId',
      'roomId',
      'assignedDmUserId',
      'capacity',
      'eventId',
      'seasonId',
      'icsUid',
      'icsSequence',
      'originalScheduledAt',
    ]) {
      expect(scheduled).not.toHaveProperty(key);
    }
  });

  it('includes typed ids, relationships, actions, and map/grid/fog/token snapshots', async () => {
    const service = unicodeCollisionService();
    const { buffer } = await service.buildMarkdownZip(1, USER);
    const zip = await JSZip.loadAsync(buffer);

    const npc = await zip.file('npcs/Bob__npc-1.md')!.async('string');
    expect(npc).toContain('Typed ID: `npc:1`');
    expect(npc).toContain('campfire:type=npc id=1');

    const character = await zip.file('characters/Hero__character-30.md')!.async('string');
    expect(character).toContain('## Actions / Resources');
    expect(character).toContain('Longsword');
    expect(character).toContain('## Spell slots');

    const encounter = await zip.file('encounters/Ambush__encounter-20.md')!.async('string');
    expect(encounter).toContain('Map attachment: `attachment:99`');
    expect(encounter).toContain('## Grid');
    expect(encounter).toContain('## Fog');
    expect(encounter).toContain('"enabled": true');
    expect(encounter).toContain('10,20');
    expect(encounter).toContain('## Combat log');
  });

  it('builds attachment references from campaign map, portraits, and encounter maps', async () => {
    const service = unicodeCollisionService();
    // Point campaign map at attachment 99 as well.
    (service as any).campaigns.getOrThrow = async () => ({ ...campaignRow(), mapAttachmentId: 99 });
    const { buffer } = await service.buildMarkdownZip(1, USER);
    const zip = await JSZip.loadAsync(buffer);
    const attachmentsMd = await zip.file('attachments.md')!.async('string');
    expect(attachmentsMd).toContain('campaign map');
    expect(attachmentsMd).toContain('portrait: Hero');
    expect(attachmentsMd).toContain('encounter map: Ambush');
  });

  it('warns on shared display stems without losing either file', async () => {
    const service = unicodeCollisionService();
    const { buffer, warnings } = await service.buildMarkdownZip(1, USER);
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file('quests/Lost Mine__quest-10.md')).not.toBeNull();
    expect(zip.file('quests/Lost Mine__quest-11.md')).not.toBeNull();
    const questWarning = warnings.find((w) => w.includes('quest'));
    expect(questWarning).toContain("shared the display stem 'Lost Mine'");
    expect(questWarning).toContain('Lost Mine__quest-10.md');
    expect(questWarning).toContain('Lost Mine__quest-11.md');
  });
});
