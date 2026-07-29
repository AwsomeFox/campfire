/**
 * Issue #586 — unit coverage for the redaction primitives that the canary e2e suite
 * exercises end to end: the profile policy table, the allowlist projection, the
 * per-export pseudonymizer, the free-text identifier sweep, and the image metadata
 * stripper. These run without booting the app so a regression here fails in seconds.
 */
import { deflateSync } from 'node:zlib';
import {
  EXPORT_PROFILES,
  ExportPseudonymizer,
  MIN_SCANNABLE_IDENTIFIER,
  PUBLISHABLE_FIELDS,
  DM_SECRET_FIELDS,
  PLAYED_STATE_FIELDS,
  partitionIdentifiers,
  redactIdentifiers,
  resolveExportPolicy,
  isExportProfile,
  exportLimitations,
} from '../../src/modules/export/export-profiles';
import { projectExport, collectPrivateIdentifiers } from '../../src/modules/export/export-redaction';
import { SANITIZABLE_MIMES, stripImageMetadata } from '../../src/modules/export/image-metadata';

describe('export profile policy table (#586)', () => {
  it('exposes exactly three profiles and validates unknown ones', () => {
    expect([...EXPORT_PROFILES]).toEqual(['backup', 'handoff', 'publish']);
    expect(isExportProfile('publish')).toBe(true);
    expect(isExportProfile('everything')).toBe(false);
  });

  it('backup redacts nothing and is not projected through the allowlist', () => {
    const p = resolveExportPolicy('backup');
    expect(p.memberIdentities).toBe(true);
    expect(p.audit).toBe(true);
    expect(p.privateNotes).toBe(true);
    expect(p.allowlistProjection).toBe(false);
    expect(p.pseudonymizeAuthors).toBe(false);
    expect(exportLimitations(p)[0]).toMatch(/no redaction at all/i);
  });

  it('handoff keeps secrets + play state, drops identity and operational history', () => {
    const p = resolveExportPolicy('handoff');
    expect(p.dmSecrets).toBe(true);
    expect(p.playedState).toBe(true);
    expect(p.playerContent).toBe(true);
    expect(p.memberIdentities).toBe(false);
    expect(p.audit).toBe(false);
    expect(p.proposals).toBe(false);
    expect(p.operationalHistory).toBe(false);
    expect(p.privateNotes).toBe(false);
    expect(p.credentials).toBe(false);
    expect(p.pseudonymizeAuthors).toBe(true);
  });

  it('publish defaults everything optional to OFF', () => {
    const p = resolveExportPolicy('publish');
    for (const key of [
      'memberIdentities', 'audit', 'proposals', 'operationalHistory',
      'privateNotes', 'playerContent', 'playedState', 'dmSecrets', 'credentials',
    ] as const) {
      expect(`${key}=${p[key]}`).toBe(`${key}=false`);
    }
    expect(p.requireSanitizedAttachments).toBe(true);
    expect(p.neutralizeAttachmentFilenames).toBe(true);
  });

  it('opt-ins widen ONLY publish and only the three reviewed switches', () => {
    const widened = resolveExportPolicy('publish', {
      includeDmSecrets: true,
      includePlayedState: true,
      includePlayerContent: true,
    });
    expect(widened.dmSecrets).toBe(true);
    expect(widened.playedState).toBe(true);
    expect(widened.playerContent).toBe(true);
    // Not reachable from the options — identity/audit stay off no matter what.
    expect(widened.memberIdentities).toBe(false);
    expect(widened.audit).toBe(false);
    expect(widened.operationalHistory).toBe(false);

    // Options cannot narrow a fixed profile.
    const handoff = resolveExportPolicy('handoff', { includeDmSecrets: false, includePlayerContent: false });
    expect(handoff.dmSecrets).toBe(true);
    expect(handoff.playerContent).toBe(true);
  });

  it('no allowlist carries an identity-shaped column', () => {
    // `tokenX/tokenY/tokenSize` are battle-map coordinates, not credentials — name the
    // credential-ish columns explicitly rather than matching the substring 'token'.
    const identityish = /(userId|username|displayName|authorName|proposer|roller|uploader|deletedBy|editedBy|resolvedBy|cancelledBy|createdBy|tokenHash|icsToken|passwordHash)/i;
    for (const [entity, fields] of Object.entries(PUBLISHABLE_FIELDS)) {
      for (const field of fields as readonly string[]) {
        expect(`${entity}.${field}`).not.toMatch(identityish);
      }
    }
    for (const table of [DM_SECRET_FIELDS, PLAYED_STATE_FIELDS]) {
      for (const [entity, fields] of Object.entries(table)) {
        for (const field of fields as readonly string[]) {
          expect(`${entity}.${field}`).not.toMatch(identityish);
        }
      }
    }
  });
});

describe('allowlist projection (#586)', () => {
  /** A raw payload shaped like buildExport's output, with a column nobody allowlisted. */
  function rawPayload() {
    return {
      campaign: { id: 1, name: 'Deep Halls', description: 'x', status: 'active', dangerLevel: 'low', sessionCount: 4, icsToken: 'cf_ics_secret', storageQuotaBytes: 99, futureColumn: 'LEAK' },
      quests: [{ id: 1, campaignId: 1, title: 'Q', body: 'b', status: 'completed', dmSecret: 'S', hidden: true, objectives: [{ id: 1, questId: 1, text: 'o', done: true, sortOrder: 0 }], futureColumn: 'LEAK' }],
      npcs: [], locations: [], factions: [], timelineEvents: [], storyArcs: [], encounters: [],
      sessions: [{ id: 1, campaignId: 1, number: 1, title: 'One', recap: 'R', playedAt: '2026-01-01', dmSecret: 'S' }],
      characters: [{ id: 1, campaignId: 1, name: 'Hero', ownerUserId: '42', hpMax: 20, hpCurrent: 3, xp: 900, level: 3 }],
      notes: [
        { id: 1, campaignId: 1, visibility: 'private', body: 'mine', authorUserId: '42', authorName: 'Ada Lovelace' },
        { id: 2, campaignId: 1, visibility: 'whisper', body: 'psst', authorUserId: '42', authorName: 'Ada Lovelace', recipientUserId: '43' },
        { id: 3, campaignId: 1, visibility: 'party_shared', body: 'shared', authorUserId: '42', authorName: 'Ada Lovelace' },
        { id: 4, campaignId: 1, visibility: 'dm_shared', body: 'prep', authorUserId: '42', authorName: 'Ada Lovelace' },
      ],
      comments: [], members: [{ id: 1, campaignId: 1, userId: 42, username: 'ada', displayName: 'Ada Lovelace', role: 'dm' }],
      audit: [{ id: 1, actor: 'ada', action: 'x', detail: 'd' }],
      auditMeta: { total: 1, exported: 1, truncated: 0, cutoff: { snapshotMaxId: 1, capturedAt: 'now' } },
      auditNote: 'note', proposals: [{ id: 1, proposer: 'Ada Lovelace', proposerUserId: '42', payload: {} }],
      compendiumDependencies: [], compendiumNote: 'c',
      timelineCalendar: { campaignId: 1, currentDate: 'Day 40', note: 'n' },
      sessionZero: { campaignId: 1, lines: ['no spiders'], veils: [], safetyTools: [], houseRules: 'H', toneAndExpectations: 'T' },
      inventory: [{ id: 1, campaignId: 1, name: 'Rope', qty: 1, deletedAt: null }],
      treasury: { campaignId: 1, cp: 1, sp: 2, ep: 3, gp: 4, pp: 5 },
      revisions: [{ id: 1, authorName: 'Ada Lovelace', authorUserId: '42' }],
      scheduledSessions: [{ id: 1, cancelledBy: null, rsvps: [{ userId: '42', userName: 'Ada Lovelace', status: 'yes', note: '' }] }],
      sessionAttendance: [{ id: 1, sessionId: 1, characterId: 1, characterName: 'Hero' }],
      diceRolls: [{ id: 1, rollerUserId: '42', rollerName: 'Ada Lovelace', total: 12 }],
      aiSeat: { mode: 'assist', instructions: 'be terse' }, aiScribeConfig: { postSession: true },
      attachments: [{ id: 7, kind: 'map', filename: 'ada-holiday.png', mime: 'image/png', size: 1, createdAt: 'now', file: 'uploads/7.png', fileRoute: '/api/v1/attachments/7/file', present: true, uploaderUserId: '42' }],
      attachmentsNote: 'a', participantSupportNote: 'p',
    } as Record<string, unknown>;
  }

  it('backup passes the payload through untouched', () => {
    const raw = rawPayload();
    const out = projectExport(raw, resolveExportPolicy('backup'));
    expect(out.data).toBe(raw);
    expect(out.occurrencesRedacted).toBe(0);
  });

  it('a column nobody allowlisted is excluded by default, not shipped', () => {
    const out = projectExport(rawPayload(), resolveExportPolicy('publish'));
    const quests = out.data.quests as Array<Record<string, unknown>>;
    expect(quests[0].futureColumn).toBeUndefined();
    expect((out.data.campaign as Record<string, unknown>).futureColumn).toBeUndefined();
    // …and the DM is told which columns were withheld.
    const questRow = out.rows.find((r) => r.module === 'quests');
    expect(questRow?.fieldsWithheld).toEqual(expect.arrayContaining(['futureColumn', 'dmSecret', 'hidden']));
  });

  it('publish drops identity, audit, proposals, operational history and credentials', () => {
    const out = projectExport(rawPayload(), resolveExportPolicy('publish'));
    expect(out.data.members).toEqual([]);
    expect(out.data.audit).toEqual([]);
    expect(out.data.proposals).toEqual([]);
    expect(out.data.revisions).toEqual([]);
    expect(out.data.scheduledSessions).toEqual([]);
    expect(out.data.sessionAttendance).toEqual([]);
    expect(out.data.diceRolls).toEqual([]);
    expect(out.data.aiSeat).toBeNull();
    expect(out.data.aiScribeConfig).toBeNull();
    expect((out.data.campaign as Record<string, unknown>).icsToken).toBeUndefined();
    expect((out.data.campaign as Record<string, unknown>).storageQuotaBytes).toBeUndefined();
  });

  it('note visibility follows the policy: private/whisper never, dm_shared and party_shared by opt-in', () => {
    const bodies = (policy: ReturnType<typeof resolveExportPolicy>) =>
      (projectExport(rawPayload(), policy).data.notes as Array<{ body: string }>).map((n) => n.body);

    expect(bodies(resolveExportPolicy('publish'))).toEqual([]);
    expect(bodies(resolveExportPolicy('publish', { includePlayerContent: true }))).toEqual(['shared']);
    expect(bodies(resolveExportPolicy('publish', { includeDmSecrets: true }))).toEqual(['prep']);
    expect(bodies(resolveExportPolicy('handoff')).sort()).toEqual(['prep', 'shared']);
  });

  it('withheld played state is replaced by pristine defaults so the module still imports', () => {
    const out = projectExport(rawPayload(), resolveExportPolicy('publish', { includePlayerContent: true }));
    const quest = (out.data.quests as Array<Record<string, unknown>>)[0];
    expect(quest.status).toBe('available');
    const campaign = out.data.campaign as Record<string, unknown>;
    expect(campaign.sessionCount).toBe(0);
    const character = (out.data.characters as Array<Record<string, unknown>>)[0];
    expect(character.xp).toBe(0);
    expect(character.hpCurrent).toBe(20); // reset to hpMax, not left undefined
    expect((out.data.timelineCalendar as Record<string, unknown>).currentDate).toBe('');
  });

  it('withholds encounter-time NPC allegiance from a pristine publish module', () => {
    const raw = rawPayload();
    raw.encounters = [{
      id: 1,
      campaignId: 1,
      name: 'Ended fight',
      status: 'ended',
      combatants: [{ id: 1, encounterId: 1, kind: 'npc', npcId: 1, npcDispositionSnapshot: 'hostile', name: 'Bandit', hpMax: 10 }],
    }];

    const publish = projectExport(raw, resolveExportPolicy('publish')).data.encounters as Array<Record<string, unknown>>;
    expect(publish[0].status).toBe('preparing');
    expect((publish[0].combatants as Array<Record<string, unknown>>)[0].npcDispositionSnapshot).toBeUndefined();

    const handoff = projectExport(raw, resolveExportPolicy('handoff')).data.encounters as Array<Record<string, unknown>>;
    expect((handoff[0].combatants as Array<Record<string, unknown>>)[0].npcDispositionSnapshot).toBe('hostile');
  });

  it("session-zero lines/veils are participant-authored and follow the player-content option", () => {
    const withheld = projectExport(rawPayload(), resolveExportPolicy('publish')).data.sessionZero as Record<string, unknown>;
    expect(withheld.lines).toBeUndefined();
    expect(withheld.houseRules).toBe('H');
    const kept = projectExport(rawPayload(), resolveExportPolicy('publish', { includePlayerContent: true })).data
      .sessionZero as Record<string, unknown>;
    expect(kept.lines).toEqual(['no spiders']);
  });

  it('attachment filenames are neutralized for publish and uploader identity never travels', () => {
    const out = projectExport(rawPayload(), resolveExportPolicy('publish'));
    const attachment = (out.data.attachments as Array<Record<string, unknown>>)[0];
    expect(attachment.filename).toBe('attachment-7.png');
    expect(attachment.uploaderUserId).toBeUndefined();
    expect(attachment.originalFilenameWithheld).toBe(true);
    // Handoff keeps the original filename (the new DM is trusted with it).
    const handoff = projectExport(rawPayload(), resolveExportPolicy('handoff'));
    expect((handoff.data.attachments as Array<Record<string, unknown>>)[0].filename).toBe('ada-holiday.png');
  });

  it('collects account identities but not in-fiction names', () => {
    const identifiers = collectPrivateIdentifiers(rawPayload());
    expect(identifiers).toEqual(expect.arrayContaining(['ada', 'Ada Lovelace', '42']));
    expect(identifiers).not.toContain('Hero');
  });

  it('collects a campaign-member running DM and sweeps it out of free text (#588)', () => {
    // #1548: `assignedDmUserId` itself no longer reaches `collectPrivateIdentifiers` as a field
    // on `raw` — ExportService now builds `raw.scheduledSessions` via `toScheduledSessionExport(...)`,
    // which omits every organized-play decoration field (including assignedDmUserId) BEFORE `raw`
    // is constructed. When the running DM also happens to be a campaign member (the common case),
    // their id is still covered by the `raw.members[].userId` sweep a few lines above — same as any
    // other member. This test pins THAT guarantee: a DM typing the running DM's account id into
    // publishable prose is what the free-text sweep exists for, and no field allowlist can catch it,
    // because a quest body is content a published module must carry.
    const raw = rawPayload();
    (raw.members as Array<Record<string, unknown>>).push({ id: 2, campaignId: 1, userId: 'dev:grace-hopper', username: 'grace', displayName: 'Grace Hopper', role: 'dm' });
    (raw.quests as Array<Record<string, unknown>>)[0].body = 'Ask dev:grace-hopper about the vault key';

    expect(collectPrivateIdentifiers(raw)).toContain('dev:grace-hopper');

    const out = projectExport(raw, resolveExportPolicy('publish'));
    expect(out.scannedIdentifiers).toContain('dev:grace-hopper');
    expect(JSON.stringify(out.data)).not.toContain('grace-hopper');
    expect((out.data.quests as Array<Record<string, unknown>>)[0].body).toContain('[redacted]');
  });

  it('collects a NON-member running DM via the `extra` sideband and sweeps it out of free text (#588)', () => {
    // Devin/Codex review on #1548: `createSeries` accepts an arbitrary `assignedDmUserId` without
    // requiring the assignee be a member of the campaign being exported (organized-play.service.ts),
    // so the "always a campaign member" assumption behind the previous fix does NOT generally hold.
    // ExportService reuses the pre-strip scheduled-session rows from buildExport's own
    // snapshot and threads their assignedDmUserId values into collectPrivateIdentifiers
    // / projectExport via the `extra` parameter — NEVER attached to `raw` itself, so
    // they cannot leak into the exported document under any profile (including
    // 'backup's unredacted pass-through).
    // This test proves the sweep still catches a DM id that is genuinely absent from raw.members.
    const raw = rawPayload();
    (raw.quests as Array<Record<string, unknown>>)[0].body = 'Ask dev:grace-hopper about the vault key';
    const extra = ['dev:grace-hopper'];

    expect(collectPrivateIdentifiers(raw)).not.toContain('dev:grace-hopper');
    expect(collectPrivateIdentifiers(raw, extra)).toContain('dev:grace-hopper');

    const out = projectExport(raw, resolveExportPolicy('publish'), extra);
    expect(out.scannedIdentifiers).toContain('dev:grace-hopper');
    expect(JSON.stringify(out.data)).not.toContain('grace-hopper');
    expect((out.data.quests as Array<Record<string, unknown>>)[0].body).toContain('[redacted]');

    // `extra` is never attached to `raw` itself — confirm the sideband identifiers used for the
    // sweep did not also get added as a new field anywhere on the raw payload.
    expect(JSON.stringify(raw)).not.toContain('assignedDmUserId');
  });
});

describe('pseudonymization (#586)', () => {
  it('is stable within one export', () => {
    const p = new ExportPseudonymizer();
    expect(p.label('42')).toBe(p.label('42'));
    expect(p.label('42')).not.toBe(p.label('43'));
    expect(p.size).toBe(2);
    expect(p.label('42')).toMatch(/^Contributor [0-9a-f]{10}$/);
  });

  it('is unlinkable across exports and never reveals the id', () => {
    // The id here is long and non-hex on purpose. The label's tail is 10 random hex
    // characters, so a short numeric id like '42' turns up inside it by chance roughly
    // one run in thirty — this assertion used to fail at that rate on unrelated PRs.
    // An id that cannot fit in the tail, and cannot be spelled with hex digits, makes
    // "does not embed the raw id" a claim about the implementation rather than a
    // coin flip: a version that concatenated the id would fail every time.
    const id = 'user-zz-4242424242424242';
    const a = new ExportPseudonymizer().label(id);
    const b = new ExportPseudonymizer().label(id);
    expect(a).not.toBe(b);
    expect(a).not.toContain(id);
    expect(a).toMatch(/^Contributor [0-9a-f]{10}$/);
  });

  it('does not crash on an unknown author', () => {
    expect(new ExportPseudonymizer().label(null)).toBe('Contributor (unknown)');
  });
});

describe('identifier sweep (#586)', () => {
  it('redacts values, nested values and object KEYS', () => {
    const { value, occurrences } = redactIdentifiers(
      { note: 'ping Ada Lovelace', nested: [{ 'Ada Lovelace': 'owner' }] },
      ['Ada Lovelace'],
    );
    expect(JSON.stringify(value)).not.toContain('Ada Lovelace');
    expect(occurrences).toBe(2);
  });

  it('respects word-ish boundaries so it does not shred unrelated prose', () => {
    const { value } = redactIdentifiers({ s: 'Adamant plating' }, ['Ada']);
    expect((value as { s: string }).s).toBe('Adamant plating');
  });

  it('redacts any email-shaped string, account or not', () => {
    const { value, occurrences } = redactIdentifiers({ s: 'write to nobody@example.invalid today' }, []);
    expect((value as { s: string }).s).not.toContain('nobody@example.invalid');
    expect(occurrences).toBe(1);
  });

  it('reports identifiers too short to sweep for instead of silently ignoring them', () => {
    const { scannable, unscannable } = partitionIdentifiers(['42', 'ada', 'Ada Lovelace']);
    expect(unscannable).toEqual(['42', 'ada']);
    expect(scannable).toEqual(['Ada Lovelace']);
    expect(MIN_SCANNABLE_IDENTIFIER).toBe(4);
  });
});

describe('image metadata stripping (#586)', () => {
  function crc32(buf: Buffer): number {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  }
  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([len, typed, crc]);
  }
  function png(withText: boolean): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      ...(withText ? [chunk('tEXt', Buffer.from('Author\0Ada Lovelace', 'latin1'))] : []),
      chunk('IDAT', deflateSync(Buffer.from([0x00, 0xff, 0x00, 0x00]))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }

  it('drops PNG text chunks and keeps the image renderable', () => {
    const result = stripImageMetadata('image/png', png(true));
    expect(result.supported).toBe(true);
    expect(result.stripped).toBe(true);
    expect(result.bytes.toString('latin1')).not.toContain('tEXt');
    expect(result.bytes.toString('latin1')).not.toContain('Ada Lovelace');
    expect(result.bytes.toString('latin1')).toContain('IHDR');
    expect(result.bytes.toString('latin1')).toContain('IDAT');
    expect(result.bytes.toString('latin1')).toContain('IEND');
  });

  it('reports stripped=false for a PNG that carried no metadata', () => {
    const result = stripImageMetadata('image/png', png(false));
    expect(result.supported).toBe(true);
    expect(result.stripped).toBe(false);
    expect(result.bytes.equals(png(false))).toBe(true);
  });

  it('drops JPEG APP1/COM segments and keeps the scan data intact', () => {
    // JPEG segment length counts the two length bytes themselves — build them so the
    // fixture is a structurally valid stream rather than an accidental parse failure.
    const segment = (marker: number, payload: Buffer) => {
      const header = Buffer.alloc(4);
      header[0] = 0xff;
      header[1] = marker;
      header.writeUInt16BE(payload.length + 2, 2);
      return Buffer.concat([header, payload]);
    };
    const app1 = segment(0xe1, Buffer.from('Exif\0\0Ada Lovelace', 'latin1'));
    const com = segment(0xfe, Buffer.from('secret', 'latin1'));
    const sof = segment(0xc0, Buffer.from([0x11, 0x22]));
    const sos = segment(0xda, Buffer.from([0x33, 0x44]));
    const entropy = Buffer.from([0x01, 0x02, 0x03, 0xff, 0xd9]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, com, sof, sos, entropy]);

    const result = stripImageMetadata('image/jpeg', jpeg);
    expect(result.supported).toBe(true);
    expect(result.stripped).toBe(true);
    expect(result.bytes.toString('latin1')).not.toContain('Ada Lovelace');
    expect(result.bytes.toString('latin1')).not.toContain('secret');
    // SOI + SOF + SOS header + entropy-coded data are all still there.
    expect(result.bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
    expect(result.bytes.includes(sof)).toBe(true);
    expect(result.bytes.subarray(-entropy.length).equals(entropy)).toBe(true);
  });

  it('refuses to rewrite formats it cannot parse rather than pretending it sanitized them', () => {
    for (const mime of ['image/webp', 'application/pdf', 'image/svg+xml']) {
      const result = stripImageMetadata(mime, Buffer.from('whatever'));
      expect(result.supported).toBe(false);
      expect(result.stripped).toBe(false);
      expect(SANITIZABLE_MIMES.has(mime)).toBe(false);
    }
    // A truncated/corrupt PNG is unsupported too, not silently mangled.
    expect(stripImageMetadata('image/png', Buffer.from('not a png at all')).supported).toBe(false);
  });
});
