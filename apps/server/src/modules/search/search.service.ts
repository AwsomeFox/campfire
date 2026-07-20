import { Injectable } from '@nestjs/common';
import type { MentionTarget, Role, SearchResponse, SearchResult, SearchResultType } from '@campfire/schema';
import type { RequestUser } from '../../common/user.types';
import { NpcsService } from '../npcs/npcs.service';
import { QuestsService } from '../quests/quests.service';
import { LocationsService } from '../locations/locations.service';
import { CharactersService } from '../characters/characters.service';
import { SessionsService } from '../sessions/sessions.service';
import { NotesService } from '../notes/notes.service';

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
 * Campaign-wide free-text search across quests, NPCs, locations, characters,
 * sessions and notes (issue #64).
 *
 * SECURITY MODEL: this service never touches the database directly. It builds
 * every result from the entity services' `listForCampaign(role)` (and the notes
 * service's visibility-filtered list), which already (a) drop entities the role
 * may not see — hidden quests/NPCs, unexplored locations, private/dm_shared notes
 * (#42/#59) — and (b) redact `dmSecret` to '' for non-DM. So a non-DM's search
 * can neither surface a hidden entity nor match against a secret they can't read:
 * the redacted text simply isn't in the object being scanned.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly quests: QuestsService,
    private readonly npcs: NpcsService,
    private readonly locations: LocationsService,
    private readonly characters: CharactersService,
    private readonly sessions: SessionsService,
    private readonly notes: NotesService,
  ) {}

  async search(campaignId: number, user: RequestUser, role: Role, q: string, limit = DEFAULT_LIMIT): Promise<SearchResponse> {
    const needle = q.trim().toLowerCase();
    if (!needle) return { query: q, results: [] };

    const [quests, npcs, locations, characters, sessions, notes] = await Promise.all([
      this.quests.listForCampaign(campaignId, role),
      this.npcs.listForCampaign(campaignId, role),
      this.locations.listForCampaign(campaignId, role),
      this.characters.listForCampaign(campaignId, role),
      this.sessions.listForCampaign(campaignId, role),
      this.notes.listForCampaign(campaignId, user, role, {}),
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
    const [quests, npcs, locations, characters, sessions] = await Promise.all([
      this.quests.listForCampaign(campaignId, role),
      this.npcs.listForCampaign(campaignId, role),
      this.locations.listForCampaign(campaignId, role),
      this.characters.listForCampaign(campaignId, role),
      this.sessions.listForCampaign(campaignId, role),
    ]);
    return [
      ...quests.map((q) => ({ type: 'quest' as const, id: q.id, name: q.title })),
      ...npcs.map((n) => ({ type: 'npc' as const, id: n.id, name: n.name })),
      ...locations.map((l) => ({ type: 'location' as const, id: l.id, name: l.name })),
      ...characters.map((c) => ({ type: 'character' as const, id: c.id, name: c.name })),
      ...sessions.map((s) => ({ type: 'session' as const, id: s.id, name: s.title || `Session ${s.number}` })),
    ];
  }
}
