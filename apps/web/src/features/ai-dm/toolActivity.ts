/**
 * Tool-event → query-invalidation + activity-chip map (#338 foundation, design point 5).
 *
 * `tool` SSE events are id-only by design (`{name, isError, proposed}`) so DM-only data
 * can't leak through the stream — clients refetch through the permission-checked REST
 * reads. This single map is the seam that turns each tool name into (a) the TanStack
 * Query keys to invalidate (so every open surface — the combat tracker, the party sheet,
 * the map, the proposal queue — refreshes live off the AI's actions, #344) and (b) the
 * inline chip shown in the transcript.
 *
 * Pure + data-only (no React, no query client held) so it is unit-testable and reusable.
 * `resolveToolActivity` classifies an event; `invalidateForToolEvent` performs the
 * invalidation against a passed-in client.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { queryKeys } from '../../lib/query';
import type { AiDmStreamEvent } from '../../lib/useAiDmStream';

/** Narrowed `tool` event shape. */
export type ToolStreamEvent = Extract<AiDmStreamEvent, { type: 'tool' }>;

/** The resource family a tool touches — drives which reads go stale. */
export type ToolResource = 'dice' | 'encounter' | 'party' | 'map' | 'proposals' | 'rules' | 'other';

/** How the chip reads: a normal activity, a filed proposal, or an errored call. */
export type ToolChipVariant = 'default' | 'proposal' | 'error';

/** Context needed to build invalidation keys + a chip deep-link. */
export interface ToolActivityContext {
  campaignId: number;
  /** The live encounter, when the Table sits beside the tracker — lets the chip deep-link to it. */
  encounterId?: number;
}

/** A resolved chip descriptor for the transcript. Copy is defaulted here; pages may i18n it. */
export interface ToolChip {
  resource: ToolResource;
  variant: ToolChipVariant;
  /** lucide-react icon name (pages resolve the component). */
  icon: string;
  /** Default English label; pages may translate keyed on `resource`/`name`. */
  label: string;
  /** In-app deep link for the chip, when one applies. */
  href?: string;
}

// ---- Tool → resource classification --------------------------------------

/**
 * Exact tool-name → resource overrides. Anything not listed falls through to the prefix
 * heuristic in {@link toolResource}. Names are the Campfire MCP tool ids.
 */
const RESOURCE_BY_NAME: Record<string, ToolResource> = {
  // dice → the roll log
  roll_dice: 'dice',
  // encounter / combatant / turn → the tracker
  create_encounter: 'encounter',
  update_encounter: 'encounter',
  begin_encounter: 'encounter',
  end_encounter: 'encounter',
  generate_encounter: 'encounter',
  add_combatant: 'encounter',
  remove_combatant: 'encounter',
  update_combatant: 'encounter',
  next_turn: 'encounter',
  roll_initiative: 'encounter',
  get_encounter_difficulty: 'encounter',
  // character / HP / condition → the party sheet
  upsert_character: 'party',
  update_character_hp: 'party',
  set_character_conditions: 'party',
  level_up_character: 'party',
  award_xp: 'party',
  add_inventory_item: 'party',
  update_inventory_item: 'party',
  // map / fog / reveal → the map
  generate_map: 'map',
  reveal_map_region: 'map',
  set_location_discovery: 'map',
  upsert_location: 'map',
  // rules retrieval
  lookup_rule: 'rules',
  get_rule_entry: 'rules',
};

/** Classify a tool name into its resource family (exact map, then prefix heuristics). */
export function toolResource(name: string): ToolResource {
  const exact = RESOURCE_BY_NAME[name];
  if (exact) return exact;
  if (name.startsWith('roll_')) return 'dice';
  if (name.includes('combatant') || name.includes('encounter') || name === 'next_turn') return 'encounter';
  if (name.includes('character') || name.includes('inventory') || name.includes('_xp')) return 'party';
  if (name.includes('map') || name.includes('location') || name.includes('reveal')) return 'map';
  if (name.includes('rule')) return 'rules';
  return 'other';
}

/** Humanize a snake_case tool name for a default chip label: `update_character_hp` → `Update character hp`. */
function humanizeToolName(name: string): string {
  const words = name.split('_').filter(Boolean);
  if (words.length === 0) return name;
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

// ---- Chip resolution ------------------------------------------------------

const RESOURCE_ICON: Record<ToolResource, string> = {
  dice: 'dices',
  encounter: 'swords',
  party: 'users',
  map: 'map',
  proposals: 'file-plus-2',
  rules: 'book-open',
  other: 'sparkles',
};

/**
 * Resolve a `tool` event into its transcript chip. Precedence (design point 5):
 *   `proposed` (canon edit filed for review) > `isError` (subdued failure) > resource activity.
 */
export function resolveToolActivity(event: ToolStreamEvent, ctx: ToolActivityContext): ToolChip {
  const resource = toolResource(event.name);
  const human = humanizeToolName(event.name);

  if (event.proposed) {
    return {
      resource: 'proposals',
      variant: 'proposal',
      icon: RESOURCE_ICON.proposals,
      label: 'Filed a proposal — review it',
      href: `/c/${ctx.campaignId}/proposals`,
    };
  }

  if (event.isError) {
    return { resource, variant: 'error', icon: 'alert-triangle', label: `${human} failed` };
  }

  const href =
    resource === 'encounter' && ctx.encounterId !== undefined
      ? `/c/${ctx.campaignId}/encounters/${ctx.encounterId}`
      : resource === 'party'
        ? `/c/${ctx.campaignId}/party`
        : undefined;

  return { resource, variant: 'default', icon: RESOURCE_ICON[resource], label: human, href };
}

// ---- Invalidation ---------------------------------------------------------

/**
 * The query keys that go stale when a tool of `resource` runs, given the campaign/encounter
 * context. A `proposed` call additionally invalidates the proposal queue (handled by the
 * caller below). Keys for surfaces not yet migrated onto TanStack Query are harmless no-ops
 * today and become live as #344 wires those pages onto the same registry.
 */
export function invalidationKeysForResource(resource: ToolResource, ctx: ToolActivityContext): QueryKey[] {
  const { campaignId, encounterId } = ctx;
  switch (resource) {
    case 'dice':
      return [queryKeys.campaignDiceLog(campaignId)];
    case 'encounter':
      return [
        queryKeys.campaignEncounters(campaignId),
        ...(encounterId !== undefined ? [queryKeys.encounter(encounterId)] : []),
      ];
    case 'party':
      return [queryKeys.campaignCharacters(campaignId), queryKeys.campaignParty(campaignId)];
    case 'map':
      return [queryKeys.campaignMap(campaignId)];
    case 'proposals':
      return [queryKeys.campaignProposals(campaignId)];
    case 'rules':
    case 'other':
      return [];
    default: {
      const _never: never = resource;
      void _never;
      return [];
    }
  }
}

/**
 * Refetch every read affected by one `tool` SSE event. Call this from the AI-DM stream
 * handler so the tracker, party sheet, map, and proposal queue reconcile against server
 * truth the instant the AI acts — exactly like the encounter SSE channel does for humans.
 */
export function invalidateForToolEvent(client: QueryClient, event: ToolStreamEvent, ctx: ToolActivityContext): void {
  const resource = toolResource(event.name);
  const keys = invalidationKeysForResource(resource, ctx);
  // A canon edit routed to the proposal queue: refresh proposals too, regardless of resource.
  if (event.proposed) keys.push(queryKeys.campaignProposals(ctx.campaignId));
  for (const key of keys) {
    void client.invalidateQueries({ queryKey: key });
  }
}
