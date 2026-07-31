/**
 * AI Driver grounding (#577) — separating CREATIVE NARRATION from FACTUAL CLAIMS.
 *
 * Before this module the only thing standing between the table and a fabricated rule was the
 * sentence "Never invent rules" in the system prompt. Any free-form model response with zero
 * retrieval and zero citations completed the turn with `stopReason: 'complete'` and was styled
 * and broadcast as authoritative DM narration.
 *
 * The design premise here is that a model which fabricates a rule will just as happily fabricate
 * a citation for it. So the model's self-report is never trusted. The model is asked to emit a
 * STRUCTURED citation block, and the server then validates every citation against a
 * {@link RetrievalLedger} — an append-only record of what was ACTUALLY retrieved during this
 * turn, written by the runtime at the point of retrieval, never by the model.
 *
 * A citation is supported only when its referenced id was:
 *   (a) returned by a tool/context read that ran during THIS turn,
 *   (b) under an authorized principal for THIS campaign (the driver's reads are campaign-scoped
 *       and cross-campaign args are refused before dispatch — see ai-driver.service.ts), and
 *   (c) from a call that did not error.
 * Membership in the ledger is therefore simultaneously an existence proof, a campaign-scope
 * proof, and an authorized-retrieval proof: nothing reaches the ledger except by surviving the
 * permission-checked tool layer. A cited id that is absent is unsupported — whether it was
 * hallucinated outright, borrowed from another campaign, or merely remembered from a prior turn.
 *
 * Everything in this file is pure and synchronous so the whole verdict is unit-testable without
 * a provider, a database, or a Nest bootstrap.
 */

/** Fence the model wraps its machine-readable citation block in. */
export const GROUNDING_BLOCK_START = '[[GROUNDING]]';
export const GROUNDING_BLOCK_END = '[[/GROUNDING]]';

/**
 * What kind of statement a claim is. `narration` is the creative default and needs no source;
 * `rule` and `canon` are factual assertions and are only credible with a validated citation.
 */
export type GroundingClaimKind = 'narration' | 'rule' | 'canon';

/** Source types the driver may cite. Anything else is an unknown source type (unsupported). */
export const GROUNDING_SOURCE_TYPES = [
  'rule',
  'npc',
  'quest',
  'location',
  'faction',
  'character',
  'encounter',
  'item',
  'session',
  'timeline',
  'campaign',
] as const;

export type GroundingSourceType = (typeof GROUNDING_SOURCE_TYPES)[number];

export function isGroundingSourceType(value: unknown): value is GroundingSourceType {
  return typeof value === 'string' && (GROUNDING_SOURCE_TYPES as readonly string[]).includes(value);
}

/** A model-supplied source reference. Never trusted until validated against the ledger. */
export interface GroundingCitation {
  type: GroundingSourceType;
  id: number;
}

/** A model-supplied claim, as parsed out of the grounding block. */
export interface GroundingClaim {
  /** The claim quoted from the narration (bounded; used for the DM review card). */
  text: string;
  kind: GroundingClaimKind;
  cites: GroundingCitation[];
}

/** Why a citation (or a whole claim) failed validation. Stable codes — surfaced in the API. */
export type GroundingReason =
  | 'ok'
  /** A rule/canon claim arrived with no source reference at all. */
  | 'no_citation'
  /** The cited `type` is not a source type the driver may reference. */
  | 'unknown_source_type'
  /** The cited `id` was not a positive integer. */
  | 'malformed_id'
  /** Nothing retrieved this turn produced that id — fabricated, cross-campaign, or stale. */
  | 'not_retrieved'
  /** The id appears in the ledger only via a call that errored. */
  | 'retrieval_failed'
  /** The narration asserted a canon write / DM approval that no applied tool call backs. */
  | 'false_application_claim'
  /** The grounding block was present but not parseable as the documented contract. */
  | 'block_malformed';

/** One validated source reference, with the evidence link the review UI renders. */
export interface EvaluatedCitation {
  type: string;
  id: number;
  status: 'supported' | 'unsupported';
  reason: GroundingReason;
  /** The tool that actually retrieved it this turn (only set when supported). */
  retrievedBy?: string;
  /** Deep link to the cited entity so a human can check the AI's work. */
  href?: string;
  /**
   * The backing id came from a DM-scoped read (#557), so it may name a hidden entity. The
   * verdict stays visible to everyone; the id/link are stripped for non-DMs (#825).
   */
  dmOnly?: boolean;
  /** Set on a projected copy whose DM-only id/link were withheld from this reader. */
  redacted?: boolean;
}

/** One validated claim. */
export interface EvaluatedClaim {
  index: number;
  kind: GroundingClaimKind;
  text: string;
  status: 'supported' | 'unsupported';
  reason: GroundingReason;
  citations: EvaluatedCitation[];
}

/** The whole turn's grounding verdict. */
export interface GroundingVerdict {
  /** `clean` = nothing unsupported; `unverified` = at least one unsupported claim. */
  status: 'clean' | 'unverified';
  claims: EvaluatedClaim[];
  supportedCount: number;
  unsupportedCount: number;
  /** Provider name for the ruling provenance badge (never the key/base URL). */
  provider: string;
  /** Model id actually served this turn. */
  model: string;
  /** Tool/context reads that fed the ledger, for the "evidence" list on the card. */
  retrievals: RetrievalRecord[];
}

/** One id observed coming back from an authorized read during this turn. */
export interface RetrievalRecord {
  type: GroundingSourceType;
  id: number;
  tool: string;
  ok: boolean;
  /**
   * True when the id was retrieved under the DM-scoped SEAT principal rather than the
   * player-scoped context principal — i.e. a mutating call, or a read the DM narrowly approved
   * for one secret entity (#557). Such an id may name a hidden encounter or a hidden NPC, which
   * #825 forbids putting in front of a non-DM on ANY delivery path. It stays citeable (the model
   * really did read it, so flagging its citation would cry wolf), but the id and its evidence
   * link are projected out for non-DM readers — see {@link projectGroundingClaimForRole}.
   */
  dmOnly: boolean;
}

function ledgerKey(type: string, id: number): string {
  return `${type}:${id}`;
}

/**
 * Append-only record of what the runtime ACTUALLY retrieved during one turn.
 *
 * Written exclusively by the server at the point of retrieval — from the system-prompt context
 * reads and from each executed tool call — never from anything the model says. A later, failed
 * read of an id that already succeeded must not downgrade it, so `ok` is sticky-true.
 */
export class RetrievalLedger {
  private readonly entries = new Map<string, RetrievalRecord>();

  /**
   * Record one retrieved id. `ok:false` marks an errored retrieval (cited → unsupported).
   * `dmOnly:true` marks an id that only a DM-scoped principal could see (#557/#825).
   */
  record(type: GroundingSourceType, id: number, tool: string, ok = true, dmOnly = false): void {
    if (!Number.isInteger(id) || id <= 0) return;
    const key = ledgerKey(type, id);
    const existing = this.entries.get(key);
    if (existing) {
      // A successful read outranks a failed one; the first successful tool keeps attribution.
      if (ok && !existing.ok) this.entries.set(key, { type, id, tool, ok: true, dmOnly: existing.dmOnly && dmOnly });
      // `dmOnly` is sticky-FALSE: if ANY player-scoped read this turn also returned this id, the
      // players can already see it, so there is nothing left to protect. Only an id that was
      // never surfaced by a player-visible read stays marked.
      else if (!dmOnly && existing.dmOnly) this.entries.set(key, { ...existing, dmOnly: false });
      return;
    }
    this.entries.set(key, { type, id, tool, ok, dmOnly });
  }

  get(type: string, id: number): RetrievalRecord | undefined {
    return this.entries.get(ledgerKey(type, id));
  }

  /** Every id retrieved this turn, in insertion order. */
  all(): RetrievalRecord[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Tool → the source type of the entity its TOP-LEVEL payload describes. Used together with the
 * nested collection-key map below so a single `get_campaign_summary` seeds the ledger with every
 * id it actually handed the model (that payload is what the model reasons from, so a claim about
 * an NPC named in the summary is genuinely retrieved and must validate as supported).
 */
const TOOL_PRIMARY_TYPE: ReadonlyMap<string, GroundingSourceType> = new Map<string, GroundingSourceType>([
  ['get_npc', 'npc'],
  ['list_npcs', 'npc'],
  ['get_quest', 'quest'],
  ['list_quests', 'quest'],
  ['get_location', 'location'],
  ['list_locations', 'location'],
  ['get_faction', 'faction'],
  ['list_factions', 'faction'],
  ['get_character', 'character'],
  ['get_party', 'character'],
  ['get_encounter', 'encounter'],
  ['list_encounters', 'encounter'],
  ['generate_encounter', 'encounter'],
  ['get_encounter_difficulty', 'encounter'],
  ['get_inventory_item', 'item'],
  ['list_inventory', 'item'],
  ['get_session', 'session'],
  ['get_session_recaps', 'session'],
  ['list_scheduled_sessions', 'session'],
  ['get_next_session', 'session'],
  ['get_timeline_event', 'timeline'],
  ['list_timeline', 'timeline'],
  ['lookup_rule', 'rule'],
  ['get_rule_entry', 'rule'],
  ['get_campaign_summary', 'campaign'],
]);

/** Collection key inside a JSON payload → the source type of the objects it holds. */
const COLLECTION_KEY_TYPE: ReadonlyMap<string, GroundingSourceType> = new Map<string, GroundingSourceType>([
  ['npcs', 'npc'],
  ['quests', 'quest'],
  ['locations', 'location'],
  ['location', 'location'],
  ['currentLocation', 'location'],
  ['factions', 'faction'],
  ['characters', 'character'],
  ['party', 'character'],
  ['encounters', 'encounter'],
  ['inventory', 'item'],
  ['items', 'item'],
  ['sessions', 'session'],
  ['inProgressSession', 'session'],
  ['nextSession', 'session'],
  ['timeline', 'timeline'],
  ['campaign', 'campaign'],
]);

/** Depth bound so a pathological tool payload can't drive an unbounded walk. */
const HARVEST_MAX_DEPTH = 6;
/** Node bound for the same reason (a huge campaign summary is still cheap at this cap). */
const HARVEST_MAX_NODES = 5_000;

/**
 * Harvest the entity ids an authorized read actually returned, and record them in `ledger`.
 *
 * The walk is deliberately structural rather than schema-aware: it types a `{id: n}` object by
 * the collection key that contains it, falling back to the calling tool's primary type at the
 * top level. That means adding a new read tool cannot silently create an unciteable entity
 * class — but equally, an id only ever enters the ledger if the permission-checked tool layer
 * actually returned it, so a redacted/hidden entity the seat may not see never becomes citeable.
 *
 * `ok:false` (an errored call) still records the ids so a citation resolves to
 * `retrieval_failed` rather than the vaguer `not_retrieved`.
 */
export function harvestRetrievals(
  ledger: RetrievalLedger,
  toolName: string,
  args: Record<string, unknown> | undefined,
  resultText: string | undefined,
  ok = true,
  /** True when the call ran under the DM-scoped seat principal — see {@link RetrievalRecord.dmOnly}. */
  dmOnly = false,
): void {
  const primary = TOOL_PRIMARY_TYPE.get(toolName);

  // Per-entity reads carry the id in the args, which is the strongest signal available even
  // when the payload shape is unexpected.
  if (primary && args) {
    for (const [key, value] of Object.entries(args)) {
      if (!/Id$/.test(key) || typeof value !== 'number') continue;
      const argType = ARG_NAME_TYPE.get(key);
      if (argType) ledger.record(argType, value, toolName, ok, dmOnly);
    }
  }

  if (!resultText) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return; // free-form / error payloads carry no structured ids
  }
  let budget = HARVEST_MAX_NODES;

  const walk = (node: unknown, type: GroundingSourceType | undefined, depth: number): void => {
    if (budget <= 0 || depth > HARVEST_MAX_DEPTH || node === null || typeof node !== 'object') return;
    budget -= 1;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, type, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (type && typeof obj.id === 'number') ledger.record(type, obj.id, toolName, ok, dmOnly);
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || typeof value !== 'object') continue;
      const childType = COLLECTION_KEY_TYPE.get(key) ?? (key === 'results' || key === 'entries' || key === 'items' ? type : undefined);
      if (childType) walk(value, childType, depth + 1);
      else walk(value, undefined, depth + 1);
    }
  };

  walk(parsed, primary, 0);
}

/** Entity-id argument names → their source type (used for per-entity reads). */
const ARG_NAME_TYPE: ReadonlyMap<string, GroundingSourceType> = new Map<string, GroundingSourceType>([
  ['npcId', 'npc'],
  ['questId', 'quest'],
  ['locationId', 'location'],
  ['factionId', 'faction'],
  ['characterId', 'character'],
  ['encounterId', 'encounter'],
  ['itemId', 'item'],
  ['sessionId', 'session'],
  ['eventId', 'timeline'],
  ['entryId', 'rule'],
  ['campaignId', 'campaign'],
]);

/**
 * Record the `updatedAt` each authorized read actually returned for an entity (#1501), so a later
 * seat UPDATE of that same entity can carry it as `expectedUpdatedAt` and LOSE a compare-and-set
 * race instead of silently overwriting a concurrent human edit. Mirrors {@link harvestRetrievals}'s
 * structural walk (same tool/type maps) but captures the version rather than just the id.
 *
 * The versions map is the SEAT's, not the turn's: an entity the seat read last turn is still the
 * version it last saw, and a write that no longer matches it is exactly the concurrent edit a CAS
 * exists to refuse. A successful seat write refreshes the entry (update results are entity-shaped
 * with a fresh `updatedAt`), so sequential same-turn writes compose instead of self-clobbering.
 */
export function recordDriverReadVersions(
  versions: Record<string, string>,
  toolName: string,
  args: Record<string, unknown> | undefined,
  resultText: string | undefined,
): void {
  const primary = TOOL_PRIMARY_TYPE.get(toolName);

  if (!resultText) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return; // free-form / error payloads carry no structured version.
  }
  let budget = HARVEST_MAX_NODES;

  const record = (type: GroundingSourceType, id: unknown, node: Record<string, unknown>): void => {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return;
    const updatedAt = node.updatedAt;
    if (typeof updatedAt !== 'string' || updatedAt.length === 0 || updatedAt.length > 64) return;
    versions[ledgerKey(type, id)] = updatedAt;
  };

  const walk = (node: unknown, type: GroundingSourceType | undefined, depth: number): void => {
    if (budget <= 0 || depth > HARVEST_MAX_DEPTH || node === null || typeof node !== 'object') return;
    budget -= 1;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, type, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (type) record(type, obj.id, obj);
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || typeof value !== 'object') continue;
      const childType = COLLECTION_KEY_TYPE.get(key) ?? (key === 'results' || key === 'entries' || key === 'items' ? type : undefined);
      if (childType) walk(value, childType, depth + 1);
      else walk(value, undefined, depth + 1);
    }
  };

  walk(parsed, primary, 0);
  // The same per-entity arg signal harvestRetrievals trusts: get_encounter{encounterId},
  // update_encounter{encounterId}, etc. The payload shape can vary, but a top-level `updatedAt`
  // paired with the arg id is the strongest available version signal for a single-entity read OR
  // write — so this runs even when the tool has no `primary` type (e.g. update_encounter, whose
  // result is the updated entity but which is not itself in TOOL_PRIMARY_TYPE).
  if (args) {
    for (const [key, value] of Object.entries(args)) {
      if (!/Id$/.test(key) || typeof value !== 'number') continue;
      const argType = ARG_NAME_TYPE.get(key);
      if (argType && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        record(argType, value, parsed as Record<string, unknown>);
      }
    }
  }
}

/** Read the seat's last-observed `updatedAt` for an entity, or undefined when it never read it. */
export function driverExpectedUpdatedAt(
  versions: Record<string, string> | undefined,
  type: GroundingSourceType,
  id: number,
): string | undefined {
  return versions?.[ledgerKey(type, id)];
}


/** Bounds on what the parser will accept out of a model-authored block. */
const MAX_CLAIMS = 24;
const MAX_CITES_PER_CLAIM = 8;
const MAX_CLAIM_TEXT = 400;

export interface ParsedGrounding {
  /** The narration with the machine-readable block removed (never otherwise rewritten). */
  narration: string;
  /** Claims the model declared, normalized. Empty when no block was present. */
  claims: GroundingClaim[];
  /** True when a block was present. */
  present: boolean;
  /** True when a block was present but could not be parsed as the documented contract. */
  malformed: boolean;
}

/**
 * Split a model reply into the narration the table sees and the structured claim block.
 *
 * The block is protocol framing, not narration — stripping it is not the "silently dropping the
 * DM's words" failure mode the review guidance warns about; every word of prose survives, and an
 * unsupported claim is labelled rather than deleted. A malformed block is reported (and, being
 * unparseable, treated as evidence the turn's claims are unverified) but its raw text is still
 * removed from the broadcast so players never see half-serialized JSON.
 */
export function parseGroundingBlock(raw: string): ParsedGrounding {
  if (!raw) return { narration: '', claims: [], present: false, malformed: false };
  // The narration cut MUST use the FIRST fence, because that is exactly where
  // GroundingDeltaFilter stopped broadcasting. Taking the last fence here (as this originally
  // did) let a model that emitted `[[GROUNDING]]` twice put prose into the persisted transcript
  // and the turn result that the live table never saw — along with a raw protocol marker. The
  // stored record must be what the table watched, so the two cuts are the same cut.
  const start = raw.indexOf(GROUNDING_BLOCK_START);
  if (start === -1) return { narration: raw, claims: [], present: false, malformed: false };
  const narration = raw.slice(0, start).trim();

  // The BODY, by contrast, comes from the LAST fence: the contract says exactly one block at the
  // very end of the reply, so on a stray-fence reply the trailing one is the real block. Anything
  // between the two was never broadcast and is dropped from both views alike.
  const bodyFence = raw.lastIndexOf(GROUNDING_BLOCK_START);
  const endMarker = raw.indexOf(GROUNDING_BLOCK_END, bodyFence);
  const bodyStart = bodyFence + GROUNDING_BLOCK_START.length;
  // A truncated stream can cut the closing fence; treat the tail as the body rather than
  // leaving a dangling `[[GROUNDING]]{...` in the broadcast narration.
  const body = endMarker === -1 ? raw.slice(bodyStart) : raw.slice(bodyStart, endMarker);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(body));
  } catch {
    return { narration, claims: [], present: true, malformed: true };
  }
  const rawClaims = (parsed as { claims?: unknown } | null)?.claims;
  if (!Array.isArray(rawClaims)) {
    return { narration, claims: [], present: true, malformed: true };
  }
  const claims: GroundingClaim[] = [];
  for (const entry of rawClaims.slice(0, MAX_CLAIMS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const text = typeof rec.text === 'string' ? rec.text.slice(0, MAX_CLAIM_TEXT).trim() : '';
    const kind: GroundingClaimKind =
      rec.kind === 'rule' || rec.kind === 'canon' || rec.kind === 'narration'
        ? rec.kind
        : // An unrecognized kind is treated as a factual claim, not waved through as creative
          // narration — the conservative direction for a model-controlled field.
          'canon';
    const cites: GroundingCitation[] = [];
    const rawCites = Array.isArray(rec.cites) ? rec.cites : [];
    for (const cite of rawCites.slice(0, MAX_CITES_PER_CLAIM)) {
      if (!cite || typeof cite !== 'object' || Array.isArray(cite)) continue;
      const c = cite as Record<string, unknown>;
      // Keep malformed references rather than dropping them: a claim whose only citation is
      // `{"type":"spellbook","id":"the big one"}` must fail loudly, not silently look uncited.
      cites.push({
        type: c.type as GroundingSourceType,
        id: typeof c.id === 'number' ? c.id : Number.NaN,
      });
    }
    claims.push({ text, kind, cites });
  }
  return { narration, claims, present: true, malformed: false };
}

/**
 * Unwrap a markdown code fence around the block body.
 *
 * Models wrap JSON in ```json fences reflexively, and without this a perfectly cooperative reply
 * parses as `block_malformed` — which is an UNSUPPORTED claim, which parks the seat in
 * `awaiting_players`. That would fire on essentially every turn for some providers, and a
 * mechanism that fires constantly gets switched off, at which point it protects nothing. The
 * fence is presentation, not content, so unwrapping it does not weaken any check: the claims
 * inside are still validated against the ledger exactly as before.
 */
function stripCodeFence(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline === -1) return trimmed;
  // Only the opening fence's info string (```json) is skipped; a missing closing fence just
  // leaves the tail in place and JSON.parse still decides.
  const withoutOpen = trimmed.slice(firstNewline + 1);
  const closing = withoutOpen.lastIndexOf('```');
  return (closing === -1 ? withoutOpen : withoutOpen.slice(0, closing)).trim();
}

/**
 * Streaming-safe suppressor for the citation block (#577).
 *
 * Narration is broadcast token-by-token as the provider emits it, so without this the table
 * would watch the DM "type" raw JSON at the end of every turn. The filter withholds any tail
 * that could be the start of the opening fence and, once the fence is seen, swallows everything
 * after it. Stateful but tiny and pure-in/pure-out, so it is unit-testable on its own.
 */
export class GroundingDeltaFilter {
  private pending = '';
  private suppressing = false;

  /** Feed one provider delta; returns the substring that is safe to broadcast (may be ''). */
  push(delta: string): string {
    if (this.suppressing) return '';
    this.pending += delta;
    const idx = this.pending.indexOf(GROUNDING_BLOCK_START);
    if (idx !== -1) {
      const emit = this.pending.slice(0, idx);
      this.pending = '';
      this.suppressing = true;
      return emit;
    }
    // Hold back only as much tail as could still grow into the fence.
    const hold = longestFencePrefixSuffix(this.pending);
    const emit = this.pending.slice(0, this.pending.length - hold);
    this.pending = this.pending.slice(this.pending.length - hold);
    return emit;
  }

  /** Flush whatever was held back but never became a fence (end of stream). */
  flush(): string {
    if (this.suppressing) return '';
    const rest = this.pending;
    this.pending = '';
    return rest;
  }
}

function longestFencePrefixSuffix(text: string): number {
  const max = Math.min(GROUNDING_BLOCK_START.length - 1, text.length);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(GROUNDING_BLOCK_START.slice(0, len))) return len;
  }
  return 0;
}

/**
 * Narration patterns that assert a CANON WRITE LANDED or that a human approved something.
 *
 * The driver can never write canon directly — every proposal-capable tool is forced onto the
 * proposal path — so "I've added that to the campaign" / "the DM approved it" is false unless a
 * matching applied tool call exists in this turn. This is an ADVISORY, English-only heuristic:
 * it catches the uncited variant of a false approval claim. The load-bearing defense for the
 * cited variant is citation validation above, which needs no natural-language understanding.
 * Narration in another language will not trip these patterns, which is why the heuristic only
 * ever adds a finding and never clears one.
 */
const APPLICATION_CLAIM_PATTERNS: readonly RegExp[] = [
  /\bthe\s+(?:human\s+)?DM\s+(?:has\s+)?(?:already\s+)?approved\b/i,
  /\bapproved\s+by\s+(?:the\s+)?(?:human\s+)?DM\b/i,
  // Both the ASCII and the typographic apostrophe: models emit ’ constantly, and a heuristic
  // that only matched ' would miss the majority of real output.
  // Note the contraction has NO space before it ("that’s"), unlike the "that is" form.
  /\b(?:that|this|it)(?:\s+is|['’]s)\s+now\s+(?:official\s+)?canon\b/i,
  /\bi(?:['’]ve|\s+have)\s+(?:now\s+)?(?:added|created|saved|written|committed|recorded)\s+(?:it|this|that|them|him|her)?\s*(?:in)?to\s+(?:the\s+)?(?:campaign|canon|world|codex)\b/i,
  /\b(?:has|have)\s+been\s+(?:added|saved|written|committed)\s+to\s+(?:the\s+)?(?:campaign|canon|world)\b/i,
  /\bno\s+(?:DM\s+)?(?:approval|review)\s+(?:is\s+)?(?:needed|required)\b/i,
];

/**
 * Tool outcomes that would make an "it is applied / approved" narration TRUE. A proposal is
 * explicitly not one of them: a filed proposal is pending review, not applied canon.
 */
export interface AppliedToolSummary {
  name: string;
  isError: boolean;
  proposed: boolean;
  pendingConfirmation?: boolean;
}

/** True when at least one tool call in the turn actually applied a change. */
export function hasAppliedWrite(executed: readonly AppliedToolSummary[]): boolean {
  return executed.some((t) => !t.isError && !t.proposed && !t.pendingConfirmation);
}

/** The narration fragments that assert an application/approval the turn cannot back up. */
export function detectUnsupportedApplicationClaims(
  narration: string,
  executed: readonly AppliedToolSummary[],
): string[] {
  if (!narration) return [];
  if (hasAppliedWrite(executed)) return [];
  const found: string[] = [];
  for (const pattern of APPLICATION_CLAIM_PATTERNS) {
    const match = pattern.exec(narration);
    if (match) found.push(match[0].slice(0, MAX_CLAIM_TEXT));
  }
  return found;
}

/** Deep link for a validated citation so a human can check the AI's work. */
export function citationHref(campaignId: number, type: string, id: number): string | undefined {
  switch (type) {
    case 'rule':
      return `/c/${campaignId}/compendium/${id}`;
    case 'npc':
      return `/c/${campaignId}/npcs/${id}`;
    case 'quest':
      return `/c/${campaignId}/quests/${id}`;
    case 'location':
      return `/c/${campaignId}/locations/${id}`;
    case 'faction':
      return `/c/${campaignId}/factions/${id}`;
    case 'character':
      return `/c/${campaignId}/characters/${id}`;
    case 'encounter':
      return `/c/${campaignId}/encounters/${id}`;
    case 'item':
      return `/c/${campaignId}/inventory`;
    case 'session':
      return `/c/${campaignId}/sessions`;
    case 'timeline':
      return `/c/${campaignId}/timeline`;
    case 'campaign':
      return `/c/${campaignId}`;
    default:
      return undefined;
  }
}

export interface EvaluateGroundingInput {
  campaignId: number;
  /** The narration the table saw (block already stripped). */
  narration: string;
  parsed: ParsedGrounding;
  ledger: RetrievalLedger;
  executed: readonly AppliedToolSummary[];
  provider: string;
  model: string;
}

/**
 * Validate one turn's claims against what was actually retrieved. Pure: no IO, no clock, no
 * model round-trip — the entire grounding decision is reproducible from its inputs.
 */
export function evaluateGrounding(input: EvaluateGroundingInput): GroundingVerdict {
  const { campaignId, narration, parsed, ledger, executed, provider, model } = input;
  const claims: EvaluatedClaim[] = [];

  if (parsed.malformed) {
    claims.push({
      index: claims.length,
      kind: 'canon',
      // The block is dropped from the broadcast, so quote the narration head instead: the DM
      // needs to know WHICH turn is suspect, and the raw JSON fragment tells them nothing.
      text: narration.slice(0, MAX_CLAIM_TEXT),
      status: 'unsupported',
      reason: 'block_malformed',
      citations: [],
    });
  }

  for (const claim of parsed.claims) {
    const index = claims.length;
    if (claim.kind === 'narration') {
      // Creative narration is the default and is never gated — this is the whole point of the
      // claim/narration split. Invented atmosphere is the DM's job; invented rules are not.
      claims.push({ index, kind: claim.kind, text: claim.text, status: 'supported', reason: 'ok', citations: [] });
      continue;
    }
    if (claim.cites.length === 0) {
      claims.push({
        index,
        kind: claim.kind,
        text: claim.text,
        status: 'unsupported',
        reason: 'no_citation',
        citations: [],
      });
      continue;
    }
    const citations: EvaluatedCitation[] = claim.cites.map((cite) => evaluateCitation(campaignId, cite, ledger));
    const failed = citations.find((c) => c.status === 'unsupported');
    claims.push({
      index,
      kind: claim.kind,
      text: claim.text,
      status: failed ? 'unsupported' : 'supported',
      reason: failed ? failed.reason : 'ok',
      citations,
    });
  }

  for (const fragment of detectUnsupportedApplicationClaims(narration, executed)) {
    claims.push({
      index: claims.length,
      kind: 'canon',
      text: fragment,
      status: 'unsupported',
      reason: 'false_application_claim',
      citations: [],
    });
  }

  const unsupportedCount = claims.filter((c) => c.status === 'unsupported').length;
  return {
    status: unsupportedCount > 0 ? 'unverified' : 'clean',
    claims,
    supportedCount: claims.length - unsupportedCount,
    unsupportedCount,
    provider,
    model,
    retrievals: ledger.all(),
  };
}

function evaluateCitation(campaignId: number, cite: GroundingCitation, ledger: RetrievalLedger): EvaluatedCitation {
  const type = cite.type as string;
  if (!isGroundingSourceType(type)) {
    return { type: typeof type === 'string' ? type.slice(0, 60) : 'unknown', id: 0, status: 'unsupported', reason: 'unknown_source_type' };
  }
  if (!Number.isInteger(cite.id) || cite.id <= 0) {
    return { type, id: 0, status: 'unsupported', reason: 'malformed_id' };
  }
  const record = ledger.get(type, cite.id);
  if (!record) {
    // The id was never handed to the model by an authorized read in this turn. That covers
    // fabrication, another campaign's ids, and ids merely remembered from an earlier turn —
    // all three are equally unverifiable at broadcast time.
    return { type, id: cite.id, status: 'unsupported', reason: 'not_retrieved' };
  }
  if (!record.ok) {
    return { type, id: cite.id, status: 'unsupported', reason: 'retrieval_failed', retrievedBy: record.tool };
  }
  return {
    type,
    id: cite.id,
    status: 'supported',
    reason: 'ok',
    retrievedBy: record.tool,
    href: citationHref(campaignId, type, cite.id),
    ...(record.dmOnly ? { dmOnly: true } : {}),
  };
}

/**
 * Project one stored claim for the role that is reading it (#577, following #825/#1524).
 *
 * `GET /ai-dm/grounding` is member-readable on purpose — the table is the audience for an
 * unverified ruling — but a SUPPORTED citation can be backed by an id only a DM was ever
 * allowed to see: a hidden encounter, or an entity behind a narrow DM secret-read approval
 * (#557). Publishing that id (and a deep link straight to it) to every player would leak the
 * existence of DM prep through the very mechanism that is supposed to make the AI trustworthy.
 *
 * Note WHICH way this redacts. The verdict, the reason, the claim text, and the provenance are
 * unchanged for every reader, so a player still sees that the ruling checked out and can still
 * dispute it. Only the identity of the DM-only source is withheld. `projectTranscriptEventForRole`
 * makes the same trade for a hidden encounter id inside a tool payload.
 */
export function projectGroundingCitationForRole(citation: EvaluatedCitation, role: string): EvaluatedCitation {
  if (role === 'dm' || !citation.dmOnly) return citation;
  const { href: _href, dmOnly: _dmOnly, ...rest } = citation;
  // Keep `type` — "backed by an NPC the DM can see" is not itself sensitive and keeps the card
  // legible — but drop the id and the link, which are the parts that name the hidden entity.
  return { ...rest, id: 0, redacted: true };
}

/** Project every citation on a claim for the reading role. */
export function projectGroundingClaimForRole<T extends { citations: EvaluatedCitation[] }>(claim: T, role: string): T {
  if (role === 'dm') return claim;
  return { ...claim, citations: claim.citations.map((c) => projectGroundingCitationForRole(c, role)) };
}

/**
 * Project a whole turn verdict for the role receiving it.
 *
 * `POST /ai-dm/message` is player-callable and returns this verbatim, so it is a second delivery
 * path for exactly the ids {@link projectGroundingClaimForRole} guards on the REST read. The raw
 * `retrievals` ledger is the wider hole of the two: it lists EVERY id the turn retrieved whether
 * or not the model cited any of them, so a player could dump the DM's hidden prep just by taking
 * a turn. Non-DM readers get the player-visible retrievals only.
 */
export function projectGroundingVerdictForRole(verdict: GroundingVerdict, role: string): GroundingVerdict {
  if (role === 'dm') return verdict;
  return {
    ...verdict,
    claims: verdict.claims.map((c) => projectGroundingClaimForRole(c, role)),
    retrievals: verdict.retrievals.filter((r) => !r.dmOnly),
  };
}

/**
 * The grounding contract appended to every driver system prompt (#577).
 *
 * Note what this text is and is not. It is the cooperative half: a model that follows it makes
 * the server's job easy. It is NOT the enforcement — `evaluateGrounding` never reads the prompt
 * and never takes the model's word for anything. A model that ignores this section entirely and
 * emits confident uncited rules still gets its factual claims flagged the moment it cites
 * anything, and its false approval claims caught by the heuristic above.
 */
export const GROUNDING_CITATION_CONTRACT = [
  '## Grounding contract — creative narration vs. factual claims',
  'Two different things come out of your mouth, and they are held to different standards:',
  '1. CREATIVE NARRATION — description, atmosphere, sensory detail, NPC voice and improvisation,',
  '   the shape of a scene. This is your job. Invent freely. It needs no source.',
  '2. FACTUAL CLAIMS — a RULES ruling ("a fireball deals 8d6 fire damage", "you get advantage"),',
  '   or an assertion about EXISTING CANON ("Kaeda runs the thieves\' guild", "the party already',
  '   holds the Sunstone", "that quest is complete", "the goblin has 7 HP left"). These are only',
  '   allowed if you actually READ them this turn via a tool call or the context above.',
  'If you do not have a source for a factual claim, do not assert it. Say the table should check,',
  'call lookup_rule / get_rule_entry / get_npc / get_quest / get_campaign_summary, or narrate',
  'around it. Guessing confidently is the single worst thing you can do at this table.',
  '',
  'At the very END of your reply — after all narration — append exactly ONE grounding block:',
  `${GROUNDING_BLOCK_START}`,
  '{"claims":[{"text":"<the claim, quoted from your narration>","kind":"rule","cites":[{"type":"rule","id":123}]}]}',
  `${GROUNDING_BLOCK_END}`,
  `Use kind "rule" for rules rulings, "canon" for claims about existing world state, and`,
  '"narration" for a purely creative beat you want to declare as invention. `cites` ids MUST be',
  'real ids that came back from a read in THIS turn — the server checks every one of them against',
  'what it actually retrieved, and a citation it cannot verify is published to the table marked',
  'UNVERIFIED with your name on it. Citing an id you did not retrieve is worse than not citing.',
  'If your whole reply is creative narration, send an empty block: {"claims":[]}.',
  'The block is stripped before the table sees your reply; it is machinery, not prose.',
  '',
  'NEVER claim that a canon change was applied or that the DM approved something. Your world',
  'edits are filed as PROPOSALS for a human to review; until a human acts they have not happened.',
].join('\n');
