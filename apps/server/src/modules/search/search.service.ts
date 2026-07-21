import { Injectable } from '@nestjs/common';
import type { MentionTarget, Role, SearchResponse, SearchResult, SearchResultType } from '@campfire/schema';
import type { RequestUser } from '../../common/user.types';
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

/** Max results returned from one search (keeps a broad query bounded). */
const DEFAULT_LIMIT = 50;
/** Characters of context to show on each side of a body/recap match in the snippet. */
const SNIPPET_PAD = 60;

/** One searchable field of an entity: which field it is, and its text. */
type Field = { field: string; text: string };

/**
 * Build the snippet shown for a hit. For a short field (a name/title) we show it
 * whole; for long prose (body/recap) we window ±SNIPPET_PAD chars around the first
 * occurrence of the needle so the match is visible in context. The needle is the
 * already-lowercased query; `text` is matched case-insensitively.
 */
function makeSnippet(text: string, needle: string): string {
  const idx = text.toLowerCase().indexOf(needle);
  if (idx < 0) return text.slice(0, SNIPPET_PAD * 2).trim();
  const start = Math.max(0, idx - SNIPPET_PAD);
  const end = Math.min(text.length, idx + needle.length + SNIPPET_PAD);
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

/**
 * Campaign-wide free-text search across quests, NPCs, factions, locations,
 * characters, sessions, notes, timeline events, inventory items, discussion
 * comments and (DM-only) story arcs/beats (issues #64, #265).
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
 * inventory items carry no secrecy and are member-visible.
 */
@Injectable()
export class SearchService {
  constructor(
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
  ) {}

  async search(campaignId: number, user: RequestUser, role: Role, q: string, limit = DEFAULT_LIMIT): Promise<SearchResponse> {
    const needle = q.trim().toLowerCase();
    if (!needle) return { query: q, results: [] };

    const isDm = role === 'dm';
    const [quests, npcs, factions, locations, characters, sessions, notes, timelineEvents, items, comments, arcs] = await Promise.all([
      this.quests.listForCampaign(campaignId, role),
      this.npcs.listForCampaign(campaignId, role),
      this.factions.listForCampaign(campaignId, role),
      this.locations.listForCampaign(campaignId, role),
      this.characters.listForCampaign(campaignId, role),
      this.sessions.listForCampaign(campaignId, role),
      this.notes.listForCampaign(campaignId, user, role, {}),
      this.timeline.listEvents(campaignId, role),
      this.inventory.listForCampaign(campaignId),
      this.comments.listForCampaign(campaignId, role),
      // Story arcs/beats are DM-only prep content (issue #27) — never fetch them
      // for a non-DM, so a player's search can't surface a planned twist.
      isDm ? this.storylines.listArcsWithBeats(campaignId) : Promise.resolve([]),
    ]);

    const results: SearchResult[] = [];
    const push = (type: SearchResultType, id: number, title: string, fields: Field[], extra?: Partial<SearchResult>) => {
      const hit = fields.find((f) => f.text && f.text.toLowerCase().includes(needle));
      if (!hit) return;
      results.push({
        type,
        id,
        campaignId,
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
    for (const s of sessions) {
      const title = s.title || `Session ${s.number}`;
      push('session', s.id, title, [
        { field: 'title', text: title },
        // The sessions list carries a short recapExcerpt, not the full recap body (#71
        // trimmed it for pagination); searching the excerpt keeps this a cheap list read.
        { field: 'recap', text: s.recapExcerpt },
        { field: 'dmSecret', text: s.dmSecret },
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

    // name/title hits first, then by title for a stable ordering.
    results.sort((a, b) => fieldRank(a.matchedField) - fieldRank(b.matchedField) || a.title.localeCompare(b.title));
    return { query: q, results: results.slice(0, limit) };
  }

  /**
   * The named, page-backed entities the caller may @-mention / auto-link, drawn
   * from the same role-filtered lists as search — so a player's mention list can
   * never include a hidden NPC or unexplored location. Sessions are titled
   * `Session N` when they have no explicit title.
   */
  async mentions(campaignId: number, role: Role): Promise<MentionTarget[]> {
    const isDm = role === 'dm';
    const [quests, npcs, factions, locations, characters, sessions, timelineEvents, arcs] = await Promise.all([
      this.quests.listForCampaign(campaignId, role),
      this.npcs.listForCampaign(campaignId, role),
      this.factions.listForCampaign(campaignId, role),
      this.locations.listForCampaign(campaignId, role),
      this.characters.listForCampaign(campaignId, role),
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
