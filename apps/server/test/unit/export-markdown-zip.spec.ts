import JSZip from 'jszip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { ExportService } from '../../src/modules/export/export.service';
import { resolveExportPolicy } from '../../src/modules/export/export-profiles';
import type { RequestUser } from '../../src/common/user.types';

/**
 * Legacy collision regression coverage (issue #530), updated for issue #863's
 * stable `{stem}__{type}-{id}.md` path scheme. Comprehensive Unicode /
 * manifest tests live in `export-markdown-archive.spec.ts`.
 */

function campaignRow() {
  return {
    id: 1,
    name: 'Test Campaign',
    description: 'A campaign.',
    status: 'active',
    dangerLevel: 'medium',
    sessionCount: 0,
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
}): ExportService {
  const noop = async () => [];
  const campaign = campaignRow();
  // Each property is a service-shaped object exposing only the methods
  // buildExport / buildMarkdownZip actually call.
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
    { getOrThrow: async () => campaign } as any, // campaigns
    { listForCampaignWithObjectives: async () => entities.quests ?? [] } as any, // quests
    { listForCampaign: async () => entities.npcs ?? [] } as any, // npcs
    { listForCampaign: async () => entities.locations ?? [] } as any, // locations
    { listRecapsForCampaign: async () => entities.sessions ?? [], listAttendanceForCampaign: async () => [] } as any, // sessions
    // scheduling — the archive reads listForExport, deliberately the RAW rows (#504);
    // exposing only that method keeps the stub honest if the call site ever changes back.
    { listForExport: async () => [] } as any,
    { listForExport: async () => entities.characters ?? [] } as any, // characters (#1667: buildExport reads listForExport)
    { listForCampaign: noop as any, listAllForCampaign: async () => [] } as any, // notes
    { listForCampaign: noop as any } as any, // comments
    { listForCampaign: noop as any } as any, // members
    {
      listForCampaign: noop as any,
      listForCampaignExport: async () => ({
        entries: [],
        meta: {
          total: 0,
          exported: 0,
          truncated: 0,
          cutoff: { snapshotMaxId: 0, capturedAt: new Date(0).toISOString(), oldestExportedCreatedAt: null },
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
      listRowsForCampaign: noop as any,
      hasBytesOnDisk: () => false,
      readBytesIfPresent: () => null,
    } as any,
    { listForCampaign: noop as any } as any,
    { listArcsWithBeats: noop as any } as any,
    { listEvents: noop as any, getCalendar: async () => null } as any,
    { get: async () => null } as any,
    { getOwn: async () => null } as any,
    { listForCampaign: noop as any, getTreasury: async () => null } as any,
    { listForCampaign: noop as any } as any,
    { listForCampaign: noop as any } as any, // rolls
  );
}

const USER: RequestUser = { id: 'user-1', name: 'Tester', role: 'dm' } as any;

function serviceWithCollisions(): ExportService {
  return buildService({
    quests: [
      { id: 1, title: 'Lost Mine', status: 'active', reward: 'gold', body: 'b1', objectives: [], dmSecret: null, parentId: null },
      { id: 2, title: 'Lost Mine', status: 'active', reward: 'gold', body: 'b2', objectives: [], dmSecret: null, parentId: null },
      { id: 3, title: 'Unique Quest', status: 'active', reward: '', body: 'b3', objectives: [], dmSecret: null, parentId: null },
    ],
    npcs: [
      { id: 1, name: 'Bob', role: 'merchant', disposition: 'friendly', body: 'b1', dmSecret: null, locationId: null, factionId: null },
      { id: 2, name: 'Bob', role: 'guard', disposition: 'neutral', body: 'b2', dmSecret: null, locationId: null, factionId: null },
    ],
    locations: [
      { id: 1, name: 'Tavern', kind: 'building', status: 'intact', body: 'b1', dmSecret: null, parentId: null },
      { id: 2, name: 'Tavern', kind: 'building', status: 'ruined', body: 'b2', dmSecret: null, parentId: null },
    ],
    sessions: [
      { id: 1, number: 1, title: 'The Big Battle', playedAt: null, recap: 'r1', dmSecret: null },
      { id: 2, number: 2, title: 'The Big Battle', playedAt: null, recap: 'r2', dmSecret: null },
    ],
    characters: [
      {
        id: 1, name: 'Aragorn', species: 'human', className: 'ranger', level: 5, xp: 0,
        hpCurrent: 30, hpMax: 30, ac: 15, notes: 'c1', dmSecret: null, portraitUrl: null, actions: [], spellSlots: {},
      },
      {
        id: 2, name: 'Aragorn', species: 'human', className: 'ranger', level: 6, xp: 0,
        hpCurrent: 31, hpMax: 31, ac: 16, notes: 'c2', dmSecret: null, portraitUrl: null, actions: [], spellSlots: {},
      },
    ],
    encounters: [
      {
        id: 1, name: 'Ambush', status: 'active', round: 1, combatants: [],
        locationId: null, questId: null, sessionId: null, mapAttachmentId: null,
        gridType: 'square', gridSize: null, gridScale: null, gridUnit: null, gridSnap: false, fog: null,
      },
      {
        id: 2, name: 'Ambush', status: 'active', round: 2, combatants: [],
        locationId: null, questId: null, sessionId: null, mapAttachmentId: null,
        gridType: 'square', gridSize: null, gridScale: null, gridUnit: null, gridSnap: false, fog: null,
      },
    ],
  });
}

describe('buildMarkdownZip — filename collisions (issues #530 / #863)', () => {
  it('stages sanitized streaming attachments instead of retaining their buffers', async () => {
    const service = serviceWithCollisions();
    const bytes = Buffer.from('%PDF-without-private-identifiers');
    (service as any).attachments.readBytesIfPresent = jest.fn(() => bytes);
    const stage = jest.fn(async () => ({ path: '/staged/sanitized.pdf', checksum: 'abc123' }));

    const decisions = await (service as any).planAttachmentBytes(
      1,
      { attachments: [{ id: 7, mime: 'application/pdf', filename: 'source.pdf' }] },
      resolveExportPolicy('handoff'),
      [],
      true,
      stage,
    );

    expect(stage).toHaveBeenCalledWith(bytes);
    expect(decisions.get(7)).toMatchObject({
      bytes: null,
      sourcePath: '/staged/sanitized.pdf',
      sourceChecksum: 'abc123',
    });
  });

  it('stops sanitized attachment planning between staged files after cancellation', async () => {
    const service = serviceWithCollisions();
    const bytes = Buffer.from('%PDF-without-private-identifiers');
    const readBytes = jest.fn(() => bytes);
    (service as any).attachments.readBytesIfPresent = readBytes;
    const controller = new AbortController();
    const stage = jest.fn(async () => {
      controller.abort(new Error('client disconnected'));
      return { path: '/staged/sanitized.pdf', checksum: 'abc123' };
    });

    await expect((service as any).planAttachmentBytes(
      1,
      {
        attachments: [
          { id: 7, mime: 'application/pdf', filename: 'first.pdf' },
          { id: 8, mime: 'application/pdf', filename: 'second.pdf' },
        ],
      },
      resolveExportPolicy('handoff'),
      [],
      false,
      stage,
      true,
      controller.signal,
    )).rejects.toThrow('client disconnected');

    expect(stage).toHaveBeenCalledTimes(1);
    expect(readBytes).toHaveBeenCalledTimes(1);
  });

  it('releases inspected preview attachment buffers while preserving their inventory', async () => {
    const service = serviceWithCollisions();
    const attachments = [
      { id: 7, mime: 'application/pdf', filename: 'first.pdf' },
      { id: 8, mime: 'application/pdf', filename: 'second.pdf' },
      { id: 9, mime: 'application/pdf', filename: 'third.pdf' },
    ];
    const bytes = new Map(attachments.map((attachment) => [attachment.id, Buffer.alloc(256 * 1024, attachment.id)]));
    const readBytes = jest.fn(({ id }: { id: number }) => bytes.get(id));
    (service as any).attachments.readBytesIfPresent = readBytes;
    const policy = resolveExportPolicy('handoff');

    const decisions = await (service as any).planAttachmentBytes(
      1,
      { attachments },
      policy,
      [],
      false,
      undefined,
      false,
    );

    expect([...decisions.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 7, bytes: null, available: true }),
      expect.objectContaining({ id: 8, bytes: null, available: true }),
      expect.objectContaining({ id: 9, bytes: null, available: true }),
    ]));
    expect([...decisions.values()].every((decision) => decision.bytes === null)).toBe(true);
    expect(readBytes).toHaveBeenCalledTimes(3);
    expect((service as any).attachmentInventory({ attachments }, policy, decisions, 'mdzip', true)).toMatchObject({
      included: 3,
      bytesWithheld: 0,
    });
  });

  it('asks Markdown ZIP previews to inspect attachments without retaining bytes', async () => {
    const service = serviceWithCollisions();
    const build = jest.spyOn(service as any, 'buildProfileExport').mockResolvedValue({ inventory: { profile: 'handoff' } });

    await service.buildExportInventory(1, USER, 'handoff', {}, 'mdzip');

    expect(build).toHaveBeenCalledWith(1, USER, 'handoff', {}, expect.objectContaining({
      inspectAttachmentBytes: true,
      format: 'mdzip',
      retainAttachmentBytes: false,
    }));
  });

  it('uses secure source availability, not bytes, for backup Markdown ZIP previews', async () => {
    const service = serviceWithCollisions();
    const attachments = [
      { id: 7, mime: 'application/pdf', filename: 'present.pdf', present: true },
      { id: 8, mime: 'application/pdf', filename: 'missing.pdf', present: true },
    ];
    const hasExportFile = jest.fn(({ id }: { id: number }) => id === 7);
    const readBytes = jest.fn();
    (service as any).attachments.hasExportFile = hasExportFile;
    (service as any).attachments.readBytesIfPresent = readBytes;
    // buildProfileExport reads its `raw` document AND the pre-strip scheduled-session
    // rows (assignedDmUserId sweep, issue #1548) from one shared buildExportInternal
    // snapshot rather than calling public buildExport() twice — mock that seam instead.
    jest
      .spyOn(service as any, 'buildExportInternal')
      .mockResolvedValue({ document: { attachments }, scheduledSessionList: [] });

    const result = await (service as any).buildProfileExport(
      1,
      USER,
      'backup',
      {},
      { inspectAttachmentBytes: true, format: 'mdzip', attachmentPaths: true, retainAttachmentBytes: false },
    );

    expect(hasExportFile).toHaveBeenCalledTimes(2);
    expect(readBytes).not.toHaveBeenCalled();
    expect(result.attachmentBytes.get(7)).toMatchObject({
      liveSource: { campaignId: 1, id: 7, mime: 'application/pdf' },
      bytes: null,
    });
    expect(result.attachmentBytes.get(8)).toMatchObject({ bytes: null, withheldReason: 'file missing on disk' });
    expect(result.data.attachments).toEqual([
      expect.objectContaining({ id: 7, present: true }),
      expect.objectContaining({ id: 8, present: false, bytesWithheldReason: 'file missing on disk' }),
    ]);
    expect(result.inventory.attachments).toMatchObject({
      included: 2,
      bytesWithheld: 1,
    });
  });

  it('reads the assignedDmUserId sweep from the same scheduling snapshot as the export document (#1548 P2 follow-up)', async () => {
    // Codex review on PR #1651: buildProfileExport used to call
    // scheduling.listForExport a SECOND time (after buildExport's own internal call)
    // purely to recover the pre-strip assignedDmUserId values for the free-text sweep.
    // Two separate queries meant a reassignment/deletion racing the export could desync
    // the sweep from the prose snapshot it's meant to cover. buildProfileExport must now
    // reuse buildExport's own snapshot instead of re-querying.
    const service = serviceWithCollisions();
    const listForExport = jest.fn(async () => [
      { id: 1, campaignId: 1, assignedDmUserId: 'dev:non-member-dm' } as any,
    ]);
    (service as any).scheduling.listForExport = listForExport;

    const result = await (service as any).buildProfileExport(1, USER, 'publish', {}, {});

    expect(listForExport).toHaveBeenCalledTimes(1);
    expect(result.projection.scannedIdentifiers).toContain('dev:non-member-dm');
  });

  it('asks backup Markdown ZIP previews to use attachment paths', async () => {
    const service = serviceWithCollisions();
    const build = jest.spyOn(service as any, 'buildProfileExport').mockResolvedValue({ inventory: { profile: 'backup' } });

    await service.buildExportInventory(1, USER, 'backup', {}, 'mdzip');

    expect(build).toHaveBeenCalledWith(1, USER, 'backup', {}, expect.objectContaining({
      inspectAttachmentBytes: true,
      attachmentPaths: true,
      retainAttachmentBytes: false,
    }));
  });

  it('streams a readable ZIP without invoking the compatibility buffer builder', async () => {
    const service = serviceWithCollisions();
    const legacy = jest.spyOn(service, 'buildMarkdownZip');
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    await service.streamMarkdownZip(output, new AbortController().signal, 1, USER);
    expect(legacy).not.toHaveBeenCalled();
    const zip = await JSZip.loadAsync(Buffer.concat(chunks));
    expect(zip.file('campaign.json')).not.toBeNull();
  });

  it('restricts the export staging directory and every staged attachment file', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-staging-mode-source-'));
    const source = path.join(sourceDir, 'source.bin');
    fs.writeFileSync(source, 'source bytes');
    const service = serviceWithCollisions();
    (service as any).attachments.openExportStreamIfPresent = () => fs.createReadStream(source);
    jest.spyOn(service as any, 'writeMarkdownZip').mockImplementation(async (writer: any) => {
      await writer.attachment('uploads/direct.bin', Buffer.from('direct'));
      const buffered = await writer.stageAttachment(Buffer.from('buffered'));
      const stagingDir = path.dirname(buffered.path);
      expect(fs.statSync(stagingDir).mode & 0o777).toBe(0o700);
      await writer.stageLiveAttachment({ campaignId: 1, id: 1, mime: 'application/octet-stream' });
      await writer.attachmentPath('uploads/path.bin', source);
      const stagedFiles = fs.readdirSync(stagingDir).map((name) => path.join(stagingDir, name));
      expect(stagedFiles).toHaveLength(4);
      expect(stagedFiles.map((file) => fs.statSync(file).mode & 0o777)).toEqual([
        0o600,
        0o600,
        0o600,
        0o600,
      ]);
      return { warnings: [], inventory: {} };
    });
    const output = new PassThrough();
    output.resume();
    try {
      await service.streamMarkdownZip(output, new AbortController().signal, 1, USER);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it('securely opens live attachments for streamed backup ZIPs', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-backup-path-'));
    const source = path.join(sourceDir, 'attachment.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0]);
    fs.writeFileSync(source, bytes);
    const service = buildService({});
    const attachments = (service as any).attachments;
    attachments.listRowsForCampaign = async () => [{
      id: 9, campaignId: 1, kind: 'image', filename: 'backup.png', mime: 'image/png', size: bytes.length, createdAt: new Date(0).toISOString(),
    }];
    attachments.hasBytesOnDisk = () => true;
    const hasExportFile = jest.fn(() => true);
    const openExportStream = jest.fn(() => fs.createReadStream(source));
    const readBytes = jest.fn();
    attachments.hasExportFile = hasExportFile;
    attachments.openExportStreamIfPresent = openExportStream;
    attachments.readBytesIfPresent = readBytes;
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    try {
      await service.streamMarkdownZip(output, new AbortController().signal, 1, USER, { profile: 'backup' });
      const zip = await JSZip.loadAsync(Buffer.concat(chunks));
      expect(hasExportFile).toHaveBeenCalledTimes(1);
      expect(openExportStream).toHaveBeenCalledTimes(1);
      expect(readBytes).not.toHaveBeenCalled();
      expect(await zip.file('uploads/9.png')!.async('nodebuffer')).toEqual(bytes);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it.each(['handoff', 'publish'] as const)('stages sanitized %s bytes without probing live paths', async (profile) => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0]);
    const service = buildService({});
    const attachments = (service as any).attachments;
    attachments.listRowsForCampaign = async () => [{
      id: 9, campaignId: 1, kind: 'image', filename: 'private-name.png', mime: 'image/png', size: bytes.length, createdAt: new Date(0).toISOString(),
    }];
    attachments.hasBytesOnDisk = () => true;
    const hasExportFile = jest.fn(() => { throw new Error('redacted profiles must not probe live files'); });
    const openExportStream = jest.fn(() => { throw new Error('redacted profiles must not open live files'); });
    const readBytes = jest.fn(() => bytes);
    attachments.hasExportFile = hasExportFile;
    attachments.openExportStreamIfPresent = openExportStream;
    attachments.readBytesIfPresent = readBytes;
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));

    await service.streamMarkdownZip(output, new AbortController().signal, 1, USER, { profile });

    const zip = await JSZip.loadAsync(Buffer.concat(chunks));
    expect(hasExportFile).not.toHaveBeenCalled();
    expect(openExportStream).not.toHaveBeenCalled();
    expect(readBytes).toHaveBeenCalledTimes(1);
    expect(await zip.file('uploads/9.png')!.async('nodebuffer')).toEqual(bytes);
  });

  it('withholds unreadable handoff attachment bytes instead of aborting the stream', async () => {
    const service = buildService({});
    const attachments = (service as any).attachments;
    attachments.listRowsForCampaign = async () => [{
      id: 9, campaignId: 1, kind: 'image', filename: 'unreadable.png', mime: 'image/png', size: 21, createdAt: new Date(0).toISOString(),
    }];
    attachments.hasBytesOnDisk = () => true;
    const hasExportFile = jest.fn(() => { throw new Error('handoff must not probe live files'); });
    const openExportStream = jest.fn(() => { throw new Error('handoff must not open live files'); });
    const readBytes = jest.fn(() => null);
    attachments.hasExportFile = hasExportFile;
    attachments.openExportStreamIfPresent = openExportStream;
    attachments.readBytesIfPresent = readBytes;
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));

    await expect(service.streamMarkdownZip(output, new AbortController().signal, 1, USER, { profile: 'handoff' })).resolves.toBeDefined();

    const zip = await JSZip.loadAsync(Buffer.concat(chunks));
    const campaign = JSON.parse(await zip.file('campaign.json')!.async('string'));
    expect(hasExportFile).not.toHaveBeenCalled();
    expect(openExportStream).not.toHaveBeenCalled();
    expect(readBytes).toHaveBeenCalledTimes(1);
    expect(campaign.attachments[0]).toMatchObject({ present: false, bytesWithheldReason: 'file missing on disk' });
    expect(zip.file('uploads/9.png')).toBeNull();
  });

  it('classifies a live source that vanishes after planning before any ZIP bytes flow', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-race-'));
    const source = path.join(sourceDir, 'attachment.png');
    fs.writeFileSync(source, Buffer.from('not-a-real-png'));
    const service = buildService({});
    const attachments = (service as any).attachments;
    attachments.listRowsForCampaign = async () => [{
      id: 9, campaignId: 1, kind: 'image', filename: 'race.png', mime: 'image/png', size: 14, createdAt: new Date(0).toISOString(),
    }];
    attachments.hasBytesOnDisk = () => true;
    attachments.hasExportFile = () => true;
    attachments.openExportStreamIfPresent = () => {
      fs.rmSync(source);
      return null;
    };
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    try {
      await service.streamMarkdownZip(output, new AbortController().signal, 1, USER);
      const zip = await JSZip.loadAsync(Buffer.concat(chunks));
      const campaign = JSON.parse(await zip.file('campaign.json')!.async('string'));
      expect(campaign.attachments[0].present).toBe(false);
      expect(campaign.redaction.attachments.bytesWithheld).toBe(1);
      expect(await zip.file('warnings.txt')!.async('string')).toMatch(/file missing on disk/);
      expect(zip.file('uploads/9.png')).toBeNull();
      const manifest = JSON.parse(await zip.file('archive-manifest.json')!.async('string'));
      expect(manifest.redaction.attachments.bytesWithheld).toBe(1);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it('propagates secure live-source open failures before archive bytes flow', async () => {
    const service = buildService({});
    const attachments = (service as any).attachments;
    attachments.listRowsForCampaign = async () => [{
      id: 9, campaignId: 1, kind: 'image', filename: 'restricted.png', mime: 'image/png',
      size: 14, createdAt: new Date(0).toISOString(),
    }];
    attachments.hasBytesOnDisk = () => true;
    attachments.hasExportFile = () => true;
    attachments.openExportStreamIfPresent = () => {
      throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    };
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));

    await expect(service.streamMarkdownZip(output, new AbortController().signal, 1, USER))
      .rejects.toThrow('access denied');
    expect(chunks).toHaveLength(0);
  });

  it('rejects a pre-aborted streaming export without writing output', async () => {
    const service = serviceWithCollisions();
    const controller = new AbortController();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    controller.abort(new Error('cancelled by test'));

    await expect(service.streamMarkdownZip(output, controller.signal, 1, USER)).rejects.toThrow('cancelled by test');
    expect(chunks).toHaveLength(0);
  });

  it('leaves the destination intact when campaign projection fails before archive bytes', async () => {
    const service = serviceWithCollisions();
    jest.spyOn(service as any, 'buildProfileExport').mockRejectedValue(new Error('database unavailable'));
    const output = new PassThrough();
    await expect(service.streamMarkdownZip(output, new AbortController().signal, 1, USER)).rejects.toThrow(
      'database unavailable',
    );
    expect(output.destroyed).toBe(false);
  });

  it('finishes encounter-event queries before producing archive bytes', async () => {
    const service = serviceWithCollisions();
    jest.spyOn((service as any).encounters, 'listEventsForEncounters')
      .mockRejectedValue(new Error('encounter events unavailable'));
    const output = new PassThrough();
    const onFirstByte = jest.fn();
    await expect(
      service.streamMarkdownZip(output, new AbortController().signal, 1, USER, { onFirstByte }),
    ).rejects.toThrow('encounter events unavailable');
    expect(onFirstByte).not.toHaveBeenCalled();
    expect(output.destroyed).toBe(false);
  });

  it('does not signal the caller to commit zip headers when no bytes are produced', async () => {
    const service = serviceWithCollisions();
    jest.spyOn(service as any, 'buildProfileExport').mockRejectedValue(new Error('database unavailable'));
    const onFirstByte = jest.fn();
    const output = new PassThrough();
    await expect(
      service.streamMarkdownZip(output, new AbortController().signal, 1, USER, { onFirstByte }),
    ).rejects.toThrow('database unavailable');
    // The controller hangs Content-Type/Content-Disposition off this callback. Firing it
    // for a failed export would send a JSON error labelled `application/zip` as an
    // attachment, which an anchor-driven download saves to disk as a corrupt archive.
    expect(onFirstByte).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('signals the caller exactly once, before the first byte, on a successful export', async () => {
    const service = serviceWithCollisions();
    const seen: string[] = [];
    const onFirstByte = jest.fn(() => seen.push('headers'));
    const output = new PassThrough();
    output.on('data', () => seen.push('byte'));
    await service.streamMarkdownZip(output, new AbortController().signal, 1, USER, { onFirstByte });
    expect(onFirstByte).toHaveBeenCalledTimes(1);
    expect(seen[0]).toBe('headers');
  });

  it('destroys the destination when a failure occurs after archive bytes begin flowing', async () => {
    const service = serviceWithCollisions();
    const controller = new AbortController();
    const output = new PassThrough();
    output.once('data', () => controller.abort(new Error('client disconnected after output')));
    await expect(service.streamMarkdownZip(output, controller.signal, 1, USER)).rejects.toThrow(
      'client disconnected after output',
    );
    expect(output.destroyed).toBe(true);
  });

  it('produces one zip entry per source entity in every folder', async () => {
    const service = serviceWithCollisions();
    const { buffer } = await service.buildMarkdownZip(1, USER);
    const zip = await JSZip.loadAsync(buffer);
    const entryNames = (folder: string) =>
      Object.keys(zip.files)
        .filter((n) => n.startsWith(`${folder}/`) && n.endsWith('.md'))
        .map((n) => n.slice(folder.length + 1))
        .sort();

    expect(entryNames('quests')).toEqual([
      'Lost Mine__quest-1.md',
      'Lost Mine__quest-2.md',
      'Unique Quest__quest-3.md',
    ].sort());
    expect(entryNames('npcs')).toEqual(['Bob__npc-1.md', 'Bob__npc-2.md'].sort());
    expect(entryNames('locations')).toEqual(['Tavern__location-1.md', 'Tavern__location-2.md'].sort());
    expect(entryNames('sessions')).toEqual([
      'The Big Battle__session-1.md',
      'The Big Battle__session-2.md',
    ].sort());
    expect(entryNames('characters')).toEqual(['Aragorn__character-1.md', 'Aragorn__character-2.md'].sort());
    expect(entryNames('encounters')).toEqual(['Ambush__encounter-1.md', 'Ambush__encounter-2.md'].sort());
  });

  it('keeps both same-named records with distinct id-suffixed paths', async () => {
    const service = serviceWithCollisions();
    const { buffer } = await service.buildMarkdownZip(1, USER);
    const zip = await JSZip.loadAsync(buffer);

    const first = await zip.file('quests/Lost Mine__quest-1.md')!.async('string');
    const second = await zip.file('quests/Lost Mine__quest-2.md')!.async('string');
    expect(first).toContain('b1');
    expect(second).toContain('b2');
    expect(first).toContain('Typed ID: `quest:1`');
    expect(second).toContain('Typed ID: `quest:2`');
  });

  it('returns stem-collision warnings and embeds warnings.txt', async () => {
    const service = serviceWithCollisions();
    const { buffer, warnings } = await service.buildMarkdownZip(1, USER);
    expect(warnings.length).toBeGreaterThanOrEqual(6);
    const npcWarning = warnings.find((w) => w.includes('NPC'));
    expect(npcWarning).toContain("shared the display stem 'Bob'");
    expect(npcWarning).toContain('Bob__npc-1.md');
    expect(npcWarning).toContain('Bob__npc-2.md');

    const zip = await JSZip.loadAsync(buffer);
    const text = await zip.file('warnings.txt')!.async('string');
    for (const w of warnings) {
      expect(text).toContain(w);
    }
  });

  it('omits warnings.txt when no stem collisions occur', async () => {
    const service = buildService({
      quests: [{ id: 1, title: 'Only Quest', status: 'active', reward: '', body: 'b', objectives: [], dmSecret: null, parentId: null }],
      npcs: [{ id: 1, name: 'Only NPC', role: 'x', disposition: 'neutral', body: 'b', dmSecret: null, locationId: null, factionId: null }],
      locations: [{ id: 1, name: 'Only Loc', kind: 'k', status: 'intact', body: 'b', dmSecret: null, parentId: null }],
      sessions: [{ id: 1, number: 1, title: 'Only Session', playedAt: null, recap: 'r', dmSecret: null }],
      characters: [{
        id: 1, name: 'Only Char', species: 'h', className: 'c', level: 1, xp: 0,
        hpCurrent: 1, hpMax: 1, ac: 1, notes: 'n', dmSecret: null, portraitUrl: null, actions: [], spellSlots: {},
      }],
      encounters: [{
        id: 1, name: 'Only Enc', status: 'active', round: 1, combatants: [],
        locationId: null, questId: null, sessionId: null, mapAttachmentId: null,
        gridType: 'square', gridSize: null, gridScale: null, gridUnit: null, gridSnap: false, fog: null,
      }],
    });
    const { buffer, warnings } = await service.buildMarkdownZip(1, USER);
    expect(warnings).toEqual([]);
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file('warnings.txt')).toBeNull();
  });

  it('does not write warnings into campaign.json (keeps the manifest round-trippable)', async () => {
    const service = serviceWithCollisions();
    const { buffer } = await service.buildMarkdownZip(1, USER);
    const zip = await JSZip.loadAsync(buffer);
    const manifest = JSON.parse(await zip.file('campaign.json')!.async('string'));
    expect(manifest.warnings).toBeUndefined();
    expect(manifest._exportWarnings).toBeUndefined();
  });
});
