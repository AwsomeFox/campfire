/**
 * Applies an {@link ResolvedExportPolicy} to the full DM backup payload (issue #586).
 *
 * `ExportService.buildExport()` remains the single source of truth for "everything in
 * this campaign". This module is the only place that turns that into a narrower
 * document, so there is exactly one code path to audit when asking "can X appear in a
 * published archive?".
 *
 * Pipeline, in order — the order matters:
 *   1. collect every private identifier the server knows about from the RAW payload;
 *   2. drop whole modules the policy excludes;
 *   3. project each surviving row through its per-entity field ALLOWLIST
 *      (see export-profiles.ts — do not turn this into a denylist);
 *   4. replace retained author identities with per-export pseudonyms;
 *   5. sweep the ENTIRE projected document (values AND object keys) for the
 *      identifiers from step 1 and redact literal occurrences.
 *
 * Step 3 is the control. Step 5 is defence in depth for free text a DM typed by hand
 * ("remind Sarah about her backstory") which no field allowlist can catch.
 */

import {
  DM_SECRET_FIELDS,
  PLAYED_STATE_FIELDS,
  PLAYER_CONTENT_FIELDS,
  PRISTINE_STATE,
  PUBLISHABLE_FIELDS,
  ExportPseudonymizer,
  pickFields,
  partitionIdentifiers,
  redactIdentifiers,
  type ExportInventoryRow,
  type ResolvedExportPolicy,
} from './export-profiles';

type Row = Record<string, unknown>;
type EntityKind = keyof typeof PUBLISHABLE_FIELDS;

const asRows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const asRow = (value: unknown): Row | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null;

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Effective allowlist for an entity kind under a policy. */
function fieldsFor(kind: EntityKind, policy: ResolvedExportPolicy): string[] {
  const fields: string[] = [...PUBLISHABLE_FIELDS[kind]];
  if (policy.dmSecrets && kind in DM_SECRET_FIELDS) {
    fields.push(...DM_SECRET_FIELDS[kind as keyof typeof DM_SECRET_FIELDS]);
  }
  if (policy.playedState && kind in PLAYED_STATE_FIELDS) {
    fields.push(...PLAYED_STATE_FIELDS[kind as keyof typeof PLAYED_STATE_FIELDS]);
  }
  // This encounter-time value is historical played state, but it is also
  // DM-only allegiance data. A publish export needs both explicit opt-ins.
  if (policy.playedState && policy.dmSecrets && kind === 'combatant') {
    fields.push('npcDispositionSnapshot');
  }
  // Hidden NPC staging travels only with DM secrets. Its duplicate combatants need
  // this internal source id to remain redacted after a handoff/import round trip.
  if (policy.dmSecrets && kind === 'combatant') {
    fields.push('npcIdentitySourceId');
  }
  if (policy.playerContent && kind in PLAYER_CONTENT_FIELDS) {
    fields.push(...PLAYER_CONTENT_FIELDS[kind as keyof typeof PLAYER_CONTENT_FIELDS]);
  }
  return fields;
}

/**
 * Project one row: allowlist first, then backfill pristine defaults for the played
 * state we just withheld so the document still imports as a fresh, unplayed module.
 */
function projectRow(row: Row, kind: EntityKind, policy: ResolvedExportPolicy): Row {
  const out = pickFields(row, fieldsFor(kind, policy));
  if (!policy.playedState && PRISTINE_STATE[kind]) Object.assign(out, PRISTINE_STATE[kind]);
  return out;
}

/** Keys present on the raw rows that the projection withheld — reported to the DM. */
function withheldFields(raw: Row[], projected: Row[]): string[] {
  const rawKeys = new Set<string>();
  for (const row of raw) for (const key of Object.keys(row)) rawKeys.add(key);
  const keptKeys = new Set<string>();
  for (const row of projected) for (const key of Object.keys(row)) keptKeys.add(key);
  return [...rawKeys].filter((key) => !keptKeys.has(key)).sort();
}

/**
 * Every string this server can prove is an account identity. Character names, NPC
 * names and in-fiction actor labels are deliberately NOT collected: they are the
 * content a publishable module exists to carry, and sweeping them out of prose
 * would gut the artifact.
 */
export function collectPrivateIdentifiers(raw: Row, extra: ReadonlyArray<unknown> = []): string[] {
  const found: string[] = [];
  const add = (value: unknown) => {
    const s = str(value);
    if (s) found.push(s);
  };
  // #1548/#588 — `assignedDmUserId` (organized-play running DM) never appears on
  // `raw.scheduledSessions` any more: ExportService strips it (with the rest of
  // organized-play decoration) before `raw` is built, so it can't be scanned as a
  // field on `raw` here. It is NOT reliably a campaign member either — createSeries
  // accepts an assignedDmUserId without requiring membership in the exported
  // campaign (organized-play.service.ts), so `raw.members[].userId` cannot be
  // trusted to already cover it. ExportService passes the pre-strip values through
  // `extra` instead, purely for this free-text sweep — they are never added back to
  // `raw` and so cannot leak into the projected/exported document itself.
  for (const value of extra) add(value);

  for (const m of asRows(raw.members)) {
    add(m.userId != null ? String(m.userId) : null);
    add(m.username);
    add(m.displayName);
  }
  for (const n of asRows(raw.notes)) {
    add(n.authorUserId);
    add(n.authorName);
    add(n.recipientUserId);
    add(n.recipientName);
  }
  for (const c of asRows(raw.comments)) {
    add(c.authorUserId);
    add(c.authorName);
    add(c.deletedBy);
    add(c.editedBy);
  }
  for (const p of asRows(raw.proposals)) {
    add(p.proposer);
    add(p.proposerUserId);
    add(p.proposerToken);
    add(p.resolvedBy);
  }
  for (const r of asRows(raw.revisions)) {
    add(r.authorUserId);
    add(r.authorName);
    add(r.replacedByUserId);
    add(r.replacedByName);
  }
  for (const s of asRows(raw.scheduledSessions)) {
    add(s.cancelledBy);
    // #588 added `assignedDmUserId` (the organized-play running DM) here as an
    // account identity to scan, same reasoning as `cancelledBy` above. #1548
    // stripped `assignedDmUserId` out of `raw.scheduledSessions` entirely
    // (organized-play decoration import never restores), so it can no longer be
    // scanned as a field here — see the `extra` parameter above, which is how
    // ExportService still sweeps it from free text without shipping it in the
    // export payload.
    for (const rsvp of asRows(s.rsvps)) {
      add(rsvp.userId);
      add(rsvp.userName);
    }
  }
  for (const d of asRows(raw.diceRolls)) {
    add(d.rollerUserId);
    add(d.rollerName);
    // `actor` is a DM-typed in-fiction label for physical rolls, not an account — skipped on purpose.
  }
  for (const a of asRows(raw.audit)) add(a.actor);
  for (const ch of asRows(raw.characters)) add(ch.ownerUserId);
  for (const item of asRows(raw.inventory)) add(item.deletedBy);
  for (const att of asRows(raw.attachments)) add(att.uploaderUserId);

  return [...new Set(found)];
}

export type ExportProjection = {
  data: Row;
  rows: ExportInventoryRow[];
  scannedIdentifiers: string[];
  unscannableIdentifiers: string[];
  occurrencesRedacted: number;
  contributors: number;
};

export const MODULE_EXCLUSION_REASONS: Record<string, string> = {
  members: 'Member roster (user ids, usernames, display names) is excluded outside the backup profile.',
  audit: 'Operational audit history is excluded outside the backup profile.',
  auditMeta: 'Audit snapshot metadata is excluded with the audit trail.',
  auditNote: 'Audit portability note is excluded with the audit trail.',
  proposals: 'Proposal queue (proposer identity + arbitrary entity payloads) is excluded outside the backup profile.',
  revisions: 'Prose revision provenance names the humans who wrote and replaced each version.',
  scheduledSessions: 'Planned game nights carry per-member RSVPs and availability notes.',
  sessionAttendance: 'Per-session attendance records who was at the table.',
  diceRolls: 'The shared dice log attributes every roll to a member.',
  aiSeat: 'AI seat configuration is capability/credential-shaped operational state.',
  aiScribeConfig: 'AI scribe configuration is capability/credential-shaped operational state.',
  sessions: 'Session recaps are played state; enable the played-state option to include them.',
  characters: 'Characters are player-authored; enable the player-content option to include them.',
  comments: 'Discussion comments are player-authored; enable the player-content option to include them.',
  inventory: 'Party inventory is player-authored/played state; enable the player-content option to include it.',
  treasury: 'Party treasury is player-authored/played state; enable the player-content option to include it.',
};

/**
 * Build the redacted document.
 *
 * `raw` is the untouched {@link ExportService.buildExport} payload. For the `backup`
 * profile this returns it verbatim (with an empty inventory of redactions) — backup
 * must remain byte-for-byte the artifact it always was.
 */
export function projectExport(raw: Row, policy: ResolvedExportPolicy, extra: ReadonlyArray<unknown> = []): ExportProjection {
  const pseudonymizer = new ExportPseudonymizer();
  const rows: ExportInventoryRow[] = [];
  const identifiers = collectPrivateIdentifiers(raw, extra);
  const { scannable, unscannable } = partitionIdentifiers(identifiers);

  if (!policy.allowlistProjection) {
    // Backup: no projection, no sweep, no pseudonyms. Report the full row counts so
    // the pre-export inventory is still an honest "what am I about to download".
    for (const [key, value] of Object.entries(raw)) {
      if (Array.isArray(value)) rows.push({ module: key, included: value.length, redacted: 0 });
    }
    return {
      data: raw,
      rows: rows.sort((a, b) => a.module.localeCompare(b.module)),
      scannedIdentifiers: [],
      unscannableIdentifiers: [],
      occurrencesRedacted: 0,
      contributors: 0,
    };
  }

  const data: Row = {};

  const note = (module: string, included: number, redacted: number, reason?: string, fields?: string[]) => {
    const entry: ExportInventoryRow = { module, included, redacted };
    if (reason && (redacted > 0 || (fields?.length ?? 0) > 0)) entry.reason = reason;
    if (fields && fields.length) entry.fieldsWithheld = fields;
    rows.push(entry);
  };

  const excludeModule = (module: string, rawValue: unknown) => {
    const count = Array.isArray(rawValue) ? rawValue.length : rawValue == null ? 0 : 1;
    rows.push({ module, included: 0, redacted: count, reason: MODULE_EXCLUSION_REASONS[module] ?? 'Excluded by the redaction policy.' });
  };

  /** Project a list module, optionally filtering rows out first. */
  const list = (
    module: string,
    kind: EntityKind,
    keep: (row: Row) => boolean,
    dropReason: string,
    transform?: (projected: Row, rawRow: Row) => Row,
  ) => {
    const source = asRows(raw[module]);
    const kept = source.filter(keep);
    const projected = kept.map((row) => {
      const out = projectRow(row, kind, policy);
      return transform ? transform(out, row) : out;
    });
    data[module] = projected;
    note(module, projected.length, source.length - kept.length, dropReason, withheldFields(source, projected));
  };

  // ── campaign ───────────────────────────────────────────────────────────────
  const campaign = asRow(raw.campaign);
  data.campaign = campaign ? projectRow(campaign, 'campaign', policy) : campaign;
  note(
    'campaign',
    campaign ? 1 : 0,
    0,
    'Campaign row is projected through the field allowlist (sharing/invite switches, storage quota, ICS token, trash state and timestamps are withheld).',
    campaign ? withheldFields([campaign], [data.campaign as Row]) : [],
  );

  // ── world content ──────────────────────────────────────────────────────────
  // NOTE: `hidden` is NOT a drop gate. Campfire is private-by-default (#42/#262), so
  // nearly every quest/NPC/location starts hidden — dropping hidden rows would empty
  // a publishable module of the very content it exists to carry. Hidden-ness is
  // in-campaign reveal STAGING, not a privacy classification; the private thing on
  // these rows is `dmSecret`, which the allowlist withholds unless the DM opts in.
  // The `hidden` FLAG itself is DM-facing staging state and rides with DM secrets, so
  // a published module arrives fully revealed rather than pre-staged for someone
  // else's table.
  const keepAll = () => true;

  list('quests', 'quest', keepAll, '', (out, rawRow) => {
    const objectives = asRows(rawRow.objectives).map((o) => pickFields(o, PUBLISHABLE_FIELDS.questObjective));
    if (policy.playedState) {
      const done = asRows(rawRow.objectives).map((o) => o.done);
      objectives.forEach((o, i) => (o.done = done[i] ?? false));
    } else {
      objectives.forEach((o) => (o.done = false));
    }
    out.objectives = objectives;
    return out;
  });
  list('npcs', 'npc', keepAll, '');
  list('locations', 'location', keepAll, '');
  list('factions', 'faction', keepAll, '');
  list('timelineEvents', 'timelineEvent', keepAll, '');

  list('storyArcs', 'storyArc', () => true, '', (out, rawRow) => {
    out.beats = asRows(rawRow.beats).map((beat) => {
      const projectedBeat = projectRow(beat, 'storyBeat', policy);
      projectedBeat.branches = asRows(beat.branches).map((b) => pickFields(b, PUBLISHABLE_FIELDS.storyBranch));
      return projectedBeat;
    });
    return out;
  });

  list('encounters', 'encounter', keepAll, '', (out, rawRow) => {
    out.combatants = asRows(rawRow.combatants).map((c) => {
      const projected = projectRow(c, 'combatant', policy);
      // Reset the live pools the played-state allowlist withheld so an unplayed
      // module opens with full-health combatants instead of `undefined`.
      if (!policy.playedState) {
        projected.hpCurrent = c.hpMax ?? 0;
        projected.spCurrent = c.spMax ?? 0;
        projected.rpCurrent = c.rpMax ?? 0;
      }
      return projected;
    });
    // Fog reveal history is played state even when the fog CONFIG is authored.
    if (policy.dmSecrets) {
      const fog = asRow(rawRow.fog);
      out.fog = fog ? { ...fog, revealed: policy.playedState ? fog.revealed : [] } : null;
    }
    return out;
  });

  // ── timeline calendar / session zero ───────────────────────────────────────
  const calendar = asRow(raw.timelineCalendar);
  data.timelineCalendar = calendar ? projectRow(calendar, 'timelineCalendar', policy) : calendar;
  note('timelineCalendar', calendar ? 1 : 0, 0, 'Current in-world date is played state.', calendar ? withheldFields([calendar], [data.timelineCalendar as Row]) : []);

  const sessionZero = asRow(raw.sessionZero);
  data.sessionZero = sessionZero ? projectRow(sessionZero, 'sessionZero', policy) : sessionZero;
  note(
    'sessionZero',
    sessionZero ? 1 : 0,
    0,
    'Lines, veils and safety tools are the group’s own words (player-authored); house rules and tone are always carried.',
    sessionZero ? withheldFields([sessionZero], [data.sessionZero as Row]) : [],
  );

  // ── played state ───────────────────────────────────────────────────────────
  if (policy.playedState) {
    list('sessions', 'session', () => true, '');
  } else {
    excludeModule('sessions', raw.sessions);
    data.sessions = [];
  }

  // ── player-authored ────────────────────────────────────────────────────────
  if (policy.playerContent) {
    list('characters', 'character', () => true, '', (out, rawRow) => {
      const owner = str(rawRow.ownerUserId);
      // Retained authorship becomes a per-export pseudonym; the real id never ships.
      if (owner && policy.pseudonymizeAuthors) out.ownerPseudonym = pseudonymizer.label(owner);
      if (!policy.playedState) out.hpCurrent = rawRow.hpMax ?? 0;
      return out;
    });
    list('comments', 'comment', (row) => row.deletedAt == null, 'Tombstoned comments are omitted.', (out, rawRow) => {
      if (policy.pseudonymizeAuthors) out.authorPseudonym = pseudonymizer.label(str(rawRow.authorUserId));
      return out;
    });
    list('inventory', 'inventoryItem', (row) => row.deletedAt == null, 'Trashed inventory rows are omitted.');
    const treasury = asRow(raw.treasury);
    data.treasury = treasury ? pickFields(treasury, PUBLISHABLE_FIELDS.treasury) : treasury;
    note('treasury', treasury ? 1 : 0, 0, '', treasury ? withheldFields([treasury], [data.treasury as Row]) : []);
  } else {
    excludeModule('characters', raw.characters);
    excludeModule('comments', raw.comments);
    excludeModule('inventory', raw.inventory);
    excludeModule('treasury', raw.treasury);
    data.characters = [];
    data.comments = [];
    data.inventory = [];
    data.treasury = null;
  }

  // ── notes ──────────────────────────────────────────────────────────────────
  // private + whisper are one member's prose and never travel. dm_shared rides with
  // the DM-secret opt-in; party_shared with the player-content opt-in.
  const noteVisible = (row: Row): boolean => {
    const v = row.visibility;
    if (v === 'private' || v === 'whisper') return policy.privateNotes;
    if (v === 'dm_shared') return policy.dmSecrets;
    if (v === 'party_shared') return policy.playerContent;
    return false;
  };
  list(
    'notes',
    'note',
    noteVisible,
    'Private and whisper notes are never exported outside the backup profile; dm_shared follows the DM-secrets option and party_shared the player-content option.',
    (out, rawRow) => {
      if (policy.pseudonymizeAuthors) out.authorPseudonym = pseudonymizer.label(str(rawRow.authorUserId));
      return out;
    },
  );

  // ── identity / operations / credentials ────────────────────────────────────
  if (policy.memberIdentities) data.members = raw.members;
  else {
    excludeModule('members', raw.members);
    data.members = [];
  }

  if (policy.audit) {
    data.audit = raw.audit;
    data.auditMeta = raw.auditMeta;
    data.auditNote = raw.auditNote;
  } else {
    excludeModule('audit', raw.audit);
    data.audit = [];
    data.auditMeta = null;
    data.auditNote =
      'Audit history is excluded from this profile by the redaction policy (see redaction.policy.audit). ' +
      'Use the backup profile or a full-server backup to retain it.';
  }

  if (policy.proposals) data.proposals = raw.proposals;
  else {
    excludeModule('proposals', raw.proposals);
    data.proposals = [];
  }

  if (policy.operationalHistory) {
    data.revisions = raw.revisions;
    data.scheduledSessions = raw.scheduledSessions;
    data.sessionAttendance = raw.sessionAttendance;
    data.diceRolls = raw.diceRolls;
  } else {
    excludeModule('revisions', raw.revisions);
    excludeModule('scheduledSessions', raw.scheduledSessions);
    excludeModule('sessionAttendance', raw.sessionAttendance);
    excludeModule('diceRolls', raw.diceRolls);
    data.revisions = [];
    data.scheduledSessions = [];
    data.sessionAttendance = [];
    data.diceRolls = [];
  }

  if (policy.credentials) {
    data.aiSeat = raw.aiSeat;
    data.aiScribeConfig = raw.aiScribeConfig;
    data.aiScribeJobs = raw.aiScribeJobs;
    data.aiScribeJobsTruncated = raw.aiScribeJobsTruncated;
  } else {
    excludeModule('aiSeat', raw.aiSeat);
    excludeModule('aiScribeConfig', raw.aiScribeConfig);
    excludeModule('aiScribeJobs', raw.aiScribeJobs);
    data.aiSeat = null;
    data.aiScribeConfig = null;
    data.aiScribeJobs = [];
    data.aiScribeJobsTruncated = 0;
  }

  // ── attachments (metadata; bytes are decided by the service, which has disk) ──
  const rawAttachments = asRows(raw.attachments);
  const projectedAttachments = rawAttachments.map((a) => {
    const out = pickFields(a, PUBLISHABLE_FIELDS.attachment);
    if (policy.neutralizeAttachmentFilenames) {
      const ext = typeof a.file === 'string' ? String(a.file).split('.').pop() : undefined;
      out.filename = `attachment-${a.id}${ext ? `.${ext}` : ''}`;
      out.originalFilenameWithheld = true;
    }
    return out;
  });
  data.attachments = projectedAttachments;
  note(
    'attachments',
    projectedAttachments.length,
    0,
    policy.neutralizeAttachmentFilenames
      ? 'Uploader identity is withheld and filenames are replaced with content-neutral names.'
      : 'Uploader identity is withheld.',
    withheldFields(rawAttachments, projectedAttachments),
  );

  // ── carried-through notes (no identity content) ────────────────────────────
  data.compendiumDependencies = raw.compendiumDependencies;
  data.compendiumNote = raw.compendiumNote;
  data.attachmentsNote = raw.attachmentsNote;
  data.participantSupportNote = raw.participantSupportNote;

  // ── step 5: the sweep ──────────────────────────────────────────────────────
  const swept = policy.scanFreeText ? redactIdentifiers(data, scannable) : { value: data, occurrences: 0 };

  return {
    data: swept.value,
    rows: rows.sort((a, b) => a.module.localeCompare(b.module)),
    scannedIdentifiers: policy.scanFreeText ? scannable : [],
    unscannableIdentifiers: policy.scanFreeText ? unscannable : [],
    occurrencesRedacted: swept.occurrences,
    contributors: pseudonymizer.size,
  };
}
