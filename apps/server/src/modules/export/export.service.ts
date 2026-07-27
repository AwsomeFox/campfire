import { Inject, Injectable } from '@nestjs/common';
import archiver from 'archiver';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform, type Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import type { EncounterEvent, EncounterWithCombatants } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { aiDmSeats, aiScribeConfigs, aiScribeJobs } from '../../db/schema';
import { loadCompendiumExportContext } from '../campaigns/compendium-import';
import { CampaignsService } from '../campaigns/campaigns.service';
import { QuestsService } from '../quests/quests.service';
import { NpcsService } from '../npcs/npcs.service';
import { LocationsService } from '../locations/locations.service';
import { SessionsService } from '../sessions/sessions.service';
import { SchedulingService } from '../sessions/scheduling.service';
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
import { RollsService, DEFAULT_DICE_ROLLS_RETENTION } from '../rolls/rolls.service';
import type { RequestUser } from '../../common/user.types';
import {
  archiveDisplayStem,
  archiveRecordFilename,
  buildMarkdownArchiveManifest,
  sha256Hex,
  stemCollisionWarnings,
  typedRecordId,
  type ArchiveExclusion,
  type ArchiveModuleRepresentation,
  type ArchiveRecordEntry,
  type ArchiveRedactionDisclosure,
  type ArchiveTruncation,
} from './markdown-archive';
import {
  DEFAULT_EXPORT_PROFILE,
  EXPORT_INVENTORY_FORMAT_VERSION,
  bytesContainIdentifier,
  exportLimitations,
  partitionIdentifiers,
  redactIdentifiers,
  resolveExportPolicy,
  type ExportAttachmentInventory,
  type ExportInventory,
  type ExportProfile,
  type ExportProfileOptions,
  type ResolvedExportPolicy,
} from './export-profiles';
import { MODULE_EXCLUSION_REASONS, collectPrivateIdentifiers, projectExport, type ExportProjection } from './export-redaction';
import { SANITIZABLE_MIMES, stripImageMetadata } from './image-metadata';

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

function jsonOrNull(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Re-export path helpers so unit tests can import from the service module. */
export { archiveDisplayStem, archiveRecordFilename, typedRecordId } from './markdown-archive';

type ExportData = Awaited<ReturnType<ExportService['buildExport']>>;

/**
 * Shape the markdown renderers actually receive (issue #586). A redacted profile
 * WITHHOLDS fields (author ids, dmSecret, played state) and ADDS per-export
 * pseudonyms, so every renderer must treat identity fields as optional. The
 * structural type below documents that instead of relying on renderer-local casts.
 */
type ProfileExportData = Omit<ExportData, 'notes' | 'comments' | 'characters' | 'attachments'> & {
  notes: Array<ExportData['notes'][number] & { authorPseudonym?: string }>;
  comments: Array<ExportData['comments'][number] & { authorPseudonym?: string }>;
  characters: Array<ExportData['characters'][number] & { ownerPseudonym?: string }>;
  attachments: Array<ExportData['attachments'][number] & { originalFilenameWithheld?: boolean }>;
};

/** Per-attachment decision taken while assembling a redacted archive. */
type AttachmentByteDecision = {
  id: number;
  bytes: Buffer | null;
  /** Bytes passed policy inspection but were deliberately not retained (preview only). */
  available?: boolean;
  /** Original immutable attachment source, used only by the streaming backup path. */
  sourcePath?: string;
  /** Present when sourcePath was already staged from sanitized bytes. */
  sourceChecksum?: string;
  /** Set when bytes were withheld — surfaced in warnings.txt and the inventory. */
  withheldReason?: string;
  metadataStripped: boolean;
};

type MarkdownZipWriter = {
  file(path: string, content: string | Buffer): void;
  /** Deliberately distinct from `file`: streaming exports hand archiver a pathname. */
  attachment?(path: string, content: Buffer): void;
  stageAttachment?(content: Buffer): { path: string; checksum: string };
  /** Stages a live source before any archive entries are appended. */
  stageLiveAttachment?(source: string): Promise<{ path: string; checksum: string }>;
  attachmentPath?(
    path: string,
    source: string,
    stagedChecksum?: string,
  ): Promise<{ path: string; checksum: string }>;
};

export type ProfileExportResult = {
  data: Record<string, unknown>;
  policy: ResolvedExportPolicy;
  inventory: ExportInventory;
};

@Injectable()
export class ExportService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly campaigns: CampaignsService,
    private readonly quests: QuestsService,
    private readonly npcs: NpcsService,
    private readonly locations: LocationsService,
    private readonly sessions: SessionsService,
    private readonly scheduling: SchedulingService,
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
    private readonly rolls: RollsService,
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

    // Issue #731: capture the audit trail from a stable id ceiling BEFORE the rest of
    // the export payload is read, so concurrent writes during export show up only in
    // auditMeta.truncated — never as silently missing rows inside the snapshot.
    const auditExport = await this.audit.listForCampaignExport(campaignId);

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
      scheduledSessionList,
      sessionAttendanceList,
      diceRollList,
    ] = await Promise.all([
      this.campaigns.getOrThrow(campaignId),
      this.quests.listForCampaignWithObjectives(campaignId, role),
      this.npcs.listForCampaign(campaignId, role),
      this.locations.listForCampaign(campaignId, role),
      // Full recaps — an export must carry the complete session bodies, not the
      // dashboard's list-shape excerpts (issue #71).
      this.sessions.listRecapsForCampaign(campaignId, role),
      this.characters.listForCampaign(campaignId, role),
      this.notes.listAllForCampaign(campaignId, user, role, {}),
      this.comments.listForCampaign(campaignId, role),
      this.members.listForCampaign(campaignId),
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
      // Issue #436: planned game nights (with RSVPs) and per-session attendance.
      // Raw rows on purpose (#504): an archive records what the DB holds, so a recap
      // sitting in the trash at export time must not downgrade a completed night.
      this.scheduling.listForExport(campaignId),
      this.sessions.listAttendanceForCampaign(campaignId),
      // Issue #673: shared dice log (including physical/manual entries) travels with export.
      this.rolls.listForCampaign(campaignId, DEFAULT_DICE_ROLLS_RETENTION),
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

    // Issue #584: replace server-local ruleEntryId with stable compendium refs for portability.
    const ruleEntryIds = [
      ...new Set(
        encountersWithCombatants.flatMap((e) =>
          e.combatants.map((c) => c.ruleEntryId).filter((id): id is number => id != null),
        ),
      ),
    ];
    const compendiumExport = await loadCompendiumExportContext(this.db, ruleEntryIds);
    const portableEncounters = encountersWithCombatants.map((enc) => ({
      ...enc,
      combatants: enc.combatants.map((c) => {
        const { ruleEntryId, ...rest } = c;
        if (ruleEntryId == null) return { ...rest, ruleEntryId: null };
        const compendiumRef = compendiumExport.refByEntryId.get(ruleEntryId) ?? null;
        const compendiumSnapshot = compendiumExport.snapshotByEntryId.get(ruleEntryId) ?? null;
        return {
          ...rest,
          ruleEntryId: null,
          ...(compendiumRef ? { compendiumRef } : {}),
          ...(compendiumSnapshot ? { compendiumSnapshot } : {}),
        };
      }),
    }));

    // AI seat + scribe config (issue #1078): export the DM's hand-authored steering
    // and trigger settings. Runtime counters (tokensUsed, turnCount, lastTurnAt) and
    // provider keys (aiProviderConfigs — encrypted, install-specific) are excluded.
    const [[aiSeatRow], [aiScribeConfigRow], aiScribeJobRows] = await Promise.all([
      this.db.select().from(aiDmSeats).where(eq(aiDmSeats.campaignId, campaignId)).limit(1),
      this.db.select().from(aiScribeConfigs).where(eq(aiScribeConfigs.campaignId, campaignId)).limit(1),
      this.db.select().from(aiScribeJobs).where(eq(aiScribeJobs.campaignId, campaignId)),
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
      aiExternalUseConsent: m.aiExternalUseConsent,
      username: m.username,
      displayName: m.displayName,
      disabled: m.disabled,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));

    const auditMeta = await this.audit.finalizeCampaignExportMeta(campaignId, auditExport.meta);

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
      audit: auditExport.entries,
      auditMeta,
      auditNote:
        'Campaign portability export (GET /api/v1/campaigns/:campaignId/export) includes the retained audit trail captured in ' +
        'auditMeta.cutoff — not a full-server backup. A server-wide SQLite/disk backup preserves every table ' +
        'row (including audit appended after the snapshot and server-admin audit with campaign_id NULL). Imports ' +
        'do not replay audit history. When auditMeta.truncated > 0, rows are missing from this snapshot ' +
        '(retention pruning during export and/or audit appended after auditMeta.cutoff.snapshotMaxId); ' +
        'page GET /api/v1/campaigns/:campaignId/audit for the live log.',
      proposals: proposalList,
      encounters: portableEncounters,
      compendiumDependencies: compendiumExport.dependencies,
      compendiumNote:
        'Combatants reference compendium statblocks via compendiumRef (packSlug/packVersion/entrySlug/contentHash), ' +
        'never via server-local ruleEntryId. compendiumSnapshot carries the entry content at export time for ' +
        'detached import when a dependency pack is missing on the target server. See compendiumDependencies for ' +
        'the open-license manifest; run POST /campaigns/import/preflight before import to verify resolution.',
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
      // Issue #436: schedules + RSVPs and session attendance round-trip on import.
      scheduledSessions: scheduledSessionList,
      sessionAttendance: sessionAttendanceList,
      diceRolls: diceRollList,
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
      aiScribeJobs: aiScribeJobRows.map((row) => ({
        id: row.id,
        trigger: row.trigger,
        status: row.status,
        sourceHash: row.sourceHash,
        proposalId: row.proposalId,
        proposalCount: row.proposalCount,
        tokensUsed: row.tokensUsed,
        provider: row.provider,
        detail: row.detail,
        scheduledSessionId: row.scheduledSessionId,
        sourceStats: jsonOrNull(row.sourceStats),
        generationProvenance: jsonOrNull(row.generationProvenance),
        createdBy: row.createdBy,
        createdAt: row.createdAt,
      })),
      attachments,
      attachmentsNote:
        'campaign.mapAttachmentId references attachments[].id; each character.portraitUrl, ' +
        'npc.portraitUrl, faction.portraitUrl, and location.portraitUrl ends in attachments[].fileRoute. ' +
        'This JSON document carries attachment METADATA only — the raw image bytes are NOT embedded here. ' +
        'Export with format=mdzip to obtain a zip whose uploads/ folder holds the actual files at ' +
        'attachments[].file. Entries with present=false have no file on disk (dangling reference); ' +
        'their bytes are omitted from every export format.',
      participantSupportNote:
        'Participant-owned access-support preferences are intentionally excluded from campaign exports, imports, ' +
        'and clones. Each participant can export their own submission with GET /campaigns/:id/export/me; full-server ' +
        'backup/restore preserves the database rows and ownership.',
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Issue #586 — export profiles (backup / handoff / publishable module)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Run {@link buildExport} through a redaction profile.
   *
   * `buildExport` stays the single "everything in this campaign" reader; this method
   * is the ONLY thing that narrows it. `profile: 'backup'` is a pass-through, so the
   * existing DM backup is unchanged apart from gaining a `redaction` disclosure block
   * that states, in machine-readable form, that nothing was redacted.
   *
   * `inspectAttachmentBytes` controls whether attachment files are read from disk to
   * decide (and report) whether their bytes can travel. The zip path and the
   * pre-export preview need it; the JSON path never embeds bytes so it skips the read.
   */
  async buildProfileExport(
    campaignId: number,
    user: RequestUser,
    profile: ExportProfile = DEFAULT_EXPORT_PROFILE,
    options: ExportProfileOptions = {},
    opts: {
      inspectAttachmentBytes?: boolean;
      format?: 'json' | 'mdzip';
      attachmentPaths?: boolean;
      stageAttachmentBytes?: (content: Buffer) => { path: string; checksum: string };
      retainAttachmentBytes?: boolean;
    } = {},
  ): Promise<ProfileExportResult & { projection: ExportProjection; attachmentBytes: Map<number, AttachmentByteDecision> }> {
    const policy = resolveExportPolicy(profile, options);
    const raw = (await this.buildExport(campaignId, user)) as unknown as Record<string, unknown>;
    const projection = projectExport(raw, policy);

    const { scannable } = partitionIdentifiers(collectPrivateIdentifiers(raw));
    const format = opts.format ?? 'json';
    const attachmentBytes = opts.inspectAttachmentBytes
      ? this.planAttachmentBytes(
          campaignId,
          raw,
          policy,
          scannable,
          opts.attachmentPaths === true,
          opts.stageAttachmentBytes,
          opts.retainAttachmentBytes !== false,
        )
      : new Map<number, AttachmentByteDecision>();

    // Keep `present` honest: a row whose bytes the policy withholds must not claim the
    // file is in the archive. Done BEFORE campaign.json is serialized in the zip path.
    if (opts.inspectAttachmentBytes && Array.isArray(projection.data.attachments)) {
      for (const entry of projection.data.attachments as Array<Record<string, unknown>>) {
        const decision = attachmentBytes.get(Number(entry.id));
        if (!decision || (decision.bytes == null && !decision.sourcePath && !decision.available)) {
          entry.present = false;
          if (decision?.withheldReason) entry.bytesWithheldReason = decision.withheldReason;
        }
      }
    }

    const attachmentInventory = this.attachmentInventory(raw, policy, attachmentBytes, format, opts.inspectAttachmentBytes === true);

    const inventory: ExportInventory = {
      app: 'campfire',
      kind: 'campaign-export-inventory',
      formatVersion: EXPORT_INVENTORY_FORMAT_VERSION,
      campaignId,
      profile: policy.profile,
      options: policy.options,
      secrecyProfile: policy.secrecyProfile,
      summary: policy.summary,
      createdAt: new Date().toISOString(),
      policy: {
        memberIdentities: policy.memberIdentities,
        audit: policy.audit,
        proposals: policy.proposals,
        operationalHistory: policy.operationalHistory,
        privateNotes: policy.privateNotes,
        playerContent: policy.playerContent,
        playedState: policy.playedState,
        dmSecrets: policy.dmSecrets,
        credentials: policy.credentials,
        allowlistProjection: policy.allowlistProjection,
        pseudonymizeAuthors: policy.pseudonymizeAuthors,
        neutralizeAttachmentFilenames: policy.neutralizeAttachmentFilenames,
        scanFreeText: policy.scanFreeText,
        sanitizeAttachmentBytes: policy.sanitizeAttachmentBytes,
        requireSanitizedAttachments: policy.requireSanitizedAttachments,
      },
      rows: projection.rows,
      attachments: attachmentInventory,
      identifiers: {
        scanned: projection.scannedIdentifiers.length,
        unscannable: projection.unscannableIdentifiers,
        occurrencesRedacted: projection.occurrencesRedacted,
      },
      pseudonyms: { contributors: projection.contributors },
      limitations: exportLimitations(policy),
    };

    // The disclosure travels INSIDE the document too, so a JSON export that is
    // detached from its zip manifest still says what was removed from it.
    const data: Record<string, unknown> = {
      ...projection.data,
      redaction: this.redactionDisclosure(inventory),
    };

    return { data, policy, inventory, projection, attachmentBytes };
  }

  /** Pre-export inventory (issue #586) — what would travel, what would be redacted. */
  async buildExportInventory(
    campaignId: number,
    user: RequestUser,
    profile: ExportProfile,
    options: ExportProfileOptions,
    format: 'json' | 'mdzip',
  ): Promise<ExportInventory> {
    const { inventory } = await this.buildProfileExport(campaignId, user, profile, options, {
      inspectAttachmentBytes: format === 'mdzip',
      format,
      // Backup never sanitizes attachment bytes. For its Markdown ZIP preview,
      // filesystem paths tell us both presence and what the streaming archive
      // would include without opening every attachment.
      attachmentPaths: format === 'mdzip' && profile === 'backup',
      // Preview needs inspection results, not payloads. Keeping one sanitized
      // Buffer per attachment here would turn a large campaign preview into a
      // cumulative heap allocation even though it emits no archive bytes.
      retainAttachmentBytes: false,
    });
    return inventory;
  }

  /**
   * Machine-readable redaction block embedded in the payload and the archive manifest.
   *
   * NOTE the asymmetry with {@link ExportInventory}: the inventory is a DM-facing
   * report returned over an authenticated dm-only endpoint (GET /export/preview) and
   * may name the identifiers the sweep could not remove. The disclosure below SHIPS
   * INSIDE THE ARCHIVE, so it must never carry an identifier literal.
   *
   * `identifiers.unscannable` is exactly such a literal list: `partitionIdentifiers`
   * classes anything shorter than `MIN_SCANNABLE_IDENTIFIER` as unscannable, and
   * every numeric user id below 1000 plus every short username / display name ("kim",
   * "Bob", "Jo") lands in it. Copying it into campaign.json + archive-manifest.json
   * published the very roster identities the publish profile exists to withhold, so
   * only the COUNT travels.
   */
  private redactionDisclosure(inventory: ExportInventory): ArchiveRedactionDisclosure {
    return {
      profile: inventory.profile,
      options: { ...inventory.options },
      policy: { ...inventory.policy },
      rows: inventory.rows,
      attachments: inventory.attachments,
      identifiers: {
        scanned: inventory.identifiers.scanned,
        occurrencesRedacted: inventory.identifiers.occurrencesRedacted,
        unscannableCount: inventory.identifiers.unscannable.length,
      },
      pseudonyms: inventory.pseudonyms,
      limitations: inventory.limitations,
    };
  }

  /**
   * Decide, per attachment, whether its bytes may travel in a redacted archive.
   *
   * Three ways bytes are withheld:
   *  1. the file is missing on disk (pre-existing #84 behaviour);
   *  2. the format's embedded metadata cannot be provably stripped by this codebase
   *     (WebP/PDF/SVG) and the profile requires sanitized bytes — publish omits them
   *     rather than shipping EXIF/XMP/document metadata it never inspected;
   *  3. the sanitized bytes STILL contain a known private identifier, which means
   *     something we do not parse is carrying it — drop the file, do not guess.
   */
  private planAttachmentBytes(
    campaignId: number,
    raw: Record<string, unknown>,
    policy: ResolvedExportPolicy,
    identifiers: string[],
    preferPaths = false,
    stageAttachmentBytes?: (content: Buffer) => { path: string; checksum: string },
    retainBytes = true,
  ): Map<number, AttachmentByteDecision> {
    const decisions = new Map<number, AttachmentByteDecision>();
    const rows = Array.isArray(raw.attachments) ? (raw.attachments as Array<{ id: number; mime: string; filename: string }>) : [];
    for (const row of rows) {
      const sourcePath = preferPaths ? this.attachments.exportPathIfPresent({ campaignId, id: row.id, mime: row.mime }) : null;
      if (preferPaths && !policy.sanitizeAttachmentBytes) {
        decisions.set(row.id, sourcePath
          ? { id: row.id, bytes: null, sourcePath, metadataStripped: false }
          : { id: row.id, bytes: null, metadataStripped: false, withheldReason: 'file missing on disk' });
        continue;
      }
      const original = this.attachments.readBytesIfPresent({ campaignId, id: row.id, mime: row.mime });
      if (!original) {
        decisions.set(row.id, { id: row.id, bytes: null, metadataStripped: false, withheldReason: 'file missing on disk' });
        continue;
      }
      if (!policy.sanitizeAttachmentBytes) {
        decisions.set(row.id, {
          id: row.id,
          bytes: retainBytes ? original : null,
          available: !retainBytes,
          metadataStripped: false,
        });
        continue;
      }
      const result = stripImageMetadata(row.mime, original);
      if (!result.supported && policy.requireSanitizedAttachments) {
        decisions.set(row.id, {
          id: row.id,
          bytes: null,
          metadataStripped: false,
          withheldReason: `embedded metadata cannot be stripped for ${row.mime} — bytes omitted from a publish archive`,
        });
        continue;
      }
      if (bytesContainIdentifier(result.bytes, identifiers)) {
        decisions.set(row.id, {
          id: row.id,
          bytes: null,
          metadataStripped: result.stripped,
          withheldReason: 'a known private identifier survived metadata stripping inside the file bytes',
        });
        continue;
      }
      if (stageAttachmentBytes) {
        const staged = stageAttachmentBytes(result.bytes);
        decisions.set(row.id, {
          id: row.id,
          bytes: null,
          sourcePath: staged.path,
          sourceChecksum: staged.checksum,
          metadataStripped: result.stripped,
        });
      } else {
        decisions.set(row.id, {
          id: row.id,
          bytes: retainBytes ? result.bytes : null,
          available: !retainBytes,
          metadataStripped: result.stripped,
        });
      }
    }
    return decisions;
  }

  private attachmentInventory(
    raw: Record<string, unknown>,
    policy: ResolvedExportPolicy,
    decisions: Map<number, AttachmentByteDecision>,
    format: 'json' | 'mdzip',
    inspected: boolean,
  ): ExportAttachmentInventory {
    const rows = Array.isArray(raw.attachments) ? (raw.attachments as Array<{ id: number; mime: string }>) : [];
    const notes: string[] = [];
    if (format === 'json') {
      notes.push('JSON exports carry attachment metadata only — no bytes are embedded in any profile.');
    }
    if (!inspected) {
      return {
        included: rows.length,
        bytesWithheld: rows.length,
        filenamesNeutralized: policy.neutralizeAttachmentFilenames ? rows.length : 0,
        metadataStripped: 0,
        notes,
      };
    }
    let withheld = 0;
    let stripped = 0;
    for (const row of rows) {
      const decision = decisions.get(row.id);
      if (!decision || (decision.bytes == null && !decision.sourcePath && !decision.available)) withheld += 1;
      if (decision?.metadataStripped) stripped += 1;
    }
    const unsanitizable = rows.filter((r) => !SANITIZABLE_MIMES.has(r.mime)).length;
    if (unsanitizable > 0 && policy.sanitizeAttachmentBytes && !policy.requireSanitizedAttachments) {
      notes.push(
        `${unsanitizable} attachment(s) are in a format whose embedded metadata this server cannot strip ` +
          '(WebP/PDF/SVG); their bytes travel unmodified. Review them before sharing the archive.',
      );
    }
    return {
      included: rows.length,
      bytesWithheld: withheld,
      filenamesNeutralized: policy.neutralizeAttachmentFilenames ? rows.length : 0,
      metadataStripped: stripped,
      notes,
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
      this.notes.listAllForCampaign(campaignId, user, role, { mine: true }),
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

  /**
   * Download filename. The profile is part of the name for anything but `backup`
   * (issue #586) so a publishable module and a full DM backup of the same campaign
   * are never confused for one another in a downloads folder.
   */
  exportFilename(campaignName: string, extension: 'json' | 'zip', profile: ExportProfile = DEFAULT_EXPORT_PROFILE): string {
    const slug = slugify(campaignName);
    const date = new Date().toISOString().slice(0, 10);
    const suffix = profile === 'backup' ? '' : `-${profile}`;
    return `campfire-${slug}${suffix}-${date}.${extension}`;
  }

  /**
   * Compatibility API for programmatic callers and the older unit tests. HTTP
   * downloads use `streamMarkdownZip` below and never call this collector.
   */
  async buildMarkdownZip(
    campaignId: number,
    user: RequestUser,
    opts: { profile?: ExportProfile; options?: ExportProfileOptions } = {},
  ): Promise<{ buffer: Buffer; warnings: string[]; inventory: ExportInventory }> {
    const zip = new JSZip();
    const result = await this.writeMarkdownZip({ file: (entryPath, content) => zip.file(entryPath, content) }, campaignId, user, opts);
    return { buffer: await zip.generateAsync({ type: 'nodebuffer' }), ...result };
  }

  /**
   * Writes a ZIP directly to `destination`. Attachments are supplied to archiver
   * as staged filesystem paths, which keeps their bytes out of the JS heap and
   * makes the manifest digest and archived bytes refer to the same immutable copy.
   */
  async streamMarkdownZip(
    destination: Writable,
    signal: AbortSignal,
    campaignId: number,
    user: RequestUser,
    opts: { profile?: ExportProfile; options?: ExportProfileOptions; onFirstByte?: () => void } = {},
  ): Promise<{ warnings: string[]; inventory: ExportInventory }> {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Export aborted');
    const archive = archiver('zip', { zlib: { level: 9 } });
    // archiver emits 'error' asynchronously, which can land after the scoped handler below
    // has been removed in the finally. Keep a permanent sink so a torn-down archive can
    // never raise an unhandled 'error' event and take the process down.
    archive.on('error', () => undefined);
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-export-'));
    let stageNumber = 0;
    let archiveError: Error | undefined;
    // `writeMarkdownZip` can still fail while querying/projecting the campaign.
    // A response is only committed once archiver has emitted bytes, not merely
    // because the archive was constructed and piped.
    let archiveBytesProduced = false;
    const outputCompletionAbort = new AbortController();
    const outputComplete = finished(destination, { cleanup: true, signal: outputCompletionAbort.signal });
    // Attach a rejection handler immediately: an output can fail while an
    // attachment is still being staged, before the main flow reaches its await.
    void outputComplete.catch(() => undefined);
    /**
     * Tear the destination down only once bytes are actually committed to it, and report
     * whether we did.
     *
     * Before the first byte the response still belongs to Nest: the DB reads in
     * buildProfileExport happen after the controller staged headers but before anything
     * is written, so destroying here would reset the connection and — because the
     * controller skips rethrowing for an already-destroyed response — the client would
     * get an opaque failed download instead of a JSON 500. The buffered path did all of
     * this work before touching the response; preserve that outcome.
     */
    const teardownDestination = (error: Error): boolean => {
      if (!archiveBytesProduced && !destination.writableEnded && !destination.destroyed) return false;
      if (!destination.destroyed && !destination.writableEnded) destination.destroy(error);
      return true;
    };
    const destroy = (error: Error) => {
      archive.destroy(error);
      teardownDestination(error);
    };
    const abort = () => destroy(signal.reason instanceof Error ? signal.reason : new Error('Export aborted'));
    const onArchiveError = (err: Error) => {
      archiveError = err;
      teardownDestination(err);
    };
    const onDestinationError = (err: Error) => {
      archiveError = err;
      archive.destroy(err);
    };
    const onArchiveData = () => {
      // Registered before archive.pipe(destination) below, so this runs ahead of the
      // first write and the caller can commit response headers only now that bytes
      // are genuinely on their way.
      if (!archiveBytesProduced) opts.onFirstByte?.();
      archiveBytesProduced = true;
    };
    signal.addEventListener('abort', abort, { once: true });
    archive.once('error', onArchiveError);
    destination.once('error', onDestinationError);
    archive.on('data', onArchiveData);
    archive.pipe(destination);
    try {
      const result = await this.writeMarkdownZip(
        {
          file: (entryPath, content) => archive.append(content, { name: entryPath }),
          attachment: (entryPath, content) => {
            const staged = path.join(stagingDir, `${stageNumber++}.attachment`);
            fs.writeFileSync(staged, content, { flag: 'wx' });
            archive.file(staged, { name: entryPath });
          },
          stageAttachment: (content) => {
            const staged = path.join(stagingDir, `${stageNumber++}.attachment`);
            fs.writeFileSync(staged, content, { flag: 'wx' });
            return { path: staged, checksum: sha256Hex(content) };
          },
          stageLiveAttachment: async (source) => {
            const staged = path.join(stagingDir, `${stageNumber++}.attachment`);
            const hash = crypto.createHash('sha256');
            const hashing = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                hash.update(chunk);
                callback(null, chunk);
              },
            });
            await pipeline(fs.createReadStream(source), hashing, fs.createWriteStream(staged, { flags: 'wx' }), { signal });
            if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Export aborted');
            return { path: staged, checksum: hash.digest('hex') };
          },
          attachmentPath: async (entryPath, source, stagedChecksum) => {
            if (stagedChecksum) {
              archive.file(source, { name: entryPath });
              return { path: source, checksum: stagedChecksum };
            }
            const staged = path.join(stagingDir, `${stageNumber++}.attachment`);
            const hash = crypto.createHash('sha256');
            const hashing = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                hash.update(chunk);
                callback(null, chunk);
              },
            });
            // Stage and hash one bounded chunk at a time. Archiver only sees the
            // staged file once this pipeline completes, eliminating the manifest
            // checksum/source-byte TOCTOU window.
            await pipeline(fs.createReadStream(source), hashing, fs.createWriteStream(staged, { flags: 'wx' }), { signal });
            if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Export aborted');
            archive.file(staged, { name: entryPath });
            return { path: staged, checksum: hash.digest('hex') };
          },
        },
        campaignId,
        user,
        opts,
        true,
      );
      if (archiveError) throw archiveError;
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Export aborted');
      await archive.finalize();
      await outputComplete;
      if (archiveError) throw archiveError;
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // Only wait on the destination when we actually tore it down. An untouched response
      // is left intact for the controller to answer with a normal error, and awaiting
      // `finished()` on a stream nobody destroyed would simply hang.
      if (teardownDestination(error)) {
        archive.destroy(error);
        try {
          await outputComplete;
        } catch {
          // Preserve the operation's primary failure (abort, staging, or archiver).
        }
      } else {
        // No bytes reached the response: leave it available for Nest's normal exception
        // handling instead of resetting the client connection. The primary error is
        // rethrown below, so close archiver without emitting a second asynchronous error.
        archive.destroy();
      }
      throw error;
    } finally {
      // Cancels only the finished() observation, not the destination stream. It
      // removes its listeners when a pre-stream failure leaves the response open.
      outputCompletionAbort.abort();
      signal.removeEventListener('abort', abort);
      archive.removeListener('error', onArchiveError);
      archive.removeListener('data', onArchiveData);
      destination.removeListener('error', onDestinationError);
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  /**
   * Only an ENOENT from a fresh stat proves the source disappeared after it was
   * planned. Every other outcome must preserve the original staging failure.
   */
  private rethrowUnlessLiveAttachmentIsMissing(sourcePath: string, stagingError: unknown): void {
    try {
      fs.statSync(sourcePath);
    } catch (statError: unknown) {
      if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return;
    }
    throw stagingError;
  }

  private async writeMarkdownZip(
    writer: MarkdownZipWriter,
    campaignId: number,
    user: RequestUser,
    opts: { profile?: ExportProfile; options?: ExportProfileOptions } = {},
    streamAttachments = false,
  ): Promise<{ warnings: string[]; inventory: ExportInventory }> {
    const profileResult = await this.buildProfileExport(campaignId, user, opts.profile ?? DEFAULT_EXPORT_PROFILE, opts.options ?? {}, {
      inspectAttachmentBytes: true,
      attachmentPaths: streamAttachments,
      stageAttachmentBytes: streamAttachments ? writer.stageAttachment : undefined,
      format: 'mdzip',
    });
    const policy = profileResult.policy;
    const attachmentBytes = profileResult.attachmentBytes;
    const inventory = profileResult.inventory;
    const data = profileResult.data as unknown as ProfileExportData;
    // Live files may disappear after planning. Stage every such source before
    // appending any archive entry, so a vanished file is reflected consistently
    // in campaign.json, warnings.txt, and the manifest rather than failing after
    // an HTTP response has already begun.
    if (writer.stageLiveAttachment) {
      for (const attachment of data.attachments) {
        const decision = attachmentBytes.get(attachment.id);
        if (!decision?.sourcePath || decision.sourceChecksum) continue;
        try {
          const staged = await writer.stageLiveAttachment(decision.sourcePath);
          decision.sourcePath = staged.path;
          decision.sourceChecksum = staged.checksum;
        } catch (err) {
          // A stream-open ENOENT may be wrapped by pipeline. Classify only a
          // genuinely absent source as the established warning/skip outcome.
          // existsSync() also returns false for permission and other I/O errors,
          // which would incorrectly turn a staging failure into a missing-file
          // warning. statSync lets us distinguish an actual ENOENT race.
          this.rethrowUnlessLiveAttachmentIsMissing(decision.sourcePath, err);
          decision.sourcePath = undefined;
          decision.bytes = null;
          decision.withheldReason = 'file missing on disk';
          attachment.present = false;
          (attachment as Record<string, unknown>).bytesWithheldReason = decision.withheldReason;
          // Inventory and its embedded disclosure were calculated before this
          // last-moment filesystem race. Keep every archive representation
          // honest without re-running the (potentially expensive) projection.
          inventory.attachments.bytesWithheld += 1;
          (data as Record<string, unknown>).redaction = this.redactionDisclosure(inventory);
        }
      }
    }
    const warnings: string[] = [];
    const fileChecksums: Record<string, string> = {};
    const records: ArchiveRecordEntry[] = [];

    const writeFile = (path: string, content: string | Buffer) => {
      writer.file(path, content);
      fileChecksums[path] = sha256Hex(content);
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
    writer.file('campaign.json', campaignJson);

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
    // Batch-fetch all encounters' events in a single query to avoid an N+1 on large
    // campaigns (issue #863). Export is DM-scoped, so no viewer redaction is needed.
    //
    // Issue #586: the combat log is a blow-by-blow record of what happened at the
    // table, so it is played state — a profile that withholds played state must not
    // render it at all.
    //
    // It is also the ONE markdown input read straight from the database instead of
    // from the projected payload, so when a profile DOES carry played state (handoff
    // always; publish with playedState=true) it would otherwise be the single string
    // in the archive that never meets the free-text sweep. `actor`, `target` and
    // `detail` are free text a DM/AI wrote — a combatant a DM named after the person
    // playing it renders as `[redacted]` in campaign.json and in the combatant table,
    // and would have survived verbatim in the combat log two lines below. Push the
    // events through the SAME sweep with the SAME identifier set so there is genuinely
    // one redaction boundary rather than one plus an exception.
    const rawEncounterEvents = policy.playedState
      ? await this.encounters.listEventsForEncounters(data.encounters.map((e) => e.id))
      : new Map<number, EncounterEvent[]>();
    const encounterEvents = policy.scanFreeText
      ? new Map<number, EncounterEvent[]>(
          [...rawEncounterEvents].map(([id, events]) => [
            id,
            redactIdentifiers(events, profileResult.projection.scannedIdentifiers).value,
          ]),
        )
      : rawEncounterEvents;

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

    writeFile('session-zero.md', this.sessionZeroMarkdown(data.sessionZero, policy.playerContent));
    if (policy.playerContent) writeFile('inventory.md', this.inventoryMarkdown(data.inventory, data.treasury));

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

    // Issue #586: identity/operations files are WRITTEN ONLY when the profile carries
    // them. Rendering an empty members.md into a publishable module would be harmless
    // but misleading; declaring the module excluded in the manifest is honest.
    if (policy.memberIdentities) writeFile('members.md', this.membersMarkdown(data.members));

    // Only record a truncation when the audit snapshot actually dropped rows. The export
    // path (AuditService.listForCampaignExport) keyset-pages the full retained trail, so
    // `auditMeta.truncated` — not a fixed 500-row cap — is the real omission count
    // (retention pruning during the walk and/or rows appended after the snapshot ceiling).
    const auditTruncated = data.auditMeta?.truncated ?? 0;
    const truncations: ArchiveTruncation[] =
      policy.audit && auditTruncated > 0 && data.auditMeta
        ? [
            {
              module: 'audit',
              exported: data.audit.length,
              note:
                `${auditTruncated} audit row(s) are missing from this snapshot relative to the ` +
                `capture ceiling (id <= ${data.auditMeta.cutoff.snapshotMaxId}): retention pruning ` +
                `during export and/or rows appended after the cutoff. See auditMeta in campaign.json ` +
                `and page GET /api/v1/campaigns/:id/audit for the live log.`,
            },
          ]
        : [];
    if (policy.audit) writeFile('audit.md', this.auditMarkdown(data.audit, auditTruncated));
    if (policy.operationalHistory) writeFile('dice-rolls.md', this.diceRollsMarkdown(data.diceRolls));

    const proposalAlloc: Array<{ stem: string; filename: string }> = [];
    if (policy.proposals) {
      for (const p of [...data.proposals].sort((a, b) => a.id - b.id)) {
        const name = `${p.entityType}-${p.entityId ?? 'new'}-${p.status}`;
        writeRecord('proposals', 'proposal', p.id, name, this.proposalMarkdown(p), proposalAlloc);
      }
      warnings.push(...stemCollisionWarnings('proposal', proposalAlloc));
    }

    const revisionAlloc: Array<{ stem: string; filename: string }> = [];
    if (policy.operationalHistory) {
      for (const r of [...data.revisions].sort((a, b) => a.id - b.id)) {
        const name = `${r.entityType}-${r.entityId}-${r.id}`;
        writeRecord('revisions', 'revision', r.id, name, this.revisionMarkdown(r), revisionAlloc);
      }
      warnings.push(...stemCollisionWarnings('revision', revisionAlloc));
    }

    // Issue #87 / #863: embed attachment bytes; build references from every owner type
    // (campaign map, character portraits, encounter battle maps).
    // Issue #586: the decision of WHICH bytes may travel (and whether their metadata
    // was stripped) was taken in planAttachmentBytes; here we only place them.
    const skipped: typeof data.attachments = [];
    for (const a of data.attachments) {
      const decision = attachmentBytes.get(a.id);
      if (decision?.bytes || decision?.sourcePath) {
        if (decision.sourcePath && !writer.attachmentPath) {
          throw new Error('Markdown ZIP writer cannot stream attachment paths');
        }
        if (decision.sourcePath && writer.attachmentPath) {
          const staged = await writer.attachmentPath(
            a.file,
            decision.sourcePath,
            decision.sourceChecksum,
          );
          fileChecksums[a.file] = staged.checksum;
        } else if (decision.bytes) {
          if (writer.attachment) writer.attachment(a.file, decision.bytes);
          else writer.file(a.file, decision.bytes);
          fileChecksums[a.file] = sha256Hex(decision.bytes);
        }
      } else {
        skipped.push(a);
        warnings.push(
          `Attachment ${a.id} (${a.filename}) — bytes omitted from uploads/: ${decision?.withheldReason ?? 'file missing on disk'}.`,
        );
      }
    }
    writeFile(
      'attachments.md',
      this.attachmentsManifestMarkdown(data.campaign, data.characters, data.encounters, data.attachments, skipped),
    );

    // AI DM seat + scribe config (issue #1078) are first-class exported data, so give
    // them a human-readable file rather than leaving them only in campaign.json.
    if (policy.credentials) writeFile('ai.md', this.aiConfigMarkdown(data.aiSeat, data.aiScribeConfig));

    // Human-readable redaction disclosure (issue #586) — the DM-facing counterpart to
    // the `redaction` block in campaign.json / archive-manifest.json.
    writeFile('redaction.md', this.redactionMarkdown(inventory));

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
      diceRolls: { kind: 'markdown-file', path: 'dice-rolls.md' },
      auditMeta: {
        kind: 'embedded',
        path: 'audit.md',
        note: 'Audit snapshot metadata (cutoff/truncation counts) lives in campaign.json; audit.md summarizes any truncation.',
      },
      auditNote: {
        kind: 'embedded',
        path: 'audit.md',
        note: 'Human-readable audit portability note; machine copy in campaign.json.',
      },
      aiSeat: { kind: 'markdown-file', path: 'ai.md' },
      aiScribeConfig: { kind: 'markdown-file', path: 'ai.md' },
      aiScribeJobs: {
        kind: 'embedded',
        path: 'campaign.json',
        // Issue #501: the scribe job log carries generationProvenance (provider/model/
        // endpoint/source ids/prompt hash/consent). It is machine-only — exported so
        // provenance survives export, not rendered to markdown.
        note: 'AI scribe job log with generation provenance; machine copy in campaign.json.',
      },
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
      scheduledSessions: {
        kind: 'embedded',
        path: 'campaign.json',
        note: 'Planned game nights with nested RSVPs; machine copy in campaign.json.',
      },
      sessionAttendance: {
        kind: 'embedded',
        path: 'campaign.json',
        note: 'Per-session character attendance; machine copy in campaign.json.',
      },
      attachments: { kind: 'markdown-file', path: 'attachments.md' },
      attachmentsNote: {
        kind: 'embedded',
        path: 'attachments.md',
        note: 'Human-readable attachment cross-reference; machine note lives in campaign.json',
      },
      compendiumDependencies: {
        kind: 'embedded',
        path: 'campaign.json',
        note: 'Open-license compendium pack manifest for combatant statblock resolution on import; machine copy in campaign.json.',
      },
      compendiumNote: {
        kind: 'embedded',
        path: 'campaign.json',
        note: 'Human-readable compendium portability note; machine copy in campaign.json.',
      },
      participantSupportNote: {
        kind: 'excluded',
        reason:
          'Participant-owned access-support preferences are intentionally excluded from campaign exports; use GET /campaigns/:id/export/me or full-server backup.',
      },
      redaction: { kind: 'markdown-file', path: 'redaction.md' },
    };

    // Issue #586: whatever the policy dropped is DECLARED, not silently absent. Driving
    // this off the policy switches (rather than off "did we happen to emit zero rows")
    // means an empty campaign and a redacted campaign are distinguishable, and the
    // manifest invariant forces a contributor adding a module to pick a gate for it.
    const profileExclusions: ArchiveExclusion[] = [];
    const gates: Array<[module: string, carried: boolean]> = [
      ['members', policy.memberIdentities],
      ['audit', policy.audit],
      ['auditMeta', policy.audit],
      ['proposals', policy.proposals],
      ['revisions', policy.operationalHistory],
      ['scheduledSessions', policy.operationalHistory],
      ['sessionAttendance', policy.operationalHistory],
      ['diceRolls', policy.operationalHistory],
      ['aiSeat', policy.credentials],
      ['aiScribeConfig', policy.credentials],
      ['sessions', policy.playedState],
      ['characters', policy.playerContent],
      ['comments', policy.playerContent],
      ['inventory', policy.playerContent],
      ['treasury', policy.playerContent],
    ];
    for (const [module, carried] of gates) {
      if (carried) continue;
      const reason = MODULE_EXCLUSION_REASONS[module] ?? 'Excluded by the export redaction policy.';
      modules[module] = { kind: 'excluded', reason };
      profileExclusions.push({ module, reason });
    }
    if (!policy.audit) {
      modules.auditNote = {
        kind: 'embedded',
        path: 'campaign.json',
        note: 'States that audit history was redacted out of this profile.',
      };
    }

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
      diceRolls: data.diceRolls.length,
      proposals: data.proposals.length,
      encounters: data.encounters.length,
      factions: data.factions.length,
      storyArcs: data.storyArcs.length,
      timelineEvents: data.timelineEvents.length,
      inventory: data.inventory.length,
      revisions: data.revisions.length,
      scheduledSessions: data.scheduledSessions.length,
      sessionAttendance: data.sessionAttendance.length,
      attachments: data.attachments.length,
      // Derive present from the ACTUAL byte reads (data.attachments.length - skipped),
      // not the earlier existsSync-based `a.present` flag, so the two counts can never
      // disagree if a file disappears between the existence check and the read.
      attachmentsPresent: data.attachments.length - skipped.length,
      attachmentsSkipped: skipped.length,
    };

    // warnings.txt is content, so write it BEFORE building the manifest via writeFile() —
    // that checksums it into manifest.checksums.files. The manifest itself is written last
    // and is not (cannot be) checksummed against itself.
    if (warnings.length) {
      writeFile('warnings.txt', warnings.join('\n') + '\n');
    }

    const manifest = buildMarkdownArchiveManifest({
      campaignId,
      counts,
      campaignJson,
      fileChecksums,
      modules,
      secrecyProfile: policy.secrecyProfile,
      redaction: this.redactionDisclosure(inventory),
      exclusions: [
        {
          module: 'participantSupportNote',
          reason:
            'Participant-owned access-support preferences are intentionally excluded from campaign exports; use GET /campaigns/:id/export/me or full-server backup.',
        },
        ...profileExclusions,
      ],
      truncations,
      // Locale-independent code-unit sort so record order is identical across machines
      // and locales (localeCompare is locale-sensitive and would make the manifest
      // non-deterministic).
      records: records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    });
    writer.file('archive-manifest.json', JSON.stringify(manifest, null, 2));

    return { warnings, inventory };
  }

  /**
   * Escape a free-text value for a GitHub-flavored-markdown TABLE cell. Entity names,
   * notes, and conditions are user-authored, so an embedded `|` (column delimiter) or
   * newline (row delimiter) would otherwise corrupt the table and desync every following
   * cell — breaking the "verifiable manifest" guarantee (issue #863). Pipes are
   * backslash-escaped and CR/LF collapsed to a single space; the result is trimmed.
   */
  private mdCell(value: unknown): string {
    return String(value ?? '')
      .replace(/\r\n?|\n/g, ' ')
      .replace(/\|/g, '\\|')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Display label for an authored row. Redacted profiles withhold `authorUserId`
   * and `authorName` entirely and supply a per-export pseudonym instead (issue #586),
   * so this must never fall through to a raw id when a pseudonym is present.
   */
  private authorLabel(row: { authorName?: string | null; authorUserId?: string | null; authorPseudonym?: string | null }): string {
    return row.authorPseudonym || row.authorName || row.authorUserId || '_unattributed_';
  }

  private buildBacklinkIndex(data: ProfileExportData): Map<string, string[]> {
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
    characters: ProfileExportData['characters'],
    encounters: ExportData['encounters'],
    attachments: ProfileExportData['attachments'],
    skipped: { id: number; file: string; filename: string }[],
  ): string {
    const lines = ['# Attachments', ''];
    if (!attachments.length) {
      lines.push('_This campaign has no attachments._', '');
      return lines.join('\n');
    }
    // Authoritative "was it embedded" truth: membership in `skipped` (which reflects the
    // actual readBytesIfPresent() result), not the earlier existsSync-based `a.present`.
    // This keeps the File column consistent with what the zip contains even if a file
    // disappears between the existence check and the byte read.
    const skippedIds = new Set(skipped.map((s) => s.id));
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
        if (c.portraitUrl && c.portraitUrl.endsWith(a.fileRoute)) refs.push(`portrait: ${this.mdCell(c.name)} (character:${c.id})`);
      }
      for (const e of encounters) {
        if (e.mapAttachmentId === a.id) refs.push(`encounter map: ${this.mdCell(e.name)} (encounter:${e.id})`);
      }
      const fileCell = skippedIds.has(a.id) ? '_missing — skipped_' : `\`${this.mdCell(a.file)}\``;
      lines.push(`| ${a.id} | ${this.mdCell(a.kind)} | ${this.mdCell(a.filename)} | ${fileCell} | ${refs.length ? refs.join(', ') : '_unreferenced_'} |`);
    }
    if (skipped.length) {
      lines.push('', '## Skipped (file missing on disk)', '');
      for (const s of skipped) {
        lines.push(`- Attachment ${s.id} (${s.filename}) — expected at \`${s.file}\`, not present; bytes omitted.`);
      }
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Human-readable redaction disclosure (issue #586). A DM about to publish a module
   * should be able to read, in one file, exactly what was withheld and what this
   * feature does NOT protect against.
   */
  private redactionMarkdown(inventory: ExportInventory): string {
    const yes = (b: boolean) => (b ? 'included' : 'REDACTED');
    const lines = [
      '# Redaction policy',
      '',
      `- Profile: \`${inventory.profile}\` (${inventory.secrecyProfile})`,
      `- Generated: ${inventory.createdAt}`,
      '',
      inventory.summary,
      '',
      '## Options',
      '',
      `- DM secrets: ${inventory.options.includeDmSecrets ? 'included' : 'excluded'}`,
      `- Played state: ${inventory.options.includePlayedState ? 'included' : 'excluded'}`,
      `- Player-authored content: ${inventory.options.includePlayerContent ? 'included' : 'excluded'}`,
      '',
      '## Policy',
      '',
      '| Category | Status |',
      '| --- | --- |',
      `| Member identities | ${yes(inventory.policy.memberIdentities)} |`,
      `| Audit history | ${yes(inventory.policy.audit)} |`,
      `| Proposals | ${yes(inventory.policy.proposals)} |`,
      `| Operational history (RSVPs, attendance, dice log, revisions) | ${yes(inventory.policy.operationalHistory)} |`,
      `| Private / whisper notes | ${yes(inventory.policy.privateNotes)} |`,
      `| Player-authored content | ${yes(inventory.policy.playerContent)} |`,
      `| Played state | ${yes(inventory.policy.playedState)} |`,
      `| DM secrets | ${yes(inventory.policy.dmSecrets)} |`,
      `| Credentials / capabilities | ${yes(inventory.policy.credentials)} |`,
      '',
      '## Inventory',
      '',
      '| Module | Included | Redacted | Reason |',
      '| --- | ---: | ---: | --- |',
    ];
    for (const row of inventory.rows) {
      lines.push(`| ${this.mdCell(row.module)} | ${row.included} | ${row.redacted} | ${this.mdCell(row.reason ?? '')} |`);
    }
    lines.push(
      '',
      '## Attachments',
      '',
      `- Listed: ${inventory.attachments.included}`,
      `- Bytes withheld: ${inventory.attachments.bytesWithheld}`,
      `- Filenames neutralized: ${inventory.attachments.filenamesNeutralized}`,
      `- Files with embedded metadata stripped: ${inventory.attachments.metadataStripped}`,
      ...inventory.attachments.notes.map((n) => `- ${n}`),
      '',
      '## Identifier scan',
      '',
      `- Known private identifiers swept for: ${inventory.identifiers.scanned}`,
      `- Literal occurrences redacted: ${inventory.identifiers.occurrencesRedacted}`,
      `- Not swept (too short to match safely): ${inventory.identifiers.unscannable.length}`,
      `- Distinct contributors pseudonymized: ${inventory.pseudonyms.contributors}`,
      '',
      '## Limitations',
      '',
      ...inventory.limitations.map((l) => `- ${l}`),
      '',
    );
    return lines.join('\n');
  }

  private campaignMarkdown(campaign: ProfileExportData['campaign'], notes: ProfileExportData['notes']): string {
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
        lines.push(`- \`${typedRecordId('note', n.id)}\` (${n.visibility}) by ${this.authorLabel(n)}`);
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
    c: ProfileExportData['characters'][number],
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
        lines.push(`| ${this.mdCell(a.name)} | ${this.mdCell(a.kind) || '_'} | ${this.mdCell(a.toHit) || '_'} | ${this.mdCell(a.damage) || '_'} | ${this.mdCell(a.notes) || '_'} |`);
      }
    }
    // Numeric sort so spell-slot levels order 1,2,…,10 rather than lexicographic 1,10,2.
    const slotKeys = c.spellSlots
      ? Object.keys(c.spellSlots).sort((a, b) => Number(a) - Number(b))
      : [];
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
      // Grid calibration (issue #417) — surfaced whenever ANY field differs from the top-left
      // square default (origin 0,0; square cells; no rotation; default opacity 0.35) so an
      // unaligned export stays terse but no persisted calibration state is ever lost.
      ...(e.gridOffsetX ||
      e.gridOffsetY ||
      e.gridRotation ||
      e.gridCellHeight != null ||
      (e.gridOpacity != null && e.gridOpacity !== 0.35)
        ? [
            `- Origin offset: ${e.gridOffsetX}%, ${e.gridOffsetY}% (of map width)`,
            `- Cell height: ${e.gridCellHeight != null ? `${e.gridCellHeight}%` : '_square_'}`,
            `- Rotation: ${e.gridRotation}°`,
            `- Opacity: ${e.gridOpacity ?? 0.35}`,
          ]
        : []),
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
          `| ${this.mdCell(c.name)} | ${this.mdCell(c.kind)} | ${c.initiative ?? '_unrolled_'} | ${c.hpCurrent}/${c.hpMax} | ${token} | ${c.conditions.length ? c.conditions.map((cond) => this.mdCell(cond)).join(', ') : '_none_'} | ${links} |`,
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

  private sessionZeroMarkdown(sz: ExportData['sessionZero'], includePlayerContent = true): string {
    if (!sz) {
      return ['# Session zero', '', '_No session-zero charter configured._', ''].join('\n');
    }
    // Lines/veils/safety tools are the group's own words about their own limits — the
    // redaction policy treats them as participant-authored (issue #586), so a profile
    // that withholds player content renders a placeholder rather than the list.
    const list = (items: string[] | undefined) =>
      !includePlayerContent
        ? '_withheld by the export redaction policy_'
        : items?.length
          ? items.map((i) => `- ${i}`).join('\n')
          : '_none_';
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
          `| ${typedRecordId('inventory-item', item.id)} | ${this.mdCell(item.name)} | ${item.qty} | ${owner} | ${this.mdCell(item.notes) || '_'} |`,
        );
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  private noteMarkdown(n: ProfileExportData['notes'][number]): string {
    return [
      ...this.identityHeader('note', n.id, `Note ${n.id}`),
      `- Visibility: ${n.visibility}`,
      `- Author: ${this.authorLabel(n)}`,
      `- Anchor: ${n.entityType && n.entityId != null ? typedRecordId(n.entityType, n.entityId) : '_unanchored_'}`,
      '',
      '## Body',
      '',
      n.body || '_none_',
      '',
    ].join('\n');
  }

  private commentMarkdown(c: ProfileExportData['comments'][number]): string {
    return [
      ...this.identityHeader('comment', c.id, `Comment ${c.id}`),
      `- Author: ${this.authorLabel(c)}`,
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
        `| ${typedRecordId('member', m.id)} | ${this.mdCell(m.displayName || m.username || m.userId)} | ${this.mdCell(m.role)} | ${m.characterId != null ? typedRecordId('character', m.characterId) : '_'} | ${m.disabled ? 'yes' : 'no'} |`,
      );
    }
    lines.push('');
    return lines.join('\n');
  }

  private diceRollsMarkdown(rolls: ExportData['diceRolls']): string {
    const lines = [
      '# Dice log',
      '',
      '_Shared campaign dice log, including physical/manual entries logged at the table (issue #673)._',
      '',
    ];
    if (!rolls.length) {
      lines.push('_none_', '');
      return lines.join('\n');
    }
    lines.push('| When | Who | Kind | Label | Total | DC | Natural d20 |', '| --- | --- | --- | --- | ---: | ---: | ---: |');
    for (const r of rolls) {
      const who = this.mdCell(r.actor?.trim() || r.rollerName?.trim() || r.rollerUserId);
      const kind = r.source === 'manual' ? 'physical' : 'rolled';
      lines.push(
        `| ${r.createdAt} | ${who} | ${kind} | ${this.mdCell(r.label ?? '')} | ${r.total} | ${r.dc ?? ''} | ${r.natural20 ?? ''} |`,
      );
    }
    lines.push('');
    return lines.join('\n');
  }

  private auditMarkdown(audit: ExportData['audit'], truncated = 0): string {
    const lines = ['# Audit log', ''];
    if (truncated > 0) {
      lines.push(
        `_${truncated} older/concurrent row(s) are omitted from this snapshot (see archive-manifest.json truncations and auditMeta in campaign.json)._`,
        '',
      );
    }
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

  private aiConfigMarkdown(aiSeat: ExportData['aiSeat'], aiScribeConfig: ExportData['aiScribeConfig']): string {
    const lines = [
      '# AI configuration',
      '',
      '_DM-authored AI steering (issue #1078). Runtime usage counters and encrypted provider keys are NOT exported._',
      '',
      '## Co-DM seat',
      '',
    ];
    if (aiSeat) {
      lines.push(
        `- Mode: ${aiSeat.mode}`,
        `- Enabled: ${aiSeat.enabled ? 'yes' : 'no'}`,
        `- Model: ${aiSeat.model || '_default_'}`,
        `- Token budget: ${aiSeat.tokenBudget ?? '_unset_'}`,
        '',
        '### Instructions',
        '',
        aiSeat.instructions?.trim() || '_none_',
        '',
      );
    } else {
      lines.push('_No AI seat configured._', '');
    }
    lines.push('## Scribe', '');
    if (aiScribeConfig) {
      lines.push(
        `- Post-session: ${aiScribeConfig.postSession ? 'yes' : 'no'}`,
        `- Cron: ${aiScribeConfig.cron ? `\`${this.mdCell(aiScribeConfig.cron)}\`` : '_none_'}`,
        `- Budget per run: ${aiScribeConfig.budgetPerRun ?? '_unset_'}`,
        '',
      );
    } else {
      lines.push('_No scribe configured._', '');
    }
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
