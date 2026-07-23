import { Inject, Injectable } from '@nestjs/common';
import JSZip from 'jszip';
import { eq } from 'drizzle-orm';
import type { EncounterEvent, EncounterWithCombatants } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { aiDmSeats, aiScribeConfigs } from '../../db/schema';
import { CampaignsService } from '../campaigns/campaigns.service';
import { QuestsService } from '../quests/quests.service';
import { NpcsService } from '../npcs/npcs.service';
import { LocationsService } from '../locations/locations.service';
import { SessionsService } from '../sessions/sessions.service';
import { CharactersService } from '../characters/characters.service';
import { NotesService } from '../notes/notes.service';
import { CommentsService } from '../comments/comments.service';
import { MembersService } from '../membership/members.service';
import { AuditService } from '../audit/audit.service';
import { ProposalsService } from '../proposals/proposals.service';
import { EncountersService } from '../encounters/encounters.service';
import { AttachmentsService, ALLOWED_MIME_TO_EXT } from '../attachments/attachments.service';
import { FactionsService } from '../factions/factions.service';
import { StorylinesService } from '../storylines/storylines.service';
import { TimelineService } from '../timeline/timeline.service';
import { SessionZeroService } from '../session-zero/session-zero.service';
import { SupportPreferencesService } from '../session-zero/support-preferences.service';
import { InventoryService } from '../inventory/inventory.service';
import { RevisionsService } from '../revisions/revisions.service';
import type { RequestUser } from '../../common/user.types';
import {
  archiveDisplayStem,
  archiveRecordFilename,
  buildMarkdownArchiveManifest,
  sha256Hex,
  stemCollisionWarnings,
  typedRecordId,
  type ArchiveModuleRepresentation,
  type ArchiveRecordEntry,
  type ArchiveTruncation,
} from './markdown-archive';

/** Filesystem/URL-safe ASCII slug for download filenames — lowercase, alnum + hyphens. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/**
 * De-duplicating filename allocator retained for callers that still need
 * order-based `-2` suffixes (issue #530). Markdown archive entity paths no
 * longer use this — issue #863 switched them to stable `{stem}__{type}-{id}.md`
 * names via {@link archiveRecordFilename}.
 */
export function uniqueFilename(seen: Set<string>, base: string): string {
  if (!seen.has(base)) {
    seen.add(base);
    return base;
  }
  let n = 2;
  while (seen.has(`${base}-${n}`)) n += 1;
  const name = `${base}-${n}`;
  seen.add(name);
  return name;
}

/** Re-export path helpers so unit tests can import from the service module. */
export { archiveDisplayStem, archiveRecordFilename, typedRecordId } from './markdown-archive';

type ExportData = Awaited<ReturnType<ExportService['buildExport']>>;

@Injectable()
export class ExportService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly campaigns: CampaignsService,
    private readonly quests: QuestsService,
    private readonly npcs: NpcsService,
    private readonly locations: LocationsService,
    private readonly sessions: SessionsService,
    private readonly characters: CharactersService,
    private readonly notes: NotesService,
    private readonly comments: CommentsService,
    private readonly members: MembersService,
    private readonly audit: AuditService,
    private readonly proposals: ProposalsService,
    private readonly encounters: EncountersService,
    private readonly attachments: AttachmentsService,
    private readonly factions: FactionsService,
    private readonly storylines: StorylinesService,
    private readonly timeline: TimelineService,
    private readonly sessionZero: SessionZeroService,
    private readonly supportPreferences: SupportPreferencesService,
    private readonly inventory: InventoryService,
    private readonly revisions: RevisionsService,
  ) {}

  /** Archive-relative path an attachment's bytes live at inside a zip export. */
  private attachmentArchivePath(row: { id: number; mime: string }): string {
    const ext = ALLOWED_MIME_TO_EXT[row.mime] ?? 'bin';
    return `uploads/${row.id}.${ext}`;
  }

  /**
   * Full campaign export as the requesting dm sees it: dmSecret fields
   * included (role='dm' throughout), notes limited to what's visible to
   * THIS dm (party_shared + dm_shared + their own private notes — other
   * members' private notes are excluded, same rule as GET /notes).
   */
  async buildExport(campaignId: number, user: RequestUser) {
    const role = 'dm' as const;

    const [
      campaign,
      questList,
      npcList,
      locationList,
      sessionList,
      characterList,
      noteList,
      commentList,
      memberList,
      auditList,
      proposalList,
      encounterList,
      attachmentRows,
      // Issue #266: entity types the export previously dropped WHOLESALE. A DM's
      // backup/migration lost every one of these silently; they now travel with the
      // export (full DM view — dmSecret fields included, same role='dm' as above).
      factionList,
      storyArcList,
      timelineEventList,
      timelineCalendar,
      sessionZero,
      inventoryList,
      treasury,
      revisionList,
    ] = await Promise.all([
      this.campaigns.getOrThrow(campaignId),
      this.quests.listForCampaignWithObjectives(campaignId, role),
      this.npcs.listForCampaign(campaignId, role),
      this.locations.listForCampaign(campaignId, role),
      // Full recaps — an export must carry the complete session bodies, not the
      // dashboard's list-shape excerpts (issue #71).
      this.sessions.listRecapsForCampaign(campaignId, role),
      this.characters.listForCampaign(campaignId, role),
      this.notes.listForCampaign(campaignId, user, role, {}),
      this.comments.listForCampaign(campaignId, role),
      this.members.listForCampaign(campaignId),
      this.audit.listForCampaign(campaignId, 500),
      this.proposals.listForCampaign(campaignId, undefined, role),
      this.encounters.listForCampaign(campaignId),
      this.attachments.listRowsForCampaign(campaignId),
      this.factions.listForCampaign(campaignId, role),
      // Arcs carry their nested beats and each beat its branches — the whole
      // storyline graph (issue #27) in one shape so import can rebuild the tree.
      this.storylines.listArcsWithBeats(campaignId),
      this.timeline.listEvents(campaignId, role),
      this.timeline.getCalendar(campaignId),
      this.sessionZero.get(campaignId),
      this.inventory.listForCampaign(campaignId),
      this.inventory.getTreasury(campaignId),
      // Issue #813: immutable prose versions (author + replacer provenance), including tips.
      this.revisions.listForCampaign(campaignId),
    ]);

    // Attachment manifest (issue #87): the export used to reference attachment ids
    // (campaign.mapAttachmentId) and portrait URLs (character.portraitUrl) that only
    // resolved against the source install. We now enumerate every attachment as
    // metadata, marking which files are actually present on disk (a missing file is a
    // known row-without-file shape — see #84 — and is flagged, not fatal). The zip
    // export additionally embeds the bytes under the `file` path below.
    const attachments = attachmentRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      filename: row.filename,
      mime: row.mime,
      size: row.size,
      createdAt: row.createdAt,
      /** Archive-relative path the bytes are stored at in the mdzip export. */
      file: this.attachmentArchivePath(row),
      /** Resolved GET route the source install's portraitUrl points at, for cross-referencing. */
      fileRoute: `/api/v1/attachments/${row.id}/file`,
      /** false when the bytes are missing on disk — reference is dangling, byte embed skipped. */
      present: this.attachments.hasBytesOnDisk(row),
    }));

    // Encounters need their combatants too (listForCampaign only returns the bare
    // Encounter rows) — fetch each one's full detail in parallel.
    const encountersWithCombatants: EncounterWithCombatants[] = await Promise.all(
      encounterList.map((e) => this.encounters.getWithCombatantsOrThrow(e.id)),
    );

    // AI seat + scribe config (issue #1078): export the DM's hand-authored steering
    // and trigger settings. Runtime counters (tokensUsed, turnCount, lastTurnAt) and
    // provider keys (aiProviderConfigs — encrypted, install-specific) are excluded.
    const [[aiSeatRow], [aiScribeConfigRow]] = await Promise.all([
      this.db.select().from(aiDmSeats).where(eq(aiDmSeats.campaignId, campaignId)).limit(1),
      this.db.select().from(aiScribeConfigs).where(eq(aiScribeConfigs.campaignId, campaignId)).limit(1),
    ]);

    // members "sans anything sensitive" — CampaignMember already carries no
    // password/session data, but drop nothing further needed; kept explicit
    // here in case that shape grows sensitive fields later.
    const members = memberList.map((m) => ({
      id: m.id,
      campaignId: m.campaignId,
      userId: m.userId,
      role: m.role,
      characterId: m.characterId,
      username: m.username,
      displayName: m.displayName,
      disabled: m.disabled,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));

    return {
      campaign,
      quests: questList,
      npcs: npcList,
      locations: locationList,
      sessions: sessionList,
      characters: characterList,
      notes: noteList,
      comments: commentList,
      members,
      audit: auditList,
      proposals: proposalList,
      encounters: encountersWithCombatants,
      // Issue #266: these were silently omitted before — a DM's export/backup lost
      // factions, the storyline graph, the timeline (events + current in-world date),
      // the session-zero charter, and party inventory/treasury entirely. Now carried
      // and re-imported (campaigns.service.ts importCampaign) with fresh, remapped ids.
      factions: factionList,
      storyArcs: storyArcList,
      timelineEvents: timelineEventList,
      timelineCalendar,
      sessionZero,
      inventory: inventoryList,
      treasury,
      // Issue #813: version authorship + replacer metadata round-trips with remapped ids.
      revisions: revisionList,
      // Issue #1078: AI seat + scribe config (DM-authored steering, NOT runtime counters or provider keys).
      aiSeat: aiSeatRow
        ? {
            mode: aiSeatRow.mode,
            enabled: aiSeatRow.enabled,
            model: aiSeatRow.model,
            instructions: aiSeatRow.instructions,
            tokenBudget: aiSeatRow.tokenBudget,
          }
        : null,
      aiScribeConfig: aiScribeConfigRow
        ? {
            postSession: aiScribeConfigRow.postSession,
            cron: aiScribeConfigRow.cron,
            budgetPerRun: aiScribeConfigRow.budgetPerRun,
          }
        : null,
      attachments,
      attachmentsNote:
        'campaign.mapAttachmentId references attachments[].id; each character.portraitUrl ' +
        'ends in attachments[].fileRoute. This JSON document carries attachment METADATA only — ' +
        'the raw image bytes are NOT embedded here. Export with format=mdzip to obtain a zip whose ' +
        'uploads/ folder holds the actual files at attachments[].file. Entries with present=false ' +
        'have no file on disk (dangling reference); their bytes are omitted from every export format.',
      participantSupportNote:
        'Participant-owned access-support preferences are intentionally excluded from campaign exports, imports, ' +
        'and clones. Each participant can export their own submission with GET /campaigns/:id/export/me; full-server ' +
        'backup/restore preserves the database rows and ownership.',
    };
  }

  /**
   * Member-scoped export (issue #128 player data rights): the data a SINGLE
   * member authored / owns in a campaign, so a player can take THEIR OWN copy
   * without the DM's campaign-wide export (which is dm-only and exposes every
   * member's private notes + dmSecret fields). Deliberately narrow:
   *
   *  - characters they own (characters.ownerUserId === their id),
   *  - notes they can see that are THEIRS (authorUserId === their id — reuses
   *    NotesService's own `mine` filter, so visibility rules still apply),
   *  - proposals they submitted (proposer === their id).
   *
   * No dmSecret, no other members' data, no audit/members roster. `role` is the
   * caller's effective role, threaded through to the character/notes services so
   * a dm calling their own member export sees the same owner-scoped slice.
   */
  async buildMemberExport(campaignId: number, user: RequestUser, role: 'dm' | 'player' | 'viewer') {
    const [campaign, characterList, noteList, commentList, proposalList, supportPreference] = await Promise.all([
      this.campaigns.getOrThrow(campaignId),
      this.characters.listForCampaign(campaignId, role),
      this.notes.listForCampaign(campaignId, user, role, { mine: true }),
      this.comments.listForCampaign(campaignId, role, { authorUserId: user.id }),
      this.proposals.listForCampaign(campaignId, undefined, role, { proposerUserId: user.id }),
      this.supportPreferences.getOwn(campaignId, user.id),
    ]);

    const ownCharacters = characterList.filter((c) => c.ownerUserId === user.id);
    // Already scoped + projected for the caller's role (#817); keep the list as-is.
    const ownProposals = proposalList;
    const ownComments = commentList;

    return {
      campaign: { id: campaign.id, name: campaign.name, description: campaign.description, status: campaign.status },
      exportedFor: { userId: user.id, name: user.name, role },
      characters: ownCharacters,
      notes: noteList,
      comments: ownComments,
      proposals: ownProposals,
      supportPreference,
      note:
        'This is a MEMBER-scoped export — only the characters and support preference you own, the notes and comments ' +
        'you authored, and the proposals you submitted in this campaign. It intentionally excludes DM secrets, other members’ ' +
        'private data, and the campaign-wide bundle (that export is DM-only).',
    };
  }

  /** Filename for a member's own-data export — includes the member id so multiple members' files don't collide. */
  memberExportFilename(campaignName: string, userId: string): string {
    const slug = slugify(campaignName);
    const date = new Date().toISOString().slice(0, 10);
    return `campfire-${slug}-member-${slugify(userId)}-${date}.json`;
  }

  exportFilename(campaignName: string, extension: 'json' | 'zip'): string {
    const slug = slugify(campaignName);
    const date = new Date().toISOString().slice(0, 10);
    return `campfire-${slug}-${date}.${extension}`;
  }

  /**
   * Renders the same export data as a zip of markdown files (issue #863).
   *
   * Entity paths use collision-proof `{stem}__{type}-{id}.md` names that preserve
   * Unicode display stems. A versioned `archive-manifest.json` records app/schema
   * version, secrecy profile, per-type counts, checksums, exclusions/truncations,
   * and asserts every machine-export module is represented or declared excluded.
   *
   * Returns `{ buffer, warnings }`: warnings are informational (shared display
   * stems, skipped attachment bytes) and also written as `warnings.txt` when
   * non-empty. They never enter `campaign.json` (the import round-trip payload).
   */
  async buildMarkdownZip(campaignId: number, user: RequestUser): Promise<{ buffer: Buffer; warnings: string[] }> {
    const data = await this.buildExport(campaignId, user);
    const zip = new JSZip();
    const warnings: string[] = [];
    const fileChecksums: Record<string, string> = {};
    const records: ArchiveRecordEntry[] = [];

    const writeFile = (path: string, content: string | Buffer) => {
      zip.file(path, content);
      if (typeof content === 'string') {
        fileChecksums[path] = sha256Hex(content);
      } else {
        fileChecksums[path] = sha256Hex(content);
      }
    };

    const writeRecord = (
      folder: string,
      type: string,
      id: number | string,
      name: string,
      content: string,
      stemAllocations?: Array<{ stem: string; filename: string }>,
    ) => {
      const filename = archiveRecordFilename(type, id, name);
      const path = `${folder}/${filename}`;
      writeFile(path, content);
      records.push({ type, id, path, checksum: fileChecksums[path] });
      stemAllocations?.push({ stem: archiveDisplayStem(name), filename });
    };

    // Machine-readable manifest (issue #236): embed the full structured export as
    // campaign.json so the zip is round-trippable. The markdown files below are for
    // humans; campaign.json is what POST /campaigns/import/archive reads to recreate
    // every row, and it names each attachment's bytes under uploads/ (attachments[].file)
    // so maps/portraits come back with their references remapped rather than dropped.
    const campaignJson = JSON.stringify(data);
    zip.file('campaign.json', campaignJson);

    // Backlink index: notes/comments anchored to entities, plus NPC→faction membership.
    const backlinks = this.buildBacklinkIndex(data);

    writeFile('campaign.md', this.campaignMarkdown(data.campaign, data.notes));

    const questAlloc: Array<{ stem: string; filename: string }> = [];
    for (const q of [...data.quests].sort((a, b) => a.id - b.id)) {
      writeRecord('quests', 'quest', q.id, q.title, this.questMarkdown(q, backlinks), questAlloc);
    }
    warnings.push(...stemCollisionWarnings('quest', questAlloc));

    const npcAlloc: Array<{ stem: string; filename: string }> = [];
    for (const n of [...data.npcs].sort((a, b) => a.id - b.id)) {
      writeRecord('npcs', 'npc', n.id, n.name, this.npcMarkdown(n, backlinks), npcAlloc);
    }
    warnings.push(...stemCollisionWarnings('NPC', npcAlloc));

    const locationAlloc: Array<{ stem: string; filename: string }> = [];
    for (const l of [...data.locations].sort((a, b) => a.id - b.id)) {
      writeRecord('locations', 'location', l.id, l.name, this.locationMarkdown(l, backlinks), locationAlloc);
    }
    warnings.push(...stemCollisionWarnings('location', locationAlloc));

    const sessionAlloc: Array<{ stem: string; filename: string }> = [];
    for (const s of [...data.sessions].sort((a, b) => a.id - b.id)) {
      const name = s.title || `Session ${s.number}`;
      writeRecord('sessions', 'session', s.id, name, this.sessionMarkdown(s, backlinks), sessionAlloc);
    }
    warnings.push(...stemCollisionWarnings('session', sessionAlloc));

    const characterAlloc: Array<{ stem: string; filename: string }> = [];
    for (const c of [...data.characters].sort((a, b) => a.id - b.id)) {
      writeRecord('characters', 'character', c.id, c.name, this.characterMarkdown(c, backlinks), characterAlloc);
    }
    warnings.push(...stemCollisionWarnings('character', characterAlloc));

    // Encounter combat logs are markdown-only enrichment (not part of campaign.json).
    const encounterEvents = new Map<number, EncounterEvent[]>();
    const encounterEventChunk = 8;
    for (let i = 0; i < data.encounters.length; i += encounterEventChunk) {
      const chunk = data.encounters.slice(i, i + encounterEventChunk);
      await Promise.all(
        chunk.map(async (e) => {
          encounterEvents.set(e.id, await this.encounters.listEvents(e.id));
        }),
      );
    }

    const encounterAlloc: Array<{ stem: string; filename: string }> = [];
    for (const e of [...data.encounters].sort((a, b) => a.id - b.id)) {
      writeRecord(
        'encounters',
        'encounter',
        e.id,
        e.name,
        this.encounterMarkdown(e, encounterEvents.get(e.id) ?? [], backlinks),
        encounterAlloc,
      );
    }
    warnings.push(...stemCollisionWarnings('encounter', encounterAlloc));

    const factionAlloc: Array<{ stem: string; filename: string }> = [];
    for (const f of [...data.factions].sort((a, b) => a.id - b.id)) {
      writeRecord('factions', 'faction', f.id, f.name, this.factionMarkdown(f, backlinks), factionAlloc);
    }
    warnings.push(...stemCollisionWarnings('faction', factionAlloc));

    const storyAlloc: Array<{ stem: string; filename: string }> = [];
    for (const a of [...data.storyArcs].sort((x, y) => x.id - y.id)) {
      writeRecord('storylines', 'story-arc', a.id, a.title, this.storyArcMarkdown(a), storyAlloc);
    }
    warnings.push(...stemCollisionWarnings('story-arc', storyAlloc));

    writeFile('timeline.md', this.timelineCalendarMarkdown(data.timelineCalendar));
    const timelineAlloc: Array<{ stem: string; filename: string }> = [];
    for (const ev of [...data.timelineEvents].sort((a, b) => a.id - b.id)) {
      writeRecord('timeline-events', 'timeline-event', ev.id, ev.title, this.timelineEventMarkdown(ev), timelineAlloc);
    }
    warnings.push(...stemCollisionWarnings('timeline-event', timelineAlloc));

    writeFile('session-zero.md', this.sessionZeroMarkdown(data.sessionZero));
    writeFile('inventory.md', this.inventoryMarkdown(data.inventory, data.treasury));

    const noteAlloc: Array<{ stem: string; filename: string }> = [];
    for (const n of [...data.notes].sort((a, b) => a.id - b.id)) {
      const name = n.body.trim().slice(0, 60) || `note-${n.id}`;
      writeRecord('notes', 'note', n.id, name, this.noteMarkdown(n), noteAlloc);
    }
    warnings.push(...stemCollisionWarnings('note', noteAlloc));

    const commentAlloc: Array<{ stem: string; filename: string }> = [];
    for (const c of [...data.comments].sort((a, b) => a.id - b.id)) {
      const name = c.body.trim().slice(0, 60) || `comment-${c.id}`;
      writeRecord('comments', 'comment', c.id, name, this.commentMarkdown(c), commentAlloc);
    }
    warnings.push(...stemCollisionWarnings('comment', commentAlloc));

    writeFile('members.md', this.membersMarkdown(data.members));

    const truncations: ArchiveTruncation[] = [
      {
        module: 'audit',
        exported: data.audit.length,
        note: 'Latest 500 audit entries (AuditService.listForCampaign cap). Older rows are omitted from both campaign.json and audit.md.',
      },
    ];
    writeFile('audit.md', this.auditMarkdown(data.audit));

    const proposalAlloc: Array<{ stem: string; filename: string }> = [];
    for (const p of [...data.proposals].sort((a, b) => a.id - b.id)) {
      const name = `${p.entityType}-${p.entityId ?? 'new'}-${p.status}`;
      writeRecord('proposals', 'proposal', p.id, name, this.proposalMarkdown(p), proposalAlloc);
    }
    warnings.push(...stemCollisionWarnings('proposal', proposalAlloc));

    const revisionAlloc: Array<{ stem: string; filename: string }> = [];
    for (const r of [...data.revisions].sort((a, b) => a.id - b.id)) {
      const name = `${r.entityType}-${r.entityId}-${r.id}`;
      writeRecord('revisions', 'revision', r.id, name, this.revisionMarkdown(r), revisionAlloc);
    }
    warnings.push(...stemCollisionWarnings('revision', revisionAlloc));

    // Issue #87 / #863: embed attachment bytes; build references from every owner type
    // (campaign map, character portraits, encounter battle maps).
    const skipped: typeof data.attachments = [];
    for (const a of data.attachments) {
      const bytes = this.attachments.readBytesIfPresent({ campaignId, id: a.id, mime: a.mime });
      if (bytes) {
        zip.file(a.file, bytes);
        fileChecksums[a.file] = sha256Hex(bytes);
      } else {
        skipped.push(a);
        warnings.push(`Attachment ${a.id} (${a.filename}) missing on disk — bytes omitted from uploads/.`);
      }
    }
    writeFile(
      'attachments.md',
      this.attachmentsManifestMarkdown(data.campaign, data.characters, data.encounters, data.attachments, skipped),
    );

    const modules: Record<string, ArchiveModuleRepresentation> = {
      campaign: { kind: 'markdown-file', path: 'campaign.md' },
      quests: { kind: 'markdown-folder', path: 'quests/' },
      npcs: { kind: 'markdown-folder', path: 'npcs/' },
      locations: { kind: 'markdown-folder', path: 'locations/' },
      sessions: { kind: 'markdown-folder', path: 'sessions/' },
      characters: { kind: 'markdown-folder', path: 'characters/' },
      notes: { kind: 'markdown-folder', path: 'notes/' },
      comments: { kind: 'markdown-folder', path: 'comments/' },
      members: { kind: 'markdown-file', path: 'members.md' },
      audit: { kind: 'markdown-file', path: 'audit.md' },
      proposals: { kind: 'markdown-folder', path: 'proposals/' },
      encounters: { kind: 'markdown-folder', path: 'encounters/' },
      factions: { kind: 'markdown-folder', path: 'factions/' },
      storyArcs: { kind: 'markdown-folder', path: 'storylines/' },
      timelineEvents: { kind: 'markdown-folder', path: 'timeline-events/' },
      timelineCalendar: { kind: 'markdown-file', path: 'timeline.md' },
      sessionZero: { kind: 'markdown-file', path: 'session-zero.md' },
      inventory: { kind: 'embedded', path: 'inventory.md', note: 'Items listed in inventory.md' },
      treasury: { kind: 'embedded', path: 'inventory.md', note: 'Coin totals listed in inventory.md' },
      revisions: { kind: 'markdown-folder', path: 'revisions/' },
      attachments: { kind: 'markdown-file', path: 'attachments.md' },
      attachmentsNote: {
        kind: 'embedded',
        path: 'attachments.md',
        note: 'Human-readable attachment cross-reference; machine note lives in campaign.json',
      },
      participantSupportNote: {
        kind: 'excluded',
        reason:
          'Participant-owned access-support preferences are intentionally excluded from campaign exports; use GET /campaigns/:id/export/me or full-server backup.',
      },
    };

    const counts: Record<string, number> = {
      quests: data.quests.length,
      npcs: data.npcs.length,
      locations: data.locations.length,
      sessions: data.sessions.length,
      characters: data.characters.length,
      notes: data.notes.length,
      comments: data.comments.length,
      members: data.members.length,
      audit: data.audit.length,
      proposals: data.proposals.length,
      encounters: data.encounters.length,
      factions: data.factions.length,
      storyArcs: data.storyArcs.length,
      timelineEvents: data.timelineEvents.length,
      inventory: data.inventory.length,
      revisions: data.revisions.length,
      attachments: data.attachments.length,
      attachmentsPresent: data.attachments.filter((a) => a.present).length,
      attachmentsSkipped: skipped.length,
    };

    const manifest = buildMarkdownArchiveManifest({
      campaignId,
      counts,
      campaignJson,
      fileChecksums,
      modules,
      exclusions: [
        {
          module: 'participantSupportNote',
          reason:
            'Participant-owned access-support preferences are intentionally excluded from campaign exports; use GET /campaigns/:id/export/me or full-server backup.',
        },
      ],
      truncations,
      records: records.sort((a, b) => String(a.path).localeCompare(String(b.path))),
    });
    // Manifest is written last and is not checksummed against itself.
    zip.file('archive-manifest.json', JSON.stringify(manifest, null, 2));

    if (warnings.length) {
      zip.file('warnings.txt', warnings.join('\n') + '\n');
    }

    return { buffer: await zip.generateAsync({ type: 'nodebuffer' }), warnings };
  }

  private buildBacklinkIndex(data: ExportData): Map<string, string[]> {
    const index = new Map<string, string[]>();
    const push = (type: string, id: number | null | undefined, label: string) => {
      if (id == null) return;
      const key = typedRecordId(type, id);
      const list = index.get(key);
      if (list) list.push(label);
      else index.set(key, [label]);
    };

    for (const n of data.notes) {
      if (n.entityType && n.entityId != null) {
        push(n.entityType, n.entityId, `note:${n.id}`);
      }
    }
    for (const c of data.comments) {
      push(c.entityType, c.entityId, `comment:${c.id}`);
    }
    for (const n of data.npcs) {
      push('faction', n.factionId, `npc:${n.id} (${n.name})`);
      push('location', n.locationId, `npc:${n.id} (${n.name})`);
    }
    for (const l of data.locations) {
      push('location', l.parentId, `child-location:${l.id} (${l.name})`);
    }
    for (const q of data.quests) {
      push('quest', q.parentId, `subquest:${q.id} (${q.title})`);
    }
    for (const e of data.encounters) {
      push('location', e.locationId, `encounter:${e.id} (${e.name})`);
      push('quest', e.questId, `encounter:${e.id} (${e.name})`);
      push('session', e.sessionId, `encounter:${e.id} (${e.name})`);
      if (e.mapAttachmentId != null) {
        push('attachment', e.mapAttachmentId, `encounter-map:${e.id} (${e.name})`);
      }
    }
    for (const c of data.characters) {
      if (c.portraitUrl) {
        const match = /\/attachments\/(\d+)\/file/.exec(c.portraitUrl);
        if (match) push('attachment', Number(match[1]), `portrait:${c.id} (${c.name})`);
      }
    }
    if (data.campaign.mapAttachmentId != null) {
      push('attachment', data.campaign.mapAttachmentId, 'campaign-map');
    }
    return index;
  }

  private backlinkSection(type: string, id: number, backlinks: Map<string, string[]>): string[] {
    const refs = backlinks.get(typedRecordId(type, id));
    if (!refs?.length) return [];
    return ['', '## Backlinks', '', ...refs.map((r) => `- ${r}`)];
  }

  private identityHeader(type: string, id: number, title: string): string[] {
    return [
      `<!-- campfire:type=${type} id=${id} -->`,
      `# ${title}`,
      '',
      `- Typed ID: \`${typedRecordId(type, id)}\``,
    ];
  }

  /**
   * Human-readable manifest cross-referencing every attachment to its embedded file
   * and to what points at it — campaign map, character portraits, AND encounter
   * battle maps (issue #863).
   */
  private attachmentsManifestMarkdown(
    campaign: ExportData['campaign'],
    characters: ExportData['characters'],
    encounters: ExportData['encounters'],
    attachments: ExportData['attachments'],
    skipped: { id: number; file: string; filename: string }[],
  ): string {
    const lines = ['# Attachments', ''];
    if (!attachments.length) {
      lines.push('_This campaign has no attachments._', '');
      return lines.join('\n');
    }
    lines.push(
      'Image bytes are embedded in this archive under `uploads/`. The table maps each',
      'attachment to its file and to what references it (campaign map, character',
      'portraits, encounter battle maps).',
      '',
      '| ID | Kind | Filename | File | Referenced by |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const a of attachments) {
      const refs: string[] = [];
      if (campaign.mapAttachmentId === a.id) refs.push('campaign map');
      for (const c of characters) {
        if (c.portraitUrl && c.portraitUrl.endsWith(a.fileRoute)) refs.push(`portrait: ${c.name} (character:${c.id})`);
      }
      for (const e of encounters) {
        if (e.mapAttachmentId === a.id) refs.push(`encounter map: ${e.name} (encounter:${e.id})`);
      }
      const fileCell = a.present ? `\`${a.file}\`` : '_missing — skipped_';
      lines.push(`| ${a.id} | ${a.kind} | ${a.filename} | ${fileCell} | ${refs.length ? refs.join(', ') : '_unreferenced_'} |`);
    }
    if (skipped.length) {
      lines.push('', '## Skipped (file missing on disk)', '');
      for (const s of skipped) {
        lines.push(`- Attachment ${s.id} (${s.filename}) — expected at \`${s.file}\`, not present; bytes omitted.`);
      }
    }
    return lines.join('\n') + '\n';
  }

  private campaignMarkdown(campaign: ExportData['campaign'], notes: ExportData['notes']): string {
    const lines = [
      ...this.identityHeader('campaign', campaign.id, campaign.name),
      `- Status: ${campaign.status}`,
      `- Danger level: ${campaign.dangerLevel}`,
      `- Sessions played: ${campaign.sessionCount}`,
      `- Map attachment: ${campaign.mapAttachmentId != null ? `\`${typedRecordId('attachment', campaign.mapAttachmentId)}\`` : '_none_'}`,
      '',
      '## Description',
      '',
      campaign.description || '_none_',
    ];
    if (notes.length) {
      lines.push('', '## Notes', '', `_${notes.length} note(s) — see \`notes/\` for full bodies._`, '');
      for (const n of notes) {
        lines.push(`- \`${typedRecordId('note', n.id)}\` (${n.visibility}) by ${n.authorName || n.authorUserId}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  private questMarkdown(
    q: ExportData['quests'][number],
    backlinks: Map<string, string[]>,
  ): string {
    const lines = [
      ...this.identityHeader('quest', q.id, q.title),
      `- Status: ${q.status}`,
      `- Reward: ${q.reward || '_none_'}`,
      `- Parent: ${q.parentId != null ? `\`${typedRecordId('quest', q.parentId)}\`` : '_none_'}`,
      '',
      '## Description',
      '',
      q.body || '_none_',
    ];
    if (q.objectives.length) {
      lines.push('', '## Objectives', '');
      for (const o of q.objectives) {
        lines.push(`- [${o.done ? 'x' : ' '}] ${o.text}`);
      }
    }
    if (q.dmSecret) {
      lines.push('', '## DM Secret', '', q.dmSecret);
    }
    lines.push(...this.backlinkSection('quest', q.id, backlinks));
    return lines.join('\n') + '\n';
  }

  private npcMarkdown(
    n: ExportData['npcs'][number],
    backlinks: Map<string, string[]>,
  ): string {
    const lines = [
      ...this.identityHeader('npc', n.id, n.name),
      `- Role: ${n.role || '_unknown_'}`,
      `- Disposition: ${n.disposition}`,
      `- Location: ${n.locationId != null ? `\`${typedRecordId('location', n.locationId)}\`` : '_none_'}`,
      `- Faction: ${n.factionId != null ? `\`${typedRecordId('faction', n.factionId)}\`` : '_none_'}`,
      '',
      '## Description',
      '',
      n.body || '_none_',
    ];
    if (n.dmSecret) {
      lines.push('', '## DM Secret', '', n.dmSecret);
    }
    lines.push(...this.backlinkSection('npc', n.id, backlinks));
    return lines.join('\n') + '\n';
  }

  private locationMarkdown(
    l: ExportData['locations'][number],
    backlinks: Map<string, string[]>,
  ): string {
    const lines = [
      ...this.identityHeader('location', l.id, l.name),
      `- Kind: ${l.kind || '_unknown_'}`,
      `- Status: ${l.status}`,
      `- Parent: ${l.parentId != null ? `\`${typedRecordId('location', l.parentId)}\`` : '_none_'}`,
      '',
      '## Description',
      '',
      l.body || '_none_',
    ];
    if (l.dmSecret) {
      lines.push('', '## DM Secret', '', l.dmSecret);
    }
    lines.push(...this.backlinkSection('location', l.id, backlinks));
    return lines.join('\n') + '\n';
  }

  private sessionMarkdown(
    s: ExportData['sessions'][number],
    backlinks: Map<string, string[]>,
  ): string {
    const title = `Session ${s.number}${s.title ? `: ${s.title}` : ''}`;
    const lines = [
      ...this.identityHeader('session', s.id, title),
      `- Played at: ${s.playedAt ?? '_unrecorded_'}`,
      '',
      '## Recap',
      '',
      s.recap || '_none_',
    ];
    if (s.dmSecret) {
      lines.push('', '## DM Secret', '', s.dmSecret);
    }
    lines.push(...this.backlinkSection('session', s.id, backlinks));
    return lines.join('\n') + '\n';
  }

  private characterMarkdown(
    c: ExportData['characters'][number],
    backlinks: Map<string, string[]>,
  ): string {
    const lines = [
      ...this.identityHeader('character', c.id, c.name),
      `- Species: ${c.species || '_unknown_'}`,
      `- Class: ${c.className || '_unknown_'}`,
      `- Level: ${c.level}`,
      `- XP: ${c.xp}`,
      `- HP: ${c.hpCurrent}/${c.hpMax}`,
      `- AC: ${c.ac ?? '_unset_'}`,
      `- Portrait: ${c.portraitUrl || '_none_'}`,
      '',
      '## Notes',
      '',
      c.notes || '_none_',
    ];
    if (c.actions?.length) {
      lines.push('', '## Actions / Resources', '');
      lines.push('| Name | Kind | To hit | Damage | Notes |', '| --- | --- | --- | --- | --- |');
      for (const a of c.actions) {
        lines.push(`| ${a.name} | ${a.kind || '_'} | ${a.toHit || '_'} | ${a.damage || '_'} | ${a.notes || '_'} |`);
      }
    }
    const slotKeys = c.spellSlots ? Object.keys(c.spellSlots).sort() : [];
    if (slotKeys.length) {
      lines.push('', '## Spell slots', '');
      for (const level of slotKeys) {
        const slot = c.spellSlots[level];
        lines.push(`- Level ${level}: ${slot.used}/${slot.max} used`);
      }
    }
    if (c.dmSecret) {
      lines.push('', '## DM Secret', '', c.dmSecret);
    }
    lines.push(...this.backlinkSection('character', c.id, backlinks));
    return lines.join('\n') + '\n';
  }

  private encounterMarkdown(
    e: EncounterWithCombatants,
    events: EncounterEvent[],
    backlinks: Map<string, string[]>,
  ): string {
    const lines = [
      ...this.identityHeader('encounter', e.id, e.name),
      `- Status: ${e.status}`,
      `- Round: ${e.round}`,
      `- Location: ${e.locationId != null ? `\`${typedRecordId('location', e.locationId)}\`` : '_none_'}`,
      `- Quest: ${e.questId != null ? `\`${typedRecordId('quest', e.questId)}\`` : '_none_'}`,
      `- Session: ${e.sessionId != null ? `\`${typedRecordId('session', e.sessionId)}\`` : '_none_'}`,
      `- Map attachment: ${e.mapAttachmentId != null ? `\`${typedRecordId('attachment', e.mapAttachmentId)}\`` : '_none_'}`,
      '',
      '## Grid',
      '',
      `- Type: ${e.gridType}`,
      `- Size: ${e.gridSize ?? '_off_'}`,
      `- Scale: ${e.gridScale != null ? `${e.gridScale} ${e.gridUnit ?? ''}`.trim() : '_unset_'}`,
      `- Snap: ${e.gridSnap ? 'yes' : 'no'}`,
      '',
      '## Fog',
      '',
    ];
    if (e.fog) {
      lines.push(
        `- Enabled: ${e.fog.enabled ? 'yes' : 'no'}`,
        `- Revealed regions: ${e.fog.revealed.length}`,
        '',
        '```json',
        JSON.stringify(e.fog, null, 2),
        '```',
      );
    } else {
      lines.push('_none_');
    }

    lines.push('', '## Combatants', '');
    if (e.combatants.length) {
      lines.push(
        '| Name | Kind | Initiative | HP | Token | Conditions | Links |',
        '| --- | --- | --- | --- | --- | --- | --- |',
      );
      for (const c of e.combatants) {
        const token =
          c.tokenX != null && c.tokenY != null
            ? `${c.tokenX},${c.tokenY} (${c.tokenSize})`
            : '_unplaced_';
        const links = [
          c.characterId != null ? typedRecordId('character', c.characterId) : null,
          c.npcId != null ? typedRecordId('npc', c.npcId) : null,
        ]
          .filter(Boolean)
          .join(', ') || '_';
        lines.push(
          `| ${c.name} | ${c.kind} | ${c.initiative ?? '_unrolled_'} | ${c.hpCurrent}/${c.hpMax} | ${token} | ${c.conditions.length ? c.conditions.join(', ') : '_none_'} | ${links} |`,
        );
      }
    } else {
      lines.push('_none_');
    }

    lines.push('', '## Combat log', '');
    if (events.length) {
      for (const ev of events) {
        lines.push(
          `- R${ev.round} \`${ev.type}\` ${ev.actor ?? '_'} → ${ev.target ?? '_'}: ${ev.detail || '_'}`,
        );
      }
    } else {
      lines.push('_none_');
    }

    lines.push(...this.backlinkSection('encounter', e.id, backlinks));
    return lines.join('\n') + '\n';
  }

  private factionMarkdown(
    f: ExportData['factions'][number],
    backlinks: Map<string, string[]>,
  ): string {
    const lines = [
      ...this.identityHeader('faction', f.id, f.name),
      `- Kind: ${f.kind || '_unknown_'}`,
      `- Standing: ${f.standing}`,
      `- Reputation: ${f.reputation}`,
      '',
      '## Description',
      '',
      f.body || '_none_',
      '',
      '## Goals',
      '',
      f.goals || '_none_',
    ];
    if (f.dmSecret) {
      lines.push('', '## DM Secret', '', f.dmSecret);
    }
    lines.push(...this.backlinkSection('faction', f.id, backlinks));
    return lines.join('\n') + '\n';
  }

  private storyArcMarkdown(a: ExportData['storyArcs'][number]): string {
    const lines = [
      ...this.identityHeader('story-arc', a.id, a.title),
      `- Status: ${a.status}`,
      '',
      '## Summary',
      '',
      a.summary || '_none_',
      '',
      '## Beats',
      '',
    ];
    if (!a.beats.length) {
      lines.push('_none_');
    } else {
      for (const beat of [...a.beats].sort((x, y) => x.id - y.id)) {
        lines.push(`### ${beat.title} (\`${typedRecordId('story-beat', beat.id)}\`)`, '');
        lines.push(`- Status: ${beat.status}`);
        if (beat.sessionId != null) lines.push(`- Session: ${typedRecordId('session', beat.sessionId)}`);
        if (beat.questId != null) lines.push(`- Quest: ${typedRecordId('quest', beat.questId)}`);
        if (beat.encounterId != null) lines.push(`- Encounter: ${typedRecordId('encounter', beat.encounterId)}`);
        lines.push('', beat.body || '_none_', '');
        if (beat.branches?.length) {
          lines.push('Branches:', '');
          for (const br of beat.branches) {
            lines.push(`- ${br.label} → ${br.toBeatId != null ? typedRecordId('story-beat', br.toBeatId) : '_open_'}`);
          }
          lines.push('');
        }
      }
    }
    return lines.join('\n') + '\n';
  }

  private timelineCalendarMarkdown(cal: ExportData['timelineCalendar']): string {
    if (!cal) {
      return ['# Timeline calendar', '', '_No calendar configured._', ''].join('\n');
    }
    return [
      '# Timeline calendar',
      '',
      `- Campaign: ${typedRecordId('campaign', cal.campaignId)}`,
      `- Current in-world date: ${cal.currentDate || '_unset_'}`,
      '',
      '## Calendar note',
      '',
      cal.note || '_none_',
      '',
    ].join('\n');
  }

  private timelineEventMarkdown(ev: ExportData['timelineEvents'][number]): string {
    const lines = [
      ...this.identityHeader('timeline-event', ev.id, ev.title),
      `- In-world date: ${ev.inWorldDate || '_undated_'}`,
      `- Era: ${ev.era || '_none_'}`,
      `- Sort index: ${ev.sortIndex}`,
      '',
      '## Body',
      '',
      ev.body || '_none_',
    ];
    if (ev.dmSecret) {
      lines.push('', '## DM Secret', '', ev.dmSecret);
    }
    return lines.join('\n') + '\n';
  }

  private sessionZeroMarkdown(sz: ExportData['sessionZero']): string {
    if (!sz) {
      return ['# Session zero', '', '_No session-zero charter configured._', ''].join('\n');
    }
    const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '_none_');
    return [
      '# Session zero',
      '',
      `- Campaign: ${typedRecordId('campaign', sz.campaignId)}`,
      '',
      '## Lines',
      '',
      list(sz.lines),
      '',
      '## Veils',
      '',
      list(sz.veils),
      '',
      '## Safety tools',
      '',
      list(sz.safetyTools),
      '',
      '## House rules',
      '',
      sz.houseRules || '_none_',
      '',
      '## Tone & expectations',
      '',
      sz.toneAndExpectations || '_none_',
      '',
    ].join('\n');
  }

  private inventoryMarkdown(
    items: ExportData['inventory'],
    treasury: ExportData['treasury'],
  ): string {
    const lines = ['# Inventory & treasury', ''];
    if (treasury) {
      lines.push(
        '## Treasury',
        '',
        `- CP: ${treasury.cp}`,
        `- SP: ${treasury.sp}`,
        `- EP: ${treasury.ep}`,
        `- GP: ${treasury.gp}`,
        `- PP: ${treasury.pp}`,
        '',
      );
    } else {
      lines.push('## Treasury', '', '_none_', '');
    }
    lines.push('## Items', '');
    if (!items.length) {
      lines.push('_none_', '');
    } else {
      lines.push('| ID | Name | Qty | Owner | Notes |', '| --- | --- | --- | --- | --- |');
      for (const item of [...items].sort((a, b) => a.id - b.id)) {
        const owner =
          item.ownerType === 'character' && item.characterId != null
            ? typedRecordId('character', item.characterId)
            : 'party';
        lines.push(
          `| ${typedRecordId('inventory-item', item.id)} | ${item.name} | ${item.qty} | ${owner} | ${item.notes || '_'} |`,
        );
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  private noteMarkdown(n: ExportData['notes'][number]): string {
    return [
      ...this.identityHeader('note', n.id, `Note ${n.id}`),
      `- Visibility: ${n.visibility}`,
      `- Author: ${n.authorName || n.authorUserId}`,
      `- Anchor: ${n.entityType && n.entityId != null ? typedRecordId(n.entityType, n.entityId) : '_unanchored_'}`,
      '',
      '## Body',
      '',
      n.body || '_none_',
      '',
    ].join('\n');
  }

  private commentMarkdown(c: ExportData['comments'][number]): string {
    return [
      ...this.identityHeader('comment', c.id, `Comment ${c.id}`),
      `- Author: ${c.authorName || c.authorUserId}`,
      `- Anchor: ${typedRecordId(c.entityType, c.entityId)}`,
      `- Parent: ${c.parentId != null ? typedRecordId('comment', c.parentId) : '_none_'}`,
      `- In character: ${c.inCharacter ? 'yes' : 'no'}`,
      c.characterId != null ? `- Character: ${typedRecordId('character', c.characterId)}` : null,
      '',
      '## Body',
      '',
      c.body || '_none_',
      '',
    ]
      .filter((line): line is string => line != null)
      .join('\n');
  }

  private membersMarkdown(members: ExportData['members']): string {
    const lines = ['# Members', ''];
    if (!members.length) {
      lines.push('_none_', '');
      return lines.join('\n');
    }
    lines.push('| ID | User | Role | Character | Disabled |', '| --- | --- | --- | --- | --- |');
    for (const m of [...members].sort((a, b) => a.id - b.id)) {
      lines.push(
        `| ${typedRecordId('member', m.id)} | ${m.displayName || m.username || m.userId} | ${m.role} | ${m.characterId != null ? typedRecordId('character', m.characterId) : '_'} | ${m.disabled ? 'yes' : 'no'} |`,
      );
    }
    lines.push('');
    return lines.join('\n');
  }

  private auditMarkdown(audit: ExportData['audit']): string {
    const lines = [
      '# Audit log',
      '',
      '_Truncated to the latest 500 entries (see archive-manifest.json truncations)._',
      '',
    ];
    if (!audit.length) {
      lines.push('_none_', '');
      return lines.join('\n');
    }
    for (const row of audit) {
      lines.push(
        `- ${row.createdAt} \`${row.action}\` ${row.entityType ?? '_'} ${row.entityId ?? '_'} by ${row.actor ?? '_'} — ${row.detail || ''}`,
      );
    }
    lines.push('');
    return lines.join('\n');
  }

  private proposalMarkdown(p: ExportData['proposals'][number]): string {
    const entity =
      p.entityId != null ? typedRecordId(p.entityType, p.entityId) : `${p.entityType}:_pending-create_`;
    return [
      ...this.identityHeader('proposal', p.id, `Proposal ${p.id}`),
      `- Status: ${p.status}`,
      `- Action: ${p.action}`,
      `- Entity: ${entity}`,
      `- Proposer: ${p.proposer || p.proposerUserId}`,
      '',
      '## Payload',
      '',
      '```json',
      JSON.stringify(p.payload ?? {}, null, 2),
      '```',
      '',
    ].join('\n');
  }

  private revisionMarkdown(r: ExportData['revisions'][number]): string {
    return [
      ...this.identityHeader('revision', r.id, `Revision ${r.id}`),
      `- Entity: ${typedRecordId(r.entityType, r.entityId)}`,
      `- Author: ${r.authorName || r.authorUserId || '_unknown_'}`,
      r.replacedByUserId ? `- Replaced by: ${r.replacedByName || r.replacedByUserId}` : null,
      r.replacedAt ? `- Replaced at: ${r.replacedAt}` : '- Tip: current',
      '',
      '## Snapshot',
      '',
      '```json',
      JSON.stringify(r.snapshot ?? {}, null, 2),
      '```',
      '',
    ]
      .filter((line): line is string => line != null)
      .join('\n');
  }
}
