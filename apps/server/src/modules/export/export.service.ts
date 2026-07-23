import { Injectable } from '@nestjs/common';
import JSZip from 'jszip';
import type { EncounterWithCombatants } from '@campfire/schema';
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

/** Filesystem/URL-safe slug for filenames — lowercase, alnum + hyphens. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/**
 * De-duplicating filename allocator (issue #530). JSZip's `folder.file(name, ...)`
 * silently overwrites an existing entry, so two NPCs named "Bob" collapse into a
 * single `bob.md` and one row of data is lost. This helper hands out distinct
 * names within a folder: the first "bob" gets `bob`, the second gets `bob-2`,
 * then `bob-3`, and so on.
 *
 * `seen` is a Set the caller owns (one per folder) so it tracks names across
 * successive calls. Returns the allocated base name (no extension) — the caller
 * appends `.md`. Deterministic ONLY insofar as the caller's iteration order is:
 * the `-2` suffix attaches to the second occurrence in that order. The markdown
 * loops below sort each entity list by id before allocating so the result is
 * reproducible regardless of the underlying DB row order (several list services
 * have no ORDER BY).
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

/**
 * Builds one human-readable warning line per slug that collided in a folder
 * (issue #530). `allocations` is the ordered list of [originalSlug, allocatedBase]
 * pairs the loop recorded — one entry per entity, in iteration order. A slug
 * appears in a warning only when it occurred 2+ times, and the filenames listed
 * are the ACTUAL bases uniqueFilename handed out for those occurrences — NOT a
 * reconstruction from the count. Reconstruction would lie when a real entity's
 * slug is itself a de-dup suffix (e.g. slugs `bob`, `bob`, `bob-2`: the allocator
 * hands out `bob`, `bob-3`, `bob-2`, but naive `bob, bob-2` reconstruction would
 * claim the second file is `bob-2` when it is actually `bob-3`). Tracking the
 * real allocations keeps the warning truthful in every case.
 */
function pushCollisionWarning(
  warnings: string[],
  label: string,
  allocations: Array<[originalSlug: string, allocatedBase: string]>,
): void {
  // Group the allocated bases by the ORIGINAL slug each entity passed in, keeping
  // insertion order so the filenames read in the order they were written.
  const bySlug = new Map<string, string[]>();
  for (const [slug, allocated] of allocations) {
    const list = bySlug.get(slug);
    if (list) list.push(allocated);
    else bySlug.set(slug, [allocated]);
  }
  for (const [slug, allocatedBases] of bySlug) {
    if (allocatedBases.length < 2) continue;
    // The warning names the SLUG (the slugified filename base), not the original
    // display name — multiple distinct display names can collapse to one slug
    // (case/punctuation), so naming the slug is the honest, unambiguous framing.
    warnings.push(
      `${allocatedBases.length} ${label}s shared the slug '${slug}' and were exported as ${allocatedBases.map((b) => `${b}.md`).join(', ')}.`,
    );
  }
}

@Injectable()
export class ExportService {
  constructor(
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
   * Renders the same export data as a zip of markdown files.
   *
   * Returns the zip buffer plus a `warnings` array (issue #530): one human-readable
   * line per folder where two or more entities shared a slug and would have silently
   * overwritten each other under the old `${slugify(name)}.md` scheme. The buffer is
   * what the controller streams as `application/zip`; the warnings are surfaced for
   * any caller (UI, MCP, future JSON-wrapped variant) to flag the collision. They are
   * also written into the archive as `warnings.txt` when non-empty, so a human
   * unzipping the download sees the note without a UI — and they never enter
   * `campaign.json`, which is the strict manifest POST /campaigns/import/archive
   * reads back, so the round-trip is untouched.
   */
  async buildMarkdownZip(campaignId: number, user: RequestUser): Promise<{ buffer: Buffer; warnings: string[] }> {
    const data = await this.buildExport(campaignId, user);
    const zip = new JSZip();
    const warnings: string[] = [];

    // Machine-readable manifest (issue #236): embed the full structured export as
    // campaign.json so the zip is round-trippable. The markdown files below are for
    // humans; campaign.json is what POST /campaigns/import/archive reads to recreate
    // every row, and it names each attachment's bytes under uploads/ (attachments[].file)
    // so maps/portraits come back with their references remapped rather than dropped.
    zip.file('campaign.json', JSON.stringify(data));

    zip.file('campaign.md', this.campaignMarkdown(data.campaign, data.notes));

    // Per-folder seen-sets drive uniqueFilename (issue #530): each folder de-dups
    // independently, so a quest and an NPC sharing a slug don't interfere. Each
    // loop also records its [originalSlug, allocatedBase] allocations so the
    // collision warning can name the ACTUAL filenames written (see
    // pushCollisionWarning for why reconstruction-from-counts would lie).
    //
    // Determinism: filename allocation (-2, -3 suffix assignment) is order-
    // dependent, and several list services return rows without a guaranteed
    // ORDER BY. Each list is sorted by id (a stable, monotonic key) before
    // allocation so the same campaign exports to the same filenames on every
    // run and across DB engines — the lowest-id entity keeps the bare slug,
    // the next collision gets -2, etc.
    const questsFolder = zip.folder('quests')!;
    const questsSeen = new Set<string>();
    const questsAllocated: Array<[string, string]> = [];
    for (const q of [...data.quests].sort((a, b) => a.id - b.id)) {
      const slug = slugify(q.title);
      const base = uniqueFilename(questsSeen, slug);
      questsAllocated.push([slug, base]);
      questsFolder.file(`${base}.md`, this.questMarkdown(q));
    }
    pushCollisionWarning(warnings, 'quest', questsAllocated);

    const npcsFolder = zip.folder('npcs')!;
    const npcsSeen = new Set<string>();
    const npcsAllocated: Array<[string, string]> = [];
    for (const n of [...data.npcs].sort((a, b) => a.id - b.id)) {
      const slug = slugify(n.name);
      const base = uniqueFilename(npcsSeen, slug);
      npcsAllocated.push([slug, base]);
      npcsFolder.file(`${base}.md`, this.npcMarkdown(n));
    }
    pushCollisionWarning(warnings, 'NPC', npcsAllocated);

    const locationsFolder = zip.folder('locations')!;
    const locationsSeen = new Set<string>();
    const locationsAllocated: Array<[string, string]> = [];
    for (const l of [...data.locations].sort((a, b) => a.id - b.id)) {
      const slug = slugify(l.name);
      const base = uniqueFilename(locationsSeen, slug);
      locationsAllocated.push([slug, base]);
      locationsFolder.file(`${base}.md`, this.locationMarkdown(l));
    }
    pushCollisionWarning(warnings, 'location', locationsAllocated);

    const sessionsFolder = zip.folder('sessions')!;
    const sessionsSeen = new Set<string>();
    const sessionsAllocated: Array<[string, string]> = [];
    for (const s of [...data.sessions].sort((a, b) => a.id - b.id)) {
      const slug = slugify(s.title || `session-${s.number}`);
      const base = uniqueFilename(sessionsSeen, slug);
      sessionsAllocated.push([slug, base]);
      sessionsFolder.file(`${base}.md`, this.sessionMarkdown(s));
    }
    pushCollisionWarning(warnings, 'session', sessionsAllocated);

    const charactersFolder = zip.folder('characters')!;
    const charactersSeen = new Set<string>();
    const charactersAllocated: Array<[string, string]> = [];
    for (const c of [...data.characters].sort((a, b) => a.id - b.id)) {
      const slug = slugify(c.name);
      const base = uniqueFilename(charactersSeen, slug);
      charactersAllocated.push([slug, base]);
      charactersFolder.file(`${base}.md`, this.characterMarkdown(c));
    }
    pushCollisionWarning(warnings, 'character', charactersAllocated);

    const encountersFolder = zip.folder('encounters')!;
    const encountersSeen = new Set<string>();
    const encountersAllocated: Array<[string, string]> = [];
    for (const e of [...data.encounters].sort((a, b) => a.id - b.id)) {
      const slug = slugify(e.name);
      const base = uniqueFilename(encountersSeen, slug);
      encountersAllocated.push([slug, base]);
      encountersFolder.file(`${base}.md`, this.encounterMarkdown(e));
    }
    pushCollisionWarning(warnings, 'encounter', encountersAllocated);

    // Issue #87: embed the actual attachment bytes (maps, portraits, images) under
    // uploads/ so the export is self-contained and its references resolve. A file
    // missing on disk is skipped (not fatal — same row-without-file case as #84) and
    // recorded in the manifest as skipped so the loss is visible, never silent.
    const skipped: typeof data.attachments = [];
    for (const a of data.attachments) {
      const bytes = this.attachments.readBytesIfPresent({ campaignId, id: a.id, mime: a.mime });
      if (bytes) {
        zip.file(a.file, bytes);
      } else {
        skipped.push(a);
      }
    }
    zip.file('attachments.md', this.attachmentsManifestMarkdown(data.campaign, data.characters, data.attachments, skipped));

    // Issue #530: surface filename collisions inside the archive itself. The
    // warnings are informational only — the structured campaign.json manifest is
    // what import reads, so distinct markdown filenames don't affect round-trip.
    if (warnings.length) {
      zip.file('warnings.txt', warnings.join('\n') + '\n');
    }

    return { buffer: await zip.generateAsync({ type: 'nodebuffer' }), warnings };
  }

  /**
   * Human-readable manifest cross-referencing every attachment to its embedded file
   * and to what points at it (the campaign map, or the characters whose portrait it
   * is), plus an explicit list of any files that were missing on disk and skipped.
   */
  private attachmentsManifestMarkdown(
    campaign: Awaited<ReturnType<CampaignsService['getOrThrow']>>,
    characters: Awaited<ReturnType<CharactersService['listForCampaign']>>,
    attachments: {
      id: number;
      kind: string;
      filename: string;
      mime: string;
      size: number;
      file: string;
      fileRoute: string;
      present: boolean;
    }[],
    skipped: { id: number; file: string; filename: string }[],
  ): string {
    const lines = ['# Attachments', ''];
    if (!attachments.length) {
      lines.push('_This campaign has no attachments._', '');
      return lines.join('\n');
    }
    lines.push(
      'Image bytes are embedded in this archive under `uploads/`. The table maps each',
      'attachment to its file and to what references it.',
      '',
      '| ID | Kind | Filename | File | Referenced by |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const a of attachments) {
      const refs: string[] = [];
      if (campaign.mapAttachmentId === a.id) refs.push('campaign map');
      for (const c of characters) {
        if (c.portraitUrl && c.portraitUrl.endsWith(a.fileRoute)) refs.push(`portrait: ${c.name}`);
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

  private campaignMarkdown(campaign: Awaited<ReturnType<CampaignsService['getOrThrow']>>, notes: Awaited<ReturnType<NotesService['listForCampaign']>>): string {
    const lines = [
      `# ${campaign.name}`,
      '',
      `- Status: ${campaign.status}`,
      `- Danger level: ${campaign.dangerLevel}`,
      `- Sessions played: ${campaign.sessionCount}`,
      '',
      '## Description',
      '',
      campaign.description || '_none_',
    ];
    if (notes.length) {
      lines.push('', '## Notes', '');
      for (const n of notes) {
        lines.push(`- **${n.authorName || n.authorUserId}** (${n.visibility}): ${n.body}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  private questMarkdown(q: Awaited<ReturnType<QuestsService['listForCampaignWithObjectives']>>[number]): string {
    const lines = [
      `# ${q.title}`,
      '',
      `- Status: ${q.status}`,
      `- Reward: ${q.reward || '_none_'}`,
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
    return lines.join('\n') + '\n';
  }

  private npcMarkdown(n: Awaited<ReturnType<NpcsService['listForCampaign']>>[number]): string {
    const lines = [
      `# ${n.name}`,
      '',
      `- Role: ${n.role || '_unknown_'}`,
      `- Disposition: ${n.disposition}`,
      '',
      '## Description',
      '',
      n.body || '_none_',
    ];
    if (n.dmSecret) {
      lines.push('', '## DM Secret', '', n.dmSecret);
    }
    return lines.join('\n') + '\n';
  }

  private locationMarkdown(l: Awaited<ReturnType<LocationsService['listForCampaign']>>[number]): string {
    const lines = [
      `# ${l.name}`,
      '',
      `- Kind: ${l.kind || '_unknown_'}`,
      `- Status: ${l.status}`,
      '',
      '## Description',
      '',
      l.body || '_none_',
    ];
    if (l.dmSecret) {
      lines.push('', '## DM Secret', '', l.dmSecret);
    }
    return lines.join('\n') + '\n';
  }

  private sessionMarkdown(s: Awaited<ReturnType<SessionsService['listRecapsForCampaign']>>[number]): string {
    const lines = [
      `# Session ${s.number}${s.title ? `: ${s.title}` : ''}`,
      '',
      `- Played at: ${s.playedAt ?? '_unrecorded_'}`,
      '',
      '## Recap',
      '',
      s.recap || '_none_',
    ];
    if (s.dmSecret) {
      lines.push('', '## DM Secret', '', s.dmSecret);
    }
    return lines.join('\n') + '\n';
  }

  private characterMarkdown(c: Awaited<ReturnType<CharactersService['listForCampaign']>>[number]): string {
    const lines = [
      `# ${c.name}`,
      '',
      `- Species: ${c.species || '_unknown_'}`,
      `- Class: ${c.className || '_unknown_'}`,
      `- Level: ${c.level}`,
      `- XP: ${c.xp}`,
      `- HP: ${c.hpCurrent}/${c.hpMax}`,
      `- AC: ${c.ac ?? '_unset_'}`,
      '',
      '## Notes',
      '',
      c.notes || '_none_',
    ];
    if (c.dmSecret) {
      lines.push('', '## DM Secret', '', c.dmSecret);
    }
    return lines.join('\n') + '\n';
  }

  private encounterMarkdown(e: EncounterWithCombatants): string {
    const lines = [
      `# ${e.name}`,
      '',
      `- Status: ${e.status}`,
      `- Round: ${e.round}`,
      '',
      '## Combatants',
      '',
    ];
    if (e.combatants.length) {
      lines.push('| Name | Kind | Initiative | HP | Conditions |', '| --- | --- | --- | --- | --- |');
      for (const c of e.combatants) {
        lines.push(
          `| ${c.name} | ${c.kind} | ${c.initiative ?? '_unrolled_'} | ${c.hpCurrent}/${c.hpMax} | ${c.conditions.length ? c.conditions.join(', ') : '_none_'} |`,
        );
      }
    } else {
      lines.push('_none_');
    }
    return lines.join('\n') + '\n';
  }
}
