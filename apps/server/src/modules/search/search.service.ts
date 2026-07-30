import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { MentionTarget, Role, SearchResponse, SearchResult, SearchResultType } from '@campfire/schema';
import type { RequestUser } from '../../common/user.types';
import { compareSearchText, foldForSearch, foldedIndexOf, matchesSearchQuery, scheduledAtSearchText } from '../../common/text-search';
import { notDeleted } from '../../common/soft-delete';
import { anchorVisibilitySql } from '../../common/anchor-visibility';
import { CAMPAIGN_SEARCH_FTS_AVAILABLE, DB, type DrizzleDb } from '../../db/db.module';
import {
  characters,
  comments,
  campaigns,
  encounters,
  factions,
  inventoryItems,
  locations,
  notes,
  npcs,
  quests,
  scheduledSessions,
  sessions,
  storyArcs,
  storyBeats,
  timelineEvents,
} from '../../db/schema';
import { blockedTargetsOf } from '../../common/safety-controls';
import { NpcsService } from '../npcs/npcs.service';
import { FactionsService } from '../factions/factions.service';
import { QuestsService } from '../quests/quests.service';
import { LocationsService } from '../locations/locations.service';
import { CharactersService } from '../characters/characters.service';
import { SessionsService } from '../sessions/sessions.service';
import { NotesService } from '../notes/notes.service';
import { TimelineService } from '../timeline/timeline.service';
import { InventoryService } from '../inventory/inventory.service';
import { CommentsService } from '../comments/comments.service';
import { StorylinesService } from '../storylines/storylines.service';
import { EncountersService } from '../encounters/encounters.service';
import { SchedulingService } from '../sessions/scheduling.service';

/** Max results returned from one search (keeps a broad query bounded). */
const DEFAULT_LIMIT = 50;
/**
 * Hard cap on how many rows of EACH collection the LIKE/full-scan fallback
 * scans (issue #1481). The fallback loads whole collections and matches in JS,
 * so without a cap a campaign with tens of thousands of one entity type would
 * do an unbounded scan on every keystroke — the exact O(n) walk #533 removed for
 * the FTS path. Generous enough that a normal campaign never hits it (so the
 * fallback still returns the same set as FTS); when it IS hit the response is
 * marked `truncated` so the user knows the list may be incomplete.
 */
const FALLBACK_COLLECTION_SCAN_CAP = 1000;
/** Characters of context to show on each side of a body/recap match in the snippet. */
const SNIPPET_PAD = 60;

/**
 * One searchable field of an entity: which field it is, its display `text` (used
 * for the snippet, original spelling preserved), and an optional `matchText`
 * that overrides only what the query is matched against. `matchText` lets a field
 * match against a tokenized form that differs from its display value — e.g. a
 * scheduled-session date matches the space-separated token composite the FTS5
 * aux column stores, while the snippet still shows the clean ISO timestamp
 * (issue #1481).
 */
type Field = { field: string; text: string; matchText?: string };
type Candidate = { type: SearchResultType; id: number; rank: number };
type HitInput = {
  type: SearchResultType;
  id: number;
  title: string;
  fields: Field[];
  extra?: Partial<SearchResult>;
};

const FTS_TITLE_COLUMNS = '{title name title_fold name_fold}';
const FTS_PUBLIC_COLUMNS = '{title name body aux title_fold name_fold body_fold aux_fold}';
const FTS_DM_COLUMNS = '{title name body aux dm_secret title_fold name_fold body_fold aux_fold dm_secret_fold}';

/**
 * Build the snippet shown for a hit. For a short field (a name/title) we show it
 * whole; for long prose (body/recap) we window ±SNIPPET_PAD chars around the first
 * occurrence of the needle so the match is visible in context. The needle is the
 * already-folded query (see foldForSearch); `text` is matched via the same fold.
 * The returned snippet always slices the original `text` so spelling is preserved.
 */
function makeSnippet(text: string, foldedNeedle: string): string {
  const idx = foldedIndexOf(text, foldedNeedle);
  if (idx < 0) return text.slice(0, SNIPPET_PAD * 2).trim();
  // Folded index is exact when NFKC is length-stable; clamp for compatibility forms.
  const approx = Math.min(Math.max(0, idx), text.length);
  const start = Math.max(0, approx - SNIPPET_PAD);
  const end = Math.min(text.length, approx + foldedNeedle.length + SNIPPET_PAD);
  const core = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${core}${end < text.length ? '…' : ''}`;
}

/**
 * Rank of the field that matched, best (0) first: a name/title hit outranks a
 * body/recap hit (mirrors RulesService.nameMatchRank's intent). Drives the
 * secondary sort within a result set so the most relevant hits float up.
 */
function fieldRank(field: string): number {
  if (field === 'name' || field === 'title') return 0;
  return 1;
}

/** Escapes an FTS5 MATCH query string by quoting each token and enabling prefix matching. */
function toFtsQuery(q: string): string {
  const tokens = q
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.replace(/["]/g, ''))
    .filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"*`).join(' ');
}

function candidateKey(type: SearchResultType, id: number): string {
  return `${type}:${id}`;
}

/**
 * Campaign-wide free-text search across quests, NPCs, factions, locations,
 * characters, sessions, encounters, scheduled sessions, notes, timeline events,
 * inventory items, discussion comments and (DM-only) story arcs/beats (issues
 * #64, #265, #843).
 *
 * SECURITY MODEL: this service never touches the database directly. It builds
 * every result from the entity services' `listForCampaign(role)` (and the notes
 * service's visibility-filtered list), which already (a) drop entities the role
 * may not see — hidden quests/NPCs, unexplored locations, private/dm_shared notes
 * (#42/#59) — and (b) redact `dmSecret` to '' for non-DM. So a non-DM's search
 * can neither surface a hidden entity nor match against a secret they can't read:
 * the redacted text simply isn't in the object being scanned. The types added in
 * #265 follow the same rule: timeline events are role-filtered by
 * `listEvents(role)` (hidden dropped, dmSecret redacted); comments inherit their
 * anchor entity's visibility via `CommentsService.listForCampaign(role)` (#230);
 * story arcs/beats are DM-only prep content and are indexed ONLY for role 'dm';
 * inventory items carry no secrecy and are member-visible. Encounters and
 * schedules use bounded search projections: encounter visibility and linked-label
 * visibility are applied in SQL, while schedule search omits RSVP rows entirely.
 */
@Injectable()
export class SearchService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    @Inject(CAMPAIGN_SEARCH_FTS_AVAILABLE) private readonly campaignSearchFtsAvailable: boolean,
    private readonly quests: QuestsService,
    private readonly npcs: NpcsService,
    private readonly factions: FactionsService,
    private readonly locations: LocationsService,
    private readonly characters: CharactersService,
    private readonly sessions: SessionsService,
    private readonly notes: NotesService,
    private readonly timeline: TimelineService,
    private readonly inventory: InventoryService,
    private readonly comments: CommentsService,
    private readonly storylines: StorylinesService,
    private readonly encounters: EncountersService,
    private readonly scheduling: SchedulingService,
  ) {}

  async search(campaignId: number, user: RequestUser, role: Role, q: string, limit = DEFAULT_LIMIT): Promise<SearchResponse> {
    const needle = foldForSearch(q.trim());
    if (!needle) return this.toResponse(q, [], limit);
    if (!this.campaignSearchFtsAvailable) {
      return this.searchFallback(campaignId, user, role, q, limit);
    }

    const ftsQuery = toFtsQuery(needle);
    if (!ftsQuery) return this.toResponse(q, [], limit);

    const candidateLimit = Math.max(limit * 8, 100);
    const titleCandidates = this.searchFtsCandidates(campaignId, role, user, `${FTS_TITLE_COLUMNS}: ${ftsQuery}`, candidateLimit);
    const fullColumns = role === 'dm' ? FTS_DM_COLUMNS : FTS_PUBLIC_COLUMNS;
    const fullCandidates = this.searchFtsCandidates(campaignId, role, user, `${fullColumns}: ${ftsQuery}`, candidateLimit);

    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    for (const candidate of [...titleCandidates, ...fullCandidates]) {
      const key = candidateKey(candidate.type, candidate.id);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
    // If either candidate query hit its LIMIT, the index may hold more matches we
    // never retrieved — surface that as truncation rather than silently returning
    // a partial list (issue #1481).
    const candidateCapHit = candidates.length >= candidateLimit;

    const results = await this.hydrateFtsCandidates(campaignId, user, role, needle, candidates);
    results.sort(
      (a, b) => fieldRank(a.matchedField) - fieldRank(b.matchedField) || compareSearchText(a.title, b.title),
    );
    return this.toResponse(q, results, limit, candidateCapHit);
  }

  /**
   * Build a {@link SearchResponse} with honest truncation accounting (issue #1481).
   * `allResults` is the FULL ordered match list BEFORE slicing; `total` reports
   * that count and `truncated` is true when even one more match exists than is
   * returned, OR when `forceTruncated` says the scan/index was itself bounded
   * (fallback per-collection cap hit, or FTS candidate LIMIT hit) and more
   * matches may exist that were never examined.
   */
  private toResponse(q: string, allResults: SearchResult[], limit: number, forceTruncated = false): SearchResponse {
    const total = allResults.length;
    const results = allResults.slice(0, Math.max(0, limit));
    return { query: q, results, total, truncated: forceTruncated || total > results.length };
  }

  private async searchFallback(
    campaignId: number,
    user: RequestUser,
    role: Role,
    q: string,
    limit = DEFAULT_LIMIT,
  ): Promise<SearchResponse> {
    // Fold once; encounter/schedule helpers receive this same folded needle (#624).
    const needle = foldForSearch(q.trim());
    if (!needle) return this.toResponse(q, [], limit);

    const isDm = role === 'dm';
    // Bound the per-collection full scan (issue #1481): each generic collection
    // is loaded whole and matched in JS, so cap how many rows of each we actually
    // scan. Generous (normal campaigns never hit it); when any collection exceeds
    // it, `scanCapped` flags the response truncated because matches beyond the cap
    // were never examined.
    let scanCapped = false;
    const capScan = <T>(p: Promise<T[]>): Promise<T[]> =>
      p.then((rows) => {
        if (rows.length > FALLBACK_COLLECTION_SCAN_CAP) {
          scanCapped = true;
          return rows.slice(0, FALLBACK_COLLECTION_SCAN_CAP);
        }
        return rows;
      });
    const [
      quests,
      npcs,
      factions,
      locations,
      characters,
      notes,
      timelineEvents,
      items,
      comments,
      arcs,
      encounterHits,
      scheduledSessionHits,
      sessionHits,
    ] = await Promise.all([
      capScan(this.quests.listForCampaign(campaignId, role)),
      capScan(this.npcs.listForCampaign(campaignId, role)),
      capScan(this.factions.listForCampaign(campaignId, role)),
      capScan(this.locations.listForCampaign(campaignId, role)),
      capScan(this.characters.listForCampaign(campaignId, user, role)),
      capScan(this.notes.listAllForCampaign(campaignId, user, role, {})),
      capScan(this.timeline.listEvents(campaignId, role)),
      capScan(this.inventory.listForCampaign(campaignId)),
      capScan(this.comments.listForCampaign(campaignId, role)),
      // Story arcs/beats are DM-only prep content (issue #27) — never fetch them
      // for a non-DM, so a player's search can't surface a planned twist.
      capScan(isDm ? this.storylines.listArcsWithBeats(campaignId) : Promise.resolve([])),
      // The bounded search projections self-cap (min(limit, 50)), so they need no
      // further cap here; their own ordering/visibility is authoritative.
      this.encounters.searchForCampaign(campaignId, role, needle, limit),
      this.scheduling.searchForCampaign(campaignId, needle, limit),
      this.sessions.searchForCampaign(campaignId, role, needle, limit),
    ]);
    // The bounded search projections (encounters / scheduled sessions / sessions)
    // self-cap at min(limit, 50) and return one extra row as a cap sentinel, so
    // the fallback can detect that cap and propagate truncation without a second
    // count (issue #1481): if any projection returned more than its cap, more
    // matches exist than were kept and the response must be flagged incomplete.
    const boundedLimit = Math.max(1, Math.min(limit, 50));
    const encounterCapped = encounterHits.length > boundedLimit;
    const scheduledSessionCapped = scheduledSessionHits.length > boundedLimit;
    const sessionCapped = sessionHits.length > boundedLimit;
    if (encounterCapped || scheduledSessionCapped || sessionCapped) {
      scanCapped = true;
    }
    const encounterRows = encounterCapped ? encounterHits.slice(0, boundedLimit) : encounterHits;
    const scheduledSessionRows = scheduledSessionCapped ? scheduledSessionHits.slice(0, boundedLimit) : scheduledSessionHits;
    const sessionRows = sessionCapped ? sessionHits.slice(0, boundedLimit) : sessionHits;

    const results: SearchResult[] = [];
    const push = (type: SearchResultType, id: number, title: string, fields: Field[], extra?: Partial<SearchResult>) => {
      // Prefix-token match (matchesSearchQuery) keeps the fallback on the SAME
      // semantics as the FTS5 index, so a query returns the same set on either
      // backend (issue #1481) — plain substring (foldedIncludes) used to make
      // "ex" match "Vexley" only here, never on FTS. Matching reads `matchText`
      // when present (the token form) but the snippet always renders `text` (the
      // clean display value, e.g. a raw ISO date rather than its space-separated
      // twin).
      const hit = fields.find((f) => {
        const candidateText = f.matchText ?? f.text;
        return candidateText && matchesSearchQuery(candidateText, needle);
      });
      if (!hit) return;
      results.push({
        type,
        id,
        campaignId,
        // Titles/snippets keep original spelling — fold is comparison-only (#624).
        title,
        snippet: makeSnippet(hit.text, needle),
        matchedField: hit.field,
        entityType: extra?.entityType ?? null,
        entityId: extra?.entityId ?? null,
      });
    };

    for (const quest of quests) {
      push('quest', quest.id, quest.title, [
        { field: 'title', text: quest.title },
        { field: 'body', text: quest.body },
        { field: 'reward', text: quest.reward },
        { field: 'dmSecret', text: quest.dmSecret },
      ]);
    }
    for (const npc of npcs) {
      push('npc', npc.id, npc.name, [
        { field: 'name', text: npc.name },
        { field: 'role', text: npc.role },
        { field: 'body', text: npc.body },
        { field: 'dmSecret', text: npc.dmSecret },
      ]);
    }
    for (const faction of factions) {
      push('faction', faction.id, faction.name, [
        { field: 'name', text: faction.name },
        { field: 'kind', text: faction.kind },
        { field: 'body', text: faction.body },
        { field: 'goals', text: faction.goals },
        { field: 'dmSecret', text: faction.dmSecret },
      ]);
    }
    for (const loc of locations) {
      push('location', loc.id, loc.name, [
        { field: 'name', text: loc.name },
        { field: 'kind', text: loc.kind },
        { field: 'body', text: loc.body },
        { field: 'dmSecret', text: loc.dmSecret },
      ]);
    }
    for (const ch of characters) {
      push('character', ch.id, ch.name, [
        { field: 'name', text: ch.name },
        { field: 'species', text: ch.species },
        { field: 'className', text: ch.className },
        { field: 'background', text: ch.background },
        { field: 'notes', text: ch.notes },
        { field: 'dmSecret', text: ch.dmSecret },
      ]);
    }
    for (const s of sessionRows) {
      const title = s.title.trim() || `Session ${s.number}`;
      push('session', s.id, title, [
        { field: 'title', text: title },
        // Full recap body via SessionsService.searchForCampaign (issue #442).
        { field: 'recap', text: s.recap },
        { field: 'dmSecret', text: s.dmSecret },
      ]);
    }
    for (const encounter of encounterRows) {
      push('encounter', encounter.id, encounter.name, [
        { field: 'name', text: encounter.name },
        { field: 'location', text: encounter.locationLabel },
        { field: 'quest', text: encounter.questLabel },
        { field: 'session', text: encounter.sessionLabel },
      ]);
    }
    for (const scheduled of scheduledSessionRows) {
      const title = scheduled.title.trim()
        || `Scheduled session — ${scheduled.scheduledAt.slice(0, 16).replace('T', ' ')} UTC`;
      // Match against the SAME composite scheduling.searchForCampaign (and the
      // FTS5 aux column) use — else a date/time query the bounded read matched
      // would be dropped here because "19" is buried in the raw "20T19" token
      // (issue #1481) — but keep the raw ISO as the display/snippet text so the
      // rendered snippet is the clean timestamp, not the doubled composite.
      push('scheduled_session', scheduled.id, title, [
        { field: 'title', text: scheduled.title },
        { field: 'scheduledAt', text: scheduled.scheduledAt, matchText: scheduledAtSearchText(scheduled.scheduledAt) },
        { field: 'notes', text: scheduled.notes },
      ]);
    }
    for (const note of notes) {
      push('note', note.id, note.entityName ? `Note on ${note.entityName}` : 'Note', [{ field: 'body', text: note.body }], {
        entityType: note.entityType,
        entityId: note.entityId,
      });
    }
    for (const event of timelineEvents) {
      // listEvents(role) already dropped hidden events and redacted dmSecret to ''
      // for non-DM, so scanning dmSecret here can only ever match for a DM.
      push('timeline', event.id, event.title, [
        { field: 'title', text: event.title },
        { field: 'inWorldDate', text: event.inWorldDate },
        { field: 'era', text: event.era },
        { field: 'body', text: event.body },
        { field: 'dmSecret', text: event.dmSecret },
      ]);
    }
    for (const item of items) {
      push('item', item.id, item.name, [
        { field: 'name', text: item.name },
        { field: 'notes', text: item.notes },
      ]);
    }
    for (const comment of comments) {
      // Anchored to the entity it discusses — link/deep-link go to that entity
      // (its thread), mirroring how notes anchor to their entity.
      push('comment', comment.id, `Comment on ${comment.entityType}`, [{ field: 'body', text: comment.body }], {
        entityType: comment.entityType,
        entityId: comment.entityId,
      });
    }
    for (const arc of arcs) {
      push('arc', arc.id, arc.title, [
        { field: 'title', text: arc.title },
        { field: 'summary', text: arc.summary },
      ]);
      for (const beat of arc.beats) {
        push('beat', beat.id, beat.title, [
          { field: 'title', text: beat.title },
          { field: 'body', text: beat.body },
        ]);
      }
    }

    // name/title hits first, then by title with explicit en collation (#624).
    results.sort(
      (a, b) => fieldRank(a.matchedField) - fieldRank(b.matchedField) || compareSearchText(a.title, b.title),
    );
    return this.toResponse(q, results, limit, scanCapped);
  }

  private campaignSearchVisibilitySql(role: Role, user: RequestUser) {
    const noteVisibility = role === 'dm'
      ? sql`(n.visibility = 'party_shared' OR n.author_user_id = ${user.id} OR n.visibility = 'dm_shared' OR n.visibility = 'whisper')`
      : sql`(n.visibility = 'party_shared' OR n.author_user_id = ${user.id} OR (n.visibility = 'whisper' AND n.recipient_user_id = ${user.id}))`;
    const commentAnchorVisible = anchorVisibilitySql(
      sql.raw('c.entity_type'),
      sql.raw('c.entity_id'),
      sql.raw('c.campaign_id'),
      role,
    );

    return sql`(
      (campaign_search_fts.entity_type = 'quest' AND EXISTS (
        SELECT 1 FROM quests q
        WHERE q.id = campaign_search_fts.entity_id AND q.campaign_id = campaign_search_fts.campaign_id
          AND q.deleted_at IS NULL ${role === 'dm' ? sql`` : sql`AND q.hidden = 0`}
      ))
      OR (campaign_search_fts.entity_type = 'npc' AND EXISTS (
        SELECT 1 FROM npcs n
        WHERE n.id = campaign_search_fts.entity_id AND n.campaign_id = campaign_search_fts.campaign_id
          AND n.deleted_at IS NULL ${role === 'dm' ? sql`` : sql`AND n.hidden = 0`}
      ))
      OR (campaign_search_fts.entity_type = 'faction' AND EXISTS (
        SELECT 1 FROM factions f
        WHERE f.id = campaign_search_fts.entity_id AND f.campaign_id = campaign_search_fts.campaign_id
          AND f.deleted_at IS NULL ${role === 'dm' ? sql`` : sql`AND f.hidden = 0`}
      ))
      OR (campaign_search_fts.entity_type = 'location' AND EXISTS (
        SELECT 1 FROM locations l
        WHERE l.id = campaign_search_fts.entity_id AND l.campaign_id = campaign_search_fts.campaign_id
          AND l.deleted_at IS NULL ${role === 'dm' ? sql`` : sql`AND l.status <> 'unexplored'`}
      ))
      OR (campaign_search_fts.entity_type = 'character' AND EXISTS (
        SELECT 1 FROM characters ch
        WHERE ch.id = campaign_search_fts.entity_id AND ch.campaign_id = campaign_search_fts.campaign_id AND ch.deleted_at IS NULL
          ${role === 'dm' ? sql`` : sql`AND ch.owner_user_id = ${user.id}`}
      ))
      OR (campaign_search_fts.entity_type = 'session' AND EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.id = campaign_search_fts.entity_id AND s.campaign_id = campaign_search_fts.campaign_id AND s.deleted_at IS NULL
      ))
      OR (campaign_search_fts.entity_type = 'note' AND EXISTS (
        SELECT 1 FROM notes n
        WHERE n.id = campaign_search_fts.entity_id AND n.campaign_id = campaign_search_fts.campaign_id
          -- quarantined_at IS NULL (issue #601): same reasoning as the comment branch
          -- below. The note visibility rule deliberately knows nothing about quarantine,
          -- so a withheld note or whisper would otherwise come back here as a body
          -- snippet — to the whole campaign for a party_shared note, and to the very
          -- recipient the quarantine exists to shield for a whisper.
          AND n.kind = 'note' AND n.deleted_at IS NULL AND n.quarantined_at IS NULL AND ${noteVisibility}
      ))
      OR (campaign_search_fts.entity_type = 'timeline' AND EXISTS (
        SELECT 1 FROM timeline_events t
        WHERE t.id = campaign_search_fts.entity_id AND t.campaign_id = campaign_search_fts.campaign_id
          AND t.deleted_at IS NULL ${role === 'dm' ? sql`` : sql`AND t.hidden = 0`}
      ))
      OR (campaign_search_fts.entity_type = 'item' AND EXISTS (
        SELECT 1 FROM inventory_items i
        WHERE i.id = campaign_search_fts.entity_id AND i.campaign_id = campaign_search_fts.campaign_id AND i.deleted_at IS NULL
      ))
      OR (campaign_search_fts.entity_type = 'comment' AND EXISTS (
        SELECT 1 FROM comments c
        WHERE c.id = campaign_search_fts.entity_id AND c.campaign_id = campaign_search_fts.campaign_id
          -- quarantined_at IS NULL (issue #601): a moderation quarantine must withhold
          -- the body from SEARCH too, not just from the thread view. The FTS index still
          -- holds the original prose (it mirrors the row, and reindexing on every
          -- moderation action would be a second source of truth to keep in sync), so the
          -- withholding has to happen in this visibility predicate — otherwise a snippet
          -- of the abusive text would come back through the search results.
          AND c.deleted_at IS NULL AND c.quarantined_at IS NULL AND ${commentAnchorVisible}
      ))
      OR (${role === 'dm' ? sql`1 = 1` : sql`0 = 1`} AND campaign_search_fts.entity_type = 'arc' AND EXISTS (
        SELECT 1 FROM story_arcs a
        WHERE a.id = campaign_search_fts.entity_id AND a.campaign_id = campaign_search_fts.campaign_id AND a.deleted_at IS NULL
      ))
      OR (${role === 'dm' ? sql`1 = 1` : sql`0 = 1`} AND campaign_search_fts.entity_type = 'beat' AND EXISTS (
        SELECT 1 FROM story_beats b
        WHERE b.id = campaign_search_fts.entity_id AND b.campaign_id = campaign_search_fts.campaign_id AND b.deleted_at IS NULL
      ))
      OR (campaign_search_fts.entity_type = 'encounter' AND EXISTS (
        SELECT 1 FROM encounters e
        WHERE e.id = campaign_search_fts.entity_id AND e.campaign_id = campaign_search_fts.campaign_id
          AND e.deleted_at IS NULL ${role === 'dm' ? sql`` : sql`AND e.hidden = 0`}
      ))
      OR (campaign_search_fts.entity_type = 'scheduled_session' AND EXISTS (
        SELECT 1 FROM scheduled_sessions ss
        WHERE ss.id = campaign_search_fts.entity_id AND ss.campaign_id = campaign_search_fts.campaign_id
          -- A cancelled night is search's equivalent of a soft-deleted row (#504):
          -- before cancellation became a lifecycle state it was a hard DELETE, so
          -- search never returned one, and SearchResult has no status field to badge
          -- it with. Mirrors SchedulingService.searchForCampaign's filter.
          AND ss.status != 'cancelled'
      ))
    )`;
  }

  private searchFtsCandidates(campaignId: number, role: Role, user: RequestUser, matchQuery: string, limit: number): Candidate[] {
    const rows = this.db.all<{ type: string; id: number; rank: number }>(sql`
      SELECT campaign_search_fts.entity_type AS type, campaign_search_fts.entity_id AS id, campaign_search_fts.rank AS rank
      FROM campaign_search_fts
      WHERE campaign_search_fts.campaign_id = ${campaignId}
        AND campaign_search_fts MATCH ${matchQuery}
        AND ${this.campaignSearchVisibilitySql(role, user)}
      ORDER BY campaign_search_fts.rank, campaign_search_fts.rowid
      LIMIT ${limit}
    `);
    return rows.map((r) => ({ type: r.type as SearchResultType, id: Number(r.id), rank: Number(r.rank) }));
  }

  private async hydrateFtsCandidates(
    campaignId: number,
    user: RequestUser,
    role: Role,
    needle: string,
    candidates: Candidate[],
  ): Promise<SearchResult[]> {
    const idsByType = new Map<SearchResultType, number[]>();
    for (const candidate of candidates) {
      idsByType.set(candidate.type, [...(idsByType.get(candidate.type) ?? []), candidate.id]);
    }
    const ids = (type: SearchResultType) => idsByType.get(type) ?? [];
    const byKey = new Map<string, HitInput>();
    const addHit = (hit: HitInput) => byKey.set(candidateKey(hit.type, hit.id), hit);

    const questIds = ids('quest');
    if (questIds.length) {
      const rows = await this.db.select().from(quests).where(and(
        eq(quests.campaignId, campaignId),
        inArray(quests.id, questIds),
        notDeleted(quests.deletedAt),
        role === 'dm' ? undefined : eq(quests.hidden, false),
      ));
      for (const quest of rows) {
        addHit({ type: 'quest', id: quest.id, title: quest.title, fields: [
          { field: 'title', text: quest.title },
          { field: 'body', text: quest.body },
          { field: 'reward', text: quest.reward },
          { field: 'dmSecret', text: role === 'dm' ? quest.dmSecret : '' },
        ] });
      }
    }

    const npcIds = ids('npc');
    if (npcIds.length) {
      const rows = await this.db.select().from(npcs).where(and(
        eq(npcs.campaignId, campaignId),
        inArray(npcs.id, npcIds),
        notDeleted(npcs.deletedAt),
        role === 'dm' ? undefined : eq(npcs.hidden, false),
      ));
      for (const npc of rows) {
        addHit({ type: 'npc', id: npc.id, title: npc.name, fields: [
          { field: 'name', text: npc.name },
          { field: 'role', text: npc.role },
          { field: 'body', text: npc.body },
          { field: 'dmSecret', text: role === 'dm' ? npc.dmSecret : '' },
        ] });
      }
    }

    const factionIds = ids('faction');
    if (factionIds.length) {
      const rows = await this.db.select().from(factions).where(and(
        eq(factions.campaignId, campaignId),
        inArray(factions.id, factionIds),
        notDeleted(factions.deletedAt),
        role === 'dm' ? undefined : eq(factions.hidden, false),
      ));
      for (const faction of rows) {
        addHit({ type: 'faction', id: faction.id, title: faction.name, fields: [
          { field: 'name', text: faction.name },
          { field: 'kind', text: faction.kind },
          { field: 'body', text: faction.body },
          { field: 'goals', text: faction.goals },
          { field: 'dmSecret', text: role === 'dm' ? faction.dmSecret : '' },
        ] });
      }
    }

    const locationIds = ids('location');
    if (locationIds.length) {
      const rows = await this.db.select().from(locations).where(and(
        eq(locations.campaignId, campaignId),
        inArray(locations.id, locationIds),
        notDeleted(locations.deletedAt),
        role === 'dm' ? undefined : sql`${locations.status} <> 'unexplored'`,
      ));
      for (const loc of rows) {
        addHit({ type: 'location', id: loc.id, title: loc.name, fields: [
          { field: 'name', text: loc.name },
          { field: 'kind', text: loc.kind },
          { field: 'body', text: loc.body },
          { field: 'dmSecret', text: role === 'dm' ? loc.dmSecret : '' },
        ] });
      }
    }

    const characterIds = ids('character');
    if (characterIds.length) {
      const rows = await this.db.select().from(characters).where(and(
        eq(characters.campaignId, campaignId),
        inArray(characters.id, characterIds),
        notDeleted(characters.deletedAt),
        role === 'dm' ? undefined : eq(characters.ownerUserId, user.id),
      ));
      for (const ch of rows) {
        addHit({ type: 'character', id: ch.id, title: ch.name, fields: [
          { field: 'name', text: ch.name },
          { field: 'species', text: ch.species },
          { field: 'className', text: ch.className },
          { field: 'background', text: ch.background },
          { field: 'notes', text: ch.notes },
          { field: 'dmSecret', text: role === 'dm' ? ch.dmSecret : '' },
        ] });
      }
    }

    const sessionIds = ids('session');
    if (sessionIds.length) {
      const rows = await this.db.select().from(sessions).where(and(
        eq(sessions.campaignId, campaignId),
        inArray(sessions.id, sessionIds),
        notDeleted(sessions.deletedAt),
      ));
      for (const s of rows) {
        const title = s.title.trim() || `Session ${s.number}`;
        addHit({ type: 'session', id: s.id, title, fields: [
          { field: 'title', text: title },
          { field: 'recap', text: s.recap },
          { field: 'dmSecret', text: role === 'dm' ? s.dmSecret : '' },
        ] });
      }
    }

    const noteIds = ids('note');
    if (noteIds.length) {
      const rows = await this.db.select().from(notes).where(and(
        eq(notes.campaignId, campaignId),
        inArray(notes.id, noteIds),
        eq(notes.kind, 'note'),
        notDeleted(notes.deletedAt),
        // Issue #601 — this hydration reads `note.body` straight off the row and the
        // inlined canSee below knows nothing about quarantine, so the filter has to be
        // repeated here exactly as it is for comments further down.
        notDeleted(notes.quarantinedAt),
      ));
      const noteEntityNames = await this.resolveNoteEntityNames(campaignId, rows);
      // Issue #597: a personal block hides the blocked member's notes from the blocker's
      // reads, and full-text search must honour the same rule — otherwise the one place
      // blocked content stays reachable is a search box, which is the surface most likely
      // to surface it out of context. Mirrors the filter in NotesService.listForCampaign.
      const blockedAuthors = await blockedTargetsOf(this.db, user.id, campaignId);
      for (const note of rows) {
        const canSee =
          note.visibility === 'party_shared'
          || note.authorUserId === user.id
          || (role === 'dm' && (note.visibility === 'dm_shared' || note.visibility === 'whisper'))
          || (note.visibility === 'whisper' && note.recipientUserId === user.id);
        if (!canSee) continue;
        if (note.authorUserId !== user.id && blockedAuthors.has(note.authorUserId)) continue;
        const entityName = note.entityType && note.entityId != null
          ? noteEntityNames.get(`${note.entityType}:${note.entityId}`) ?? null
          : null;
        addHit({
          type: 'note',
          id: note.id,
          title: entityName ? `Note on ${entityName}` : 'Note',
          fields: [{ field: 'body', text: note.body }],
          extra: { entityType: note.entityType as SearchResult['entityType'], entityId: note.entityId },
        });
      }
    }

    const timelineIds = ids('timeline');
    if (timelineIds.length) {
      const rows = await this.db.select().from(timelineEvents).where(and(
        eq(timelineEvents.campaignId, campaignId),
        inArray(timelineEvents.id, timelineIds),
        notDeleted(timelineEvents.deletedAt),
        role === 'dm' ? undefined : eq(timelineEvents.hidden, false),
      ));
      for (const event of rows) {
        addHit({ type: 'timeline', id: event.id, title: event.title, fields: [
          { field: 'title', text: event.title },
          { field: 'inWorldDate', text: event.inWorldDate },
          { field: 'era', text: event.era },
          { field: 'body', text: event.body },
          { field: 'dmSecret', text: role === 'dm' ? event.dmSecret : '' },
        ] });
      }
    }

    const itemIds = ids('item');
    if (itemIds.length) {
      const rows = await this.db.select().from(inventoryItems).where(and(
        eq(inventoryItems.campaignId, campaignId),
        inArray(inventoryItems.id, itemIds),
        notDeleted(inventoryItems.deletedAt),
      ));
      for (const item of rows) {
        addHit({ type: 'item', id: item.id, title: item.name, fields: [
          { field: 'name', text: item.name },
          { field: 'notes', text: item.notes },
        ] });
      }
    }

    const commentIds = ids('comment');
    if (commentIds.length) {
      const rows = await this.db.select().from(comments).where(and(
        eq(comments.campaignId, campaignId),
        inArray(comments.id, commentIds),
        notDeleted(comments.deletedAt),
        // Issue #601 — this hydration path reads `comment.body` straight off the row,
        // bypassing CommentsService.toDomain's placeholder, so the quarantine filter
        // has to be repeated here. Dropping the row entirely (rather than substituting
        // the placeholder) is right for search: a hit that only matches withheld text
        // is not a useful result, and returning it would confirm what the text said.
        notDeleted(comments.quarantinedAt),
      ));
      for (const comment of rows) {
        addHit({
          type: 'comment',
          id: comment.id,
          title: `Comment on ${comment.entityType}`,
          fields: [{ field: 'body', text: comment.body }],
          extra: { entityType: comment.entityType as SearchResult['entityType'], entityId: comment.entityId },
        });
      }
    }

    if (role === 'dm') {
      const arcIds = ids('arc');
      if (arcIds.length) {
        const rows = await this.db.select().from(storyArcs).where(and(
          eq(storyArcs.campaignId, campaignId),
          inArray(storyArcs.id, arcIds),
          notDeleted(storyArcs.deletedAt),
        ));
        for (const arc of rows) {
          addHit({ type: 'arc', id: arc.id, title: arc.title, fields: [
            { field: 'title', text: arc.title },
            { field: 'summary', text: arc.summary },
          ] });
        }
      }

      const beatIds = ids('beat');
      if (beatIds.length) {
        const rows = await this.db.select().from(storyBeats).where(and(
          eq(storyBeats.campaignId, campaignId),
          inArray(storyBeats.id, beatIds),
          notDeleted(storyBeats.deletedAt),
        ));
        for (const beat of rows) {
          addHit({ type: 'beat', id: beat.id, title: beat.title, fields: [
            { field: 'title', text: beat.title },
            { field: 'body', text: beat.body },
          ] });
        }
      }
    }

    const encounterIds = ids('encounter');
    if (encounterIds.length) {
      const questLabel = role === 'dm'
        ? sql<string>`coalesce(${quests.title}, '')`
        : sql<string>`case when ${quests.hidden} = 0 then coalesce(${quests.title}, '') else '' end`;
      const locationLabel = role === 'dm'
        ? sql<string>`coalesce(${locations.name}, '')`
        : sql<string>`case when ${locations.status} <> 'unexplored' then coalesce(${locations.name}, '') else '' end`;
      const sessionLabel = sql<string>`case
        when ${sessions.id} is null then ''
        when length(trim(coalesce(${sessions.title}, ''))) > 0 then ${sessions.title}
        else 'Session ' || ${sessions.number}
      end`;
      const rows = await this.db
        .select({
          id: encounters.id,
          name: encounters.name,
          locationLabel,
          questLabel,
          sessionLabel,
        })
        .from(encounters)
        .leftJoin(locations, and(eq(locations.id, encounters.locationId), eq(locations.campaignId, campaignId), notDeleted(locations.deletedAt)))
        .leftJoin(quests, and(eq(quests.id, encounters.questId), eq(quests.campaignId, campaignId), notDeleted(quests.deletedAt)))
        .leftJoin(sessions, and(eq(sessions.id, encounters.sessionId), eq(sessions.campaignId, campaignId), notDeleted(sessions.deletedAt)))
        .where(and(
          eq(encounters.campaignId, campaignId),
          inArray(encounters.id, encounterIds),
          notDeleted(encounters.deletedAt),
          role === 'dm' ? undefined : eq(encounters.hidden, false),
        ));
      for (const encounter of rows) {
        addHit({ type: 'encounter', id: encounter.id, title: encounter.name, fields: [
          { field: 'name', text: encounter.name },
          { field: 'location', text: encounter.locationLabel ?? '' },
          { field: 'quest', text: encounter.questLabel ?? '' },
          { field: 'session', text: encounter.sessionLabel ?? '' },
        ] });
      }
    }

    const scheduledIds = ids('scheduled_session');
    if (scheduledIds.length) {
      const rows = await this.db.select().from(scheduledSessions).where(and(
        eq(scheduledSessions.campaignId, campaignId),
        inArray(scheduledSessions.id, scheduledIds),
        // Re-checked at hydration like every other type's deleted/hidden filter, so a
        // stale FTS candidate can never be rendered as an ordinary game night (#504).
        ne(scheduledSessions.status, 'cancelled'),
      ));
      for (const scheduled of rows) {
        const title = scheduled.title.trim()
          || `Scheduled session — ${scheduled.scheduledAt.slice(0, 16).replace('T', ' ')} UTC`;
        addHit({ type: 'scheduled_session', id: scheduled.id, title, fields: [
          { field: 'title', text: scheduled.title },
          // matchText mirrors the FTS5 aux column (space-separated date tokens)
          // so a date/time candidate the index matched survives the prefix-token
          // re-check; text stays the raw ISO for a clean snippet (issue #1481).
          { field: 'scheduledAt', text: scheduled.scheduledAt, matchText: scheduledAtSearchText(scheduled.scheduledAt) },
          { field: 'notes', text: scheduled.notes },
        ] });
      }
    }

    const results: SearchResult[] = [];
    const pushed = new Set<string>();
    for (const candidate of candidates) {
      const key = candidateKey(candidate.type, candidate.id);
      if (pushed.has(key)) continue;
      const hit = byKey.get(key);
      if (!hit) continue;
      // Same prefix-token predicate as the fallback push (issue #1481): the FTS5
      // index matches an order-independent token AND, so re-checking with a
      // contiguous-substring test (foldedIncludes) dropped every multi-token
      // candidate whose query words were not adjacent in a single field (e.g.
      // "find ledger" vs "Find the Vex Ledger"), making the default FTS path
      // return a different set than the fallback for the same query.
      const matched = hit.fields.find((f) => {
        const candidateText = f.matchText ?? f.text;
        return candidateText && matchesSearchQuery(candidateText, needle);
      });
      if (!matched) continue;
      pushed.add(key);
      results.push({
        type: hit.type,
        id: hit.id,
        campaignId,
        title: hit.title,
        snippet: makeSnippet(matched.text, needle),
        matchedField: matched.field,
        entityType: hit.extra?.entityType ?? null,
        entityId: hit.extra?.entityId ?? null,
      });
    }
    return results;
  }

  private async resolveNoteEntityNames(
    campaignId: number,
    rows: Array<{ entityType: string | null; entityId: number | null }>,
  ): Promise<Map<string, string>> {
    const idsByType = new Map<string, Set<number>>();
    for (const row of rows) {
      if (!row.entityType || row.entityId == null) continue;
      const set = idsByType.get(row.entityType) ?? new Set<number>();
      set.add(row.entityId);
      idsByType.set(row.entityType, set);
    }

    const names = new Map<string, string>();
    const addNames = (type: string, found: Array<{ id: number; name: string }>) => {
      for (const row of found) names.set(`${type}:${row.id}`, row.name);
    };

    for (const [type, idSet] of idsByType) {
      const ids = [...idSet];
      switch (type) {
        case 'quest':
          addNames(type, await this.db
            .select({ id: quests.id, name: quests.title })
            .from(quests)
            .where(and(eq(quests.campaignId, campaignId), inArray(quests.id, ids), notDeleted(quests.deletedAt))));
          break;
        case 'npc':
          addNames(type, await this.db
            .select({ id: npcs.id, name: npcs.name })
            .from(npcs)
            .where(and(eq(npcs.campaignId, campaignId), inArray(npcs.id, ids), notDeleted(npcs.deletedAt))));
          break;
        case 'location':
          addNames(type, await this.db
            .select({ id: locations.id, name: locations.name })
            .from(locations)
            .where(and(eq(locations.campaignId, campaignId), inArray(locations.id, ids), notDeleted(locations.deletedAt))));
          break;
        case 'character':
          addNames(type, await this.db
            .select({ id: characters.id, name: characters.name })
            .from(characters)
            .where(and(eq(characters.campaignId, campaignId), inArray(characters.id, ids), notDeleted(characters.deletedAt))));
          break;
        case 'session': {
          const found = await this.db
            .select({ id: sessions.id, title: sessions.title, number: sessions.number })
            .from(sessions)
            .where(and(eq(sessions.campaignId, campaignId), inArray(sessions.id, ids), notDeleted(sessions.deletedAt)));
          addNames(type, found.map((row) => ({ id: row.id, name: row.title || `Session ${row.number}` })));
          break;
        }
        case 'campaign':
          addNames(type, await this.db
            .select({ id: campaigns.id, name: campaigns.name })
            .from(campaigns)
            .where(and(eq(campaigns.id, campaignId), inArray(campaigns.id, ids), notDeleted(campaigns.deletedAt))));
          break;
        case 'encounter':
          addNames(type, await this.db
            .select({ id: encounters.id, name: encounters.name })
            .from(encounters)
            .where(and(eq(encounters.campaignId, campaignId), inArray(encounters.id, ids), notDeleted(encounters.deletedAt))));
          break;
        case 'faction':
          addNames(type, await this.db
            .select({ id: factions.id, name: factions.name })
            .from(factions)
            .where(and(eq(factions.campaignId, campaignId), inArray(factions.id, ids), notDeleted(factions.deletedAt))));
          break;
      }
    }
    return names;
  }

  /**
   * The named, page-backed entities the caller may @-mention / auto-link, drawn
   * from the same role-filtered lists as search — so a player's mention list can
   * never include a hidden NPC or unexplored location. Sessions are titled
   * `Session N` when they have no explicit title.
   */
  async mentions(campaignId: number, user: RequestUser, role: Role): Promise<MentionTarget[]> {
    const isDm = role === 'dm';
    const [quests, npcs, factions, locations, characters, sessions, timelineEvents, arcs] = await Promise.all([
      this.quests.listForCampaign(campaignId, role),
      this.npcs.listForCampaign(campaignId, role),
      this.factions.listForCampaign(campaignId, role),
      this.locations.listForCampaign(campaignId, role),
      this.characters.listForCampaign(campaignId, user, role),
      this.sessions.listForCampaign(campaignId, role),
      // Role-filtered: a hidden timeline event is dropped for non-DM.
      this.timeline.listEvents(campaignId, role),
      // Story arcs/beats are DM-only prep — only a DM gets them as link targets.
      isDm ? this.storylines.listArcsWithBeats(campaignId) : Promise.resolve([]),
    ]);
    return [
      ...quests.map((q) => ({ type: 'quest' as const, id: q.id, name: q.title })),
      ...npcs.map((n) => ({ type: 'npc' as const, id: n.id, name: n.name })),
      ...factions.map((f) => ({ type: 'faction' as const, id: f.id, name: f.name })),
      ...locations.map((l) => ({ type: 'location' as const, id: l.id, name: l.name })),
      ...characters.map((c) => ({ type: 'character' as const, id: c.id, name: c.name })),
      ...sessions.map((s) => ({ type: 'session' as const, id: s.id, name: s.title || `Session ${s.number}` })),
      ...timelineEvents.map((e) => ({ type: 'timeline' as const, id: e.id, name: e.title })),
      ...arcs.flatMap((arc) => [
        { type: 'arc' as const, id: arc.id, name: arc.title },
        ...arc.beats.map((beat) => ({ type: 'beat' as const, id: beat.id, name: beat.title })),
      ]),
    ];
  }
}
