/**
 * Issue #586 — CANARY: known private content must not appear ANYWHERE in a publish archive.
 *
 * A whitelist projection is only as good as the proof that nothing rides along, so this
 * suite is written the way an attacker would look at the artifact rather than the way the
 * implementation is organised:
 *
 *   1. seed a campaign where EVERY field that could plausibly leak carries a distinctive,
 *      greppable marker — usernames, display names, an email, the member's user id, DM
 *      secrets, whisper and private note bodies, audit detail, a proposal payload, an RSVP
 *      note, attendance, a dice-log roller, an attachment filename, and a PNG tEXt chunk
 *      (the embedded-metadata case);
 *   2. pull a publish export in BOTH formats;
 *   3. flatten the artifact to bytes — every zip entry NAME and every zip entry's CONTENT,
 *      including binaries and the manifest — and assert no marker survives anywhere;
 *   4. separately assert no identity-shaped KEY survives, because numeric user ids are too
 *      short to sweep for and the field allowlist is what has to keep them out.
 *
 * If a future change adds a column, a module, a markdown file or a new archive member that
 * carries identity, this suite fails on the marker, not on a hand-written field list.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import request from 'supertest';
import JSZip from 'jszip';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

// ── canary markers ───────────────────────────────────────────────────────────
// Long, unique, and not otherwise present in the codebase, so a hit is never a
// coincidence. Usernames are constrained to [a-z0-9_.-] by the API.
const M = {
  dmUsername: 'canary-dm-alfa-9f31',
  playerUsername: 'canary-player-bravo-9f32',
  playerDisplayName: 'Canary Charlie Displayname 9f33',
  playerEmailish: 'canary-delta-9f34@example.invalid',
  dmSecret: 'canary-dmsecret-echo-9f35',
  whisperBody: 'canary-whisper-foxtrot-9f36',
  privateNote: 'canary-private-golf-9f37',
  auditDetail: 'canary-audit-hotel-9f38',
  proposalText: 'canary-proposal-india-9f39',
  rsvpNote: 'canary-rsvp-juliett-9f40',
  attachmentFilename: 'canary-attachment-kilo-9f41.png',
  pngTextChunk: 'canary-exif-lima-9f42',
  diceLabel: 'canary-dice-mike-9f43',
  scheduleLocation: 'canary-venue-november-9f44',
} as const;

/**
 * Campfire is private-by-default (#42/#262): almost every quest/NPC starts `hidden`.
 * An unrevealed entity is therefore CONTENT a publishable module must carry, not a
 * privacy leak — so this marker is deliberately kept out of `M` and asserted PRESENT.
 * What must not survive is the `hidden` staging flag itself.
 */
const UNREVEALED_QUEST_TITLE = 'canary-unrevealed-oscar-9f45';

/** Identity-shaped keys that must not exist anywhere in a publish payload. */
const FORBIDDEN_KEYS = [
  'userId', 'authorUserId', 'ownerUserId', 'recipientUserId', 'proposerUserId', 'rollerUserId',
  'uploaderUserId', 'deletedBy', 'editedBy', 'resolvedBy', 'cancelledBy', 'createdBy',
  'username', 'displayName', 'authorName', 'recipientName', 'proposer', 'proposerToken',
  'rollerName', 'replacedByUserId', 'replacedByName', 'actorName',
];

// ── PNG with an embedded tEXt metadata chunk ─────────────────────────────────
// A real 1x1 PNG whose tEXt chunk carries a canary. This is the "EXIF leaks" case
// in the format the upload allowlist actually accepts.
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}
function pngWithTextChunk(text: string): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); // width
  ihdrData.writeUInt32BE(1, 4); // height
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: truecolor
  // filter byte + 1 RGB pixel
  const idat = deflateSync(Buffer.from([0x00, 0xff, 0x00, 0x00]));
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdrData),
    pngChunk('tEXt', Buffer.concat([Buffer.from('Author', 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')])),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// supertest's `parse` types the first arg as its own Response; at runtime it is the
// raw HTTP stream, which is what we need to collect binary zip bytes.
function binaryParser(response: any, callback: (err: Error | null, body: any) => void): void {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
}

/** Everything a reader of the archive can see: entry names AND entry bytes. */
async function flattenZip(buffer: Buffer): Promise<{ haystack: string; names: string[] }> {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);
  const parts: string[] = [...names];
  for (const name of names) {
    const file = zip.file(name);
    if (!file || file.dir) continue;
    const bytes = await file.async('nodebuffer');
    // Two decodings so a marker stored as UTF-8 text or as raw Latin-1 bytes both hit.
    parts.push(bytes.toString('utf8'), bytes.toString('latin1'));
  }
  return { haystack: parts.join('\n'), names };
}

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      into.add(k);
      collectKeys(v, into);
    }
  }
}

describe('publish export canary — no private identifier or content survives (issue #586)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let playerUserId: number;
  let attachmentId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: M.dmUsername, password: 'dm-password-1' });

    const createPlayer = await dmAgent
      .post('/api/v1/users')
      .send({ username: M.playerUsername, password: 'player-password-1', displayName: M.playerDisplayName, serverRole: 'user' });
    playerUserId = createPlayer.body.id;

    playerAgent = request.agent(server);
    await playerAgent.post('/api/v1/auth/login').send({ username: M.playerUsername, password: 'player-password-1' });

    const camp = await dmAgent.post('/api/v1/campaigns').send({ name: 'Canary Publish Campaign' });
    campaignId = camp.body.id;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerUserId, role: 'player' });

    // World content — the part that SHOULD survive, plus a DM secret that should not.
    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .send({ title: 'The Sunken Bell', body: 'A bell tolls beneath the lake.', dmSecret: M.dmSecret });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: UNREVEALED_QUEST_TITLE, hidden: true });
    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .send({ name: 'Bell Warden', body: `Contact the caretaker at ${M.playerEmailish}.` });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/locations`).send({ name: 'Drowned Belfry' });
    const encounter = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Bell Ambush' });
    await dmAgent.post(`/api/v1/encounters/${encounter.body.id}/combatants`).send({ kind: 'monster', name: 'Deep Toll', hpMax: 30 });

    // Session + attendance + a played recap that names the player's display name.
    const session = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .send({ number: 1, recap: `${M.playerDisplayName} rang the bell.`, dmSecret: M.dmSecret });
    const character = await playerAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Bellringer Vex' });
    await dmAgent.put(`/api/v1/sessions/${session.body.id}/attendance`).send({ characterIds: [character.body.id] });

    // Notes: private (DM's own), whisper (DM → player), and a party-shared note.
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/notes`).send({ body: M.privateNote, visibility: 'private' });
    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: M.whisperBody, visibility: 'whisper', recipientUserId: String(playerUserId) });
    await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'The bell answers to salt water.', visibility: 'party_shared' });

    // Player-submitted proposal (?proposed=true stages the write for DM review).
    const proposed = await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/npcs?proposed=true`)
      .send({ name: M.proposalText, body: M.proposalText });
    expect(proposed.status).toBe(202);

    // Scheduling + RSVP.
    const schedule = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .send({ scheduledAt: '2099-06-15T18:00:00.000Z', title: 'Bell night', location: M.scheduleLocation });
    await playerAgent.put(`/api/v1/schedule/${schedule.body.id}/rsvp`).send({ status: 'yes', note: M.rsvpNote });

    // Dice log.
    await playerAgent.post(`/api/v1/campaigns/${campaignId}/roll`).send({ expr: '1d20', label: M.diceLabel });

    // Comment (player-authored discussion).
    await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'campaign', entityId: campaignId, body: `Ping ${M.playerDisplayName} about this.` });

    // Attachment: identity-bearing FILENAME and identity-bearing PNG tEXt METADATA.
    const upload = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'map')
      .attach('file', pngWithTextChunk(M.pngTextChunk), { filename: M.attachmentFilename, contentType: 'image/png' });
    attachmentId = upload.body.id;
    await dmAgent.patch(`/api/v1/campaigns/${campaignId}`).send({ mapAttachmentId: attachmentId });

    // Audit-only marker: quest.update records the changed fields in the audit `detail`
    // (#161), so patch the marker in and then trash the quest. After this the ONLY
    // place the marker still lives is the audit trail.
    const auditQuest = await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Audit Probe' });
    await dmAgent.patch(`/api/v1/quests/${auditQuest.body.id}`).send({ body: M.auditDetail });
    await dmAgent.delete(`/api/v1/quests/${auditQuest.body.id}`);
    await dmAgent.patch(`/api/v1/campaigns/${campaignId}`).send({ description: 'A drowned belfry campaign.' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('backup profile still carries the private content (the canary proves the seed worked)', async () => {
    const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export?format=json`);
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    // Sanity: every marker that lives in the DATABASE is really present in a backup.
    for (const marker of [
      M.dmUsername, M.playerUsername, M.playerDisplayName, M.playerEmailish, M.dmSecret,
      M.whisperBody, M.privateNote, M.proposalText, M.rsvpNote, M.attachmentFilename,
      M.diceLabel, M.scheduleLocation, UNREVEALED_QUEST_TITLE, M.auditDetail,
    ]) {
      expect(serialized).toContain(marker);
    }
  });

  it('publish JSON export contains no canary marker and no identity-shaped key', async () => {
    const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export?format=json&profile=publish`);
    expect(res.status).toBe(200);
    expect(res.headers['x-campfire-export-profile']).toBe('publish');

    const serialized = JSON.stringify(res.body);
    for (const [name, marker] of Object.entries(M)) {
      expect(`${name}:${serialized.includes(marker)}`).toBe(`${name}:false`);
    }

    // Numeric user ids are too short to sweep for in prose, so the FIELD ALLOWLIST is
    // what has to keep them out — assert structurally.
    const keys = new Set<string>();
    collectKeys(res.body, keys);
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(`${forbidden}:${keys.has(forbidden)}`).toBe(`${forbidden}:false`);
    }

    // The world content a publishable module exists to carry DID survive — including
    // unrevealed entities, which under private-by-default are the bulk of a campaign.
    expect(serialized).toContain('The Sunken Bell');
    expect(serialized).toContain('Drowned Belfry');
    expect(serialized).toContain('Bell Ambush');
    expect(serialized).toContain(UNREVEALED_QUEST_TITLE);
    // …but the reveal-staging flag is DM-facing state and does not travel.
    expect(keys.has('hidden')).toBe(false);
    expect(keys.has('dmSecret')).toBe(false);
  });

  it('publish mdzip contains no canary marker in ANY entry name, file body, binary or manifest', async () => {
    const res = await dmAgent
      .get(`/api/v1/campaigns/${campaignId}/export?format=mdzip&profile=publish`)
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(200);

    const { haystack, names } = await flattenZip(res.body as Buffer);
    for (const [name, marker] of Object.entries(M)) {
      expect(`${name}:${haystack.includes(marker)}`).toBe(`${name}:false`);
    }

    // The player's numeric user id must not appear as a standalone JSON value either.
    const campaignJson = await (await JSZip.loadAsync(res.body as Buffer)).file('campaign.json')!.async('string');
    const keys = new Set<string>();
    collectKeys(JSON.parse(campaignJson), keys);
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(`${forbidden}:${keys.has(forbidden)}`).toBe(`${forbidden}:false`);
    }

    // Identity/operations files are not merely empty — they are absent.
    for (const absent of ['members.md', 'audit.md', 'dice-rolls.md', 'ai.md', 'inventory.md']) {
      expect(names).not.toContain(absent);
    }
    expect(names.some((n) => n.startsWith('proposals/'))).toBe(false);
    expect(names.some((n) => n.startsWith('revisions/'))).toBe(false);
    expect(names.some((n) => n.startsWith('sessions/'))).toBe(false);
    expect(names.some((n) => n.startsWith('characters/'))).toBe(false);
    // World content is there.
    expect(names.some((n) => n.startsWith('quests/'))).toBe(true);
    expect(names).toContain('redaction.md');
  });

  it('publish archive strips PNG metadata but keeps a valid, renderable image', async () => {
    const res = await dmAgent
      .get(`/api/v1/campaigns/${campaignId}/export?format=mdzip&profile=publish`)
      .buffer(true)
      .parse(binaryParser);
    const zip = await JSZip.loadAsync(res.body as Buffer);
    const file = zip.file(`uploads/${attachmentId}.png`);
    expect(file).not.toBeNull();
    const bytes = await file!.async('nodebuffer');
    // Still a PNG…
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(bytes.toString('latin1')).toContain('IHDR');
    expect(bytes.toString('latin1')).toContain('IDAT');
    expect(bytes.toString('latin1')).toContain('IEND');
    // …with the text chunk gone.
    expect(bytes.toString('latin1')).not.toContain('tEXt');
    expect(bytes.toString('latin1')).not.toContain(M.pngTextChunk);
    // And the attachment's filename in the manifest is content-neutral.
    const manifest = JSON.parse(await zip.file('archive-manifest.json')!.async('string'));
    expect(manifest.secrecyProfile).toBe('publishable-module');
    expect(manifest.redaction.profile).toBe('publish');
    expect(manifest.redaction.attachments.metadataStripped).toBeGreaterThan(0);
  });

  it('publish opt-ins widen the archive but never re-admit identities', async () => {
    const res = await dmAgent
      .get(`/api/v1/campaigns/${campaignId}/export?format=mdzip&profile=publish&dmSecrets=true&playedState=true&playerContent=true`)
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(200);
    const { haystack, names } = await flattenZip(res.body as Buffer);

    // The three opt-ins bring back exactly what they promise…
    expect(haystack).toContain(M.dmSecret);
    expect(names.some((n) => n.startsWith('sessions/'))).toBe(true);
    expect(names.some((n) => n.startsWith('characters/'))).toBe(true);

    // …and NOTHING identity-shaped comes back with them.
    for (const marker of [
      M.dmUsername, M.playerUsername, M.playerDisplayName, M.playerEmailish,
      M.whisperBody, M.privateNote, M.proposalText, M.rsvpNote,
      M.attachmentFilename, M.pngTextChunk, M.auditDetail, M.diceLabel, M.scheduleLocation,
    ]) {
      expect(haystack).not.toContain(marker);
    }
    for (const absent of ['members.md', 'audit.md', 'dice-rolls.md']) {
      expect(names).not.toContain(absent);
    }
  });
});

describe('export profiles — handoff and preview (issue #586)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let playerUserId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'handoff-dm-9f50', password: 'dm-password-1' });
    const player = await dmAgent
      .post('/api/v1/users')
      .send({ username: 'handoff-player-9f51', password: 'player-password-1', displayName: 'Handoff Player 9f52', serverRole: 'user' });
    playerUserId = player.body.id;
    playerAgent = request.agent(server);
    await playerAgent.post('/api/v1/auth/login').send({ username: 'handoff-player-9f51', password: 'player-password-1' });

    const camp = await dmAgent.post('/api/v1/campaigns').send({ name: 'Handoff Campaign' });
    campaignId = camp.body.id;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerUserId, role: 'player' });

    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .send({ title: 'Inherited Quest', dmSecret: 'the new DM needs this' });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/sessions`).send({ number: 1, recap: 'The party arrived at the gate.' });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/notes`).send({ body: 'dm prep note', visibility: 'dm_shared' });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/notes`).send({ body: 'second dm prep note', visibility: 'dm_shared' });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/notes`).send({ body: 'my own private thought', visibility: 'private' });
    await playerAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Inherited Hero' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('handoff keeps DM secrets and play state but drops identities and operational history', async () => {
    const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export?format=json&profile=handoff`);
    expect(res.status).toBe(200);
    const body = res.body;

    // Kept: the world, its secrets, and where the party got to.
    expect(body.quests[0].dmSecret).toBe('the new DM needs this');
    expect(body.sessions[0].recap).toBe('The party arrived at the gate.');
    expect(body.characters.some((c: { name: string }) => c.name === 'Inherited Hero')).toBe(true);
    expect(body.notes.some((n: { body: string }) => n.body === 'dm prep note')).toBe(true);

    // Dropped: identities, the paper trail, and one member's private prose.
    expect(body.members).toEqual([]);
    expect(body.audit).toEqual([]);
    expect(body.proposals).toEqual([]);
    expect(body.diceRolls).toEqual([]);
    expect(body.sessionAttendance).toEqual([]);
    expect(body.notes.some((n: { body: string }) => n.body === 'my own private thought')).toBe(false);

    // Retained authorship is pseudonymous and stable, never an id.
    const noteWithAuthor = body.notes.find((n: { authorPseudonym?: string }) => n.authorPseudonym);
    expect(noteWithAuthor.authorPseudonym).toMatch(/^Contributor [0-9a-f]{10}$/);
    expect(noteWithAuthor.authorUserId).toBeUndefined();
    expect(noteWithAuthor.authorName).toBeUndefined();

    expect(body.redaction.profile).toBe('handoff');
    expect(body.redaction.policy.memberIdentities).toBe(false);
    expect(body.redaction.policy.dmSecrets).toBe(true);
  });

  it('pseudonyms are stable inside one archive and unlinkable between two archives', async () => {
    const a = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export?format=json&profile=handoff`);
    const b = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export?format=json&profile=handoff`);

    const labelsA: string[] = a.body.notes.map((n: { authorPseudonym: string }) => n.authorPseudonym);
    const labelsB: string[] = b.body.notes.map((n: { authorPseudonym: string }) => n.authorPseudonym);
    expect(labelsA.length).toBeGreaterThan(1);

    // Same author on every DM-authored note inside ONE archive.
    expect(new Set(labelsA).size).toBe(1);
    expect(new Set(labelsB).size).toBe(1);
    // Different label across two exports of the same campaign — no cross-archive correlation.
    expect(labelsA[0]).not.toBe(labelsB[0]);
  });

  it('backup profile is unchanged and says so in its redaction disclosure', async () => {
    const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export?format=json`);
    expect(res.status).toBe(200);
    expect(res.body.members.length).toBeGreaterThan(0);
    expect(res.body.members[0].userId).toBeDefined();
    expect(res.body.notes.some((n: { body: string }) => n.body === 'my own private thought')).toBe(true);
    expect(res.body.redaction.profile).toBe('backup');
    expect(res.body.redaction.policy.memberIdentities).toBe(true);
    expect(res.body.redaction.limitations[0]).toMatch(/no redaction at all/i);
  });

  it('pre-export preview reports included and redacted rows without returning content', async () => {
    const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export/preview?profile=publish&format=mdzip`);
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('campaign-export-inventory');
    expect(res.body.profile).toBe('publish');

    type InventoryRow = { module: string; included: number; redacted: number; reason?: string; fieldsWithheld?: string[] };
    const byModule: Record<string, InventoryRow> = Object.fromEntries(
      (res.body.rows as InventoryRow[]).map((r) => [r.module, r]),
    );
    expect(byModule.members.included).toBe(0);
    expect(byModule.members.redacted).toBeGreaterThan(0);
    expect(byModule.members.reason).toMatch(/user ids/i);
    expect(byModule.quests.included).toBeGreaterThan(0);
    expect(byModule.quests.fieldsWithheld).toContain('dmSecret');
    expect(res.body.limitations.length).toBeGreaterThan(0);

    // The preview is a manifest, not a data leak: no campaign prose comes back.
    expect(JSON.stringify(res.body)).not.toContain('my own private thought');
    expect(JSON.stringify(res.body)).not.toContain('the new DM needs this');
  });

  it('rejects an unknown profile with 400 rather than silently falling back to backup', async () => {
    const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export?profile=everything`);
    expect(res.status).toBe(400);
    const preview = await dmAgent.get(`/api/v1/campaigns/${campaignId}/export/preview?profile=everything`);
    expect(preview.status).toBe(400);
  });

  it('a player cannot reach the preview or any profile export', async () => {
    expect((await playerAgent.get(`/api/v1/campaigns/${campaignId}/export/preview?profile=publish`)).status).toBe(403);
    expect((await playerAgent.get(`/api/v1/campaigns/${campaignId}/export?profile=publish`)).status).toBe(403);
  });
});

/** Guard against a lazy re-implementation: the canary PNG helper must really embed the chunk. */
describe('canary fixture sanity', () => {
  it('the seeded PNG genuinely carries its tEXt metadata', () => {
    const bytes = pngWithTextChunk(M.pngTextChunk);
    expect(bytes.toString('latin1')).toContain('tEXt');
    expect(bytes.toString('latin1')).toContain(M.pngTextChunk);
    expect(createHash('sha256').update(bytes).digest('hex')).toHaveLength(64);
  });
});
