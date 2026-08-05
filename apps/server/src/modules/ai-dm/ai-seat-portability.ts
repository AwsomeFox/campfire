import type { aiDmSeats } from '../../db/schema';
import { AiDmComprehensionProfile, AiDmMode, AiDmProactiveSettings, AiDmSeat, AiDmStylePresets } from '@campfire/schema';

/**
 * Which AI-seat fields travel on clone / export / import — stated ONCE (issue #1049).
 *
 * ── Why this exists ───────────────────────────────────────────────────────────────────
 * The seat's portability was three closed object literals — the export projection
 * (export.service.ts), the clone insert and the import insert (campaigns.service.ts) — each
 * enumerating seat columns by hand. Every new column on `ai_dm_seats` had to be remembered in
 * three places, and a forgotten one fails SILENTLY: the campaign round-trips, nothing errors,
 * and the field comes back as its column default.
 *
 * `stylePresets` (#1049) was reported as the casualty, but it was the THIRD. Auditing the three
 * literals against the actual table turned up two more that were already being dropped:
 *
 *   - `proactiveSettings` (#1044) — a DM's proactive-DM configuration, silently reset since it
 *     was added;
 *   - `actionQueueDepth` (#1045) — the FIFO action-queue cap, likewise.
 *
 * So this was a pattern, not an instance, and a fourth column would have joined them.
 *
 * ── Why an exhaustive Record and not just a wider literal ─────────────────────────────
 * {@link AI_SEAT_FIELD_ROLE} is checked against `Record<keyof AiDmSeatRow, AiSeatFieldRole>`.
 * Adding a column to `ai_dm_seats` is therefore a COMPILE ERROR here until someone says what it
 * is — which is the only mechanism that actually stops the next silent drop. A wider literal
 * would fix today's three fields and leave the mechanism that swallowed them intact.
 *
 * ── Classifying is not enough; the PROJECTIONS must derive from the classification ────
 * The first cut of this file classified correctly and still did not guard (Codex review). The
 * classification was one source of truth and there were three more beside it: a hand-written
 * `Pick` naming the portable columns, and two closed object literals (`portableAiSeat`,
 * `readPortableAiSeat`) enumerating them again — plus an `as Array<keyof PortableAiSeat>` cast
 * that told the compiler the derived name list and the hand-written `Pick` agreed, whether or
 * not they did. So the sequence the abstraction exists to prevent still worked end to end:
 * add a column, classify it `config`, and clone/export/import drop it in silence.
 *
 * The `satisfies` on the map below is what closes that. It keeps the exhaustiveness check
 * while PRESERVING each field's literal role, so {@link PortableAiSeat} can be computed from
 * the map rather than restated next to it. Both projections are annotated with that computed
 * type, which makes a missing field a compile error in the two functions that would otherwise
 * have dropped it — the failure moves from "a DM notices their style is gone" to `tsc`. The
 * cast is gone with it; nothing here now asserts an agreement it does not check.
 *
 * ── Classification is not validation ─────────────────────────────────────────────────
 * {@link AI_SEAT_FIELD_ROLE} makes it a compile error to forget to CLASSIFY a new column. It
 * says nothing about whether the value that arrived is legal, and the type system cannot: on
 * the import path the value comes out of an uploaded archive as `unknown`. Anyone adding a
 * `config` field therefore owes it a coercion in {@link readPortableAiSeat} as well as a line
 * in the map — the two answer different questions, and the first one passing is not evidence
 * about the second.
 *
 * This is deliberately one object and a few small functions, not a framework: the classification
 * is the thing worth centralising, because it is a POLICY (what may follow a campaign to
 * another install), while the three call sites keep their own shapes — the import path reads
 * untrusted JSON and must coerce, the other two read a trusted row.
 */

type AiDmSeatRow = typeof aiDmSeats.$inferSelect;

/**
 * What a seat column IS, which decides whether it travels.
 *
 *  - `config`   — DM-authored steering. Travels: it is the thing a DM built and would have to
 *                 rebuild by hand otherwise.
 *  - `runtime`  — usage counters and last-activity marks. Never travels; a clone or an import
 *                 starts its own accounting, and carrying a spend history to another install
 *                 would misreport that install's consumption.
 *  - `identity` — the primary key and row timestamps. Set per target, never copied.
 */
export type AiSeatFieldRole = 'config' | 'runtime' | 'identity';

/**
 * EXHAUSTIVE by construction — see the header. Do not replace with a list of portable field
 * names: a list cannot tell you that a NEW column is unclassified, which is the entire failure
 * this file exists to prevent.
 *
 * `as const satisfies` rather than a `Record<…>` type ANNOTATION, and the difference is the
 * whole guard. An annotation widens every value to `AiSeatFieldRole`, which erases which role
 * each column actually has — leaving nothing for {@link PortableAiSeat} to be derived FROM, so
 * it had to be hand-written and could drift. `satisfies` performs the same exhaustiveness check
 * against the same `Record` while keeping the literal roles, so the derivation below is real.
 */
export const AI_SEAT_FIELD_ROLE = {
  campaignId: 'identity',
  createdAt: 'identity',
  updatedAt: 'identity',

  // DM-authored steering.
  mode: 'config',
  // `enabled` travels — REVIEWED AND KEPT, not inherited by omission.
  //
  // It was queried during #1049 on the grounds that consent to spend should not follow a
  // campaign to another install. It stays `config` because three independent gates stand
  // between an imported `enabled: true` and a single spent token:
  //   1. the provider config, which is NEVER exported (encrypted, install-specific), and
  //      without which `assertRunnable` refuses the seat;
  //   2. the server-wide `experimentalAiDm` flag, off by default on a fresh install;
  //   3. the server token cap (`assertWithinServerTokenCap`).
  // So an imported seat arrives switched on but inert until the receiving operator supplies a
  // credential — which is itself the consent step.
  //
  // This remains a product question rather than a portability one ("should the switch travel at
  // all?"), and the answer could reasonably change. If it does, flipping this single value to
  // `runtime` is the whole change: `enabled` then drops out of PORTABLE_AI_SEAT_FIELDS, out of
  // all three call sites, and the round-trip spec's expectedConfig fails until it is updated.
  enabled: 'config',
  model: 'config',
  instructions: 'config',
  tokenBudget: 'config',
  // #1044 — silently dropped before #1049 audited these lists.
  proactiveSettings: 'config',
  // #1049 — the reported casualty.
  stylePresets: 'config',
  // #874 — same DM-authored-steering reasoning as stylePresets immediately above.
  comprehensionProfile: 'config',
  // #1045 — likewise silently dropped.
  actionQueueDepth: 'config',

  // Usage accounting. An import already zeroes the first two deliberately; the rest were only
  // ever absent from the insert and so fell to their column defaults, which is the same result
  // by accident rather than by decision. Naming them here makes it a decision.
  tokensUsed: 'runtime',
  tokensReserved: 'runtime',
  tokensRefunded: 'runtime',
  tokensUnknown: 'runtime',
  tokensOverage: 'runtime',
  turnCount: 'runtime',
  lastTurnAt: 'runtime',
} as const satisfies Record<keyof AiDmSeatRow, AiSeatFieldRole>;

/** The column names carrying a given role, computed from the map — never restated beside it. */
type AiSeatFieldsWithRole<R extends AiSeatFieldRole> = {
  [K in keyof typeof AI_SEAT_FIELD_ROLE]: (typeof AI_SEAT_FIELD_ROLE)[K] extends R ? K : never;
}[keyof typeof AI_SEAT_FIELD_ROLE];

/** The seat columns classified `config`. */
export type PortableAiSeatField = AiSeatFieldsWithRole<'config'>;

/** The runtime counters an insert must zero. */
export type RuntimeAiSeatField = AiSeatFieldsWithRole<'runtime'>;

/**
 * The seat fields that travel — DERIVED from the classification, not restated alongside it.
 *
 * This being computed is what makes classifying a column sufficient rather than merely
 * necessary: widening the map widens this type, which breaks both projections below until they
 * carry the new field. When it was a hand-written `Pick`, classification and portability were
 * independent edits and only the first was enforced.
 */
export type PortableAiSeat = Pick<AiDmSeatRow, PortableAiSeatField>;

/**
 * Field names with role `config`, for tests and for the coercing import reader.
 *
 * The type predicate replaces an `as Array<keyof PortableAiSeat>` cast. It looks similar but is
 * not: the cast claimed the runtime filter and a SEPARATE hand-written type agreed, and hid it
 * when they did not. `PortableAiSeatField` is now computed from the very map being filtered, so
 * the predicate narrows to the same set the filter selects. The load-bearing guard is no longer
 * here in any case — it is the return type shared by the two projections below.
 */
export const PORTABLE_AI_SEAT_FIELDS = (Object.keys(AI_SEAT_FIELD_ROLE) as Array<keyof AiDmSeatRow>).filter(
  (key): key is PortableAiSeatField => AI_SEAT_FIELD_ROLE[key] === 'config',
);

/**
 * Project a stored seat row down to what travels (export + clone).
 *
 * Written field-by-field rather than by iterating {@link PORTABLE_AI_SEAT_FIELDS} so the result
 * is a precisely-typed `PortableAiSeat` instead of a partial index type. That annotation is not
 * decoration: because `PortableAiSeat` is computed from {@link AI_SEAT_FIELD_ROLE}, classifying
 * a new column `config` makes this literal incomplete, and TypeScript rejects an object literal
 * that is missing a property of its declared return type. Forgetting a field is a build failure
 * here rather than a field that quietly comes back as its column default two installs later.
 */
export function portableAiSeat(row: AiDmSeatRow): PortableAiSeat {
  return {
    mode: row.mode,
    enabled: row.enabled,
    model: row.model,
    instructions: row.instructions,
    tokenBudget: row.tokenBudget,
    proactiveSettings: row.proactiveSettings,
    stylePresets: row.stylePresets,
    comprehensionProfile: row.comprehensionProfile,
    actionQueueDepth: row.actionQueueDepth,
  };
}

/**
 * The runtime counters an insert must zero, so a clone/import starts its own accounting.
 *
 * Derived from the same classification for the same reason as {@link portableAiSeat}: a new
 * `runtime` column left out of this literal would fall to its schema default, which is the
 * right answer only by luck. Naming it here keeps "the copy starts its own accounting" a
 * decision the compiler enforces rather than an accident of which fields the insert omitted.
 */
export function freshAiSeatCounters(): Pick<AiDmSeatRow, RuntimeAiSeatField> {
  return {
    tokensUsed: 0,
    tokensReserved: 0,
    tokensRefunded: 0,
    tokensUnknown: 0,
    tokensOverage: 0,
    turnCount: 0,
    lastTurnAt: null,
  };
}

/** Coercion helpers for the IMPORT path, which reads untrusted JSON rather than a typed row. */
interface ImportCoercers {
  str(value: unknown, fallback?: string): string;
  boolOf(value: unknown): boolean;
  intOr(value: unknown, fallback: number): number;
  /** Called when a field is dropped back to its default because the archive's value was illegal. */
  warn?(field: string, detail: string): void;
}

/** Queue-depth bounds, mirroring `AiDmSeatUpdate.actionQueueDepth` (min 1, max 20). */
const ACTION_QUEUE_DEPTH_MIN = 1;
const ACTION_QUEUE_DEPTH_MAX = 20;
const ACTION_QUEUE_DEPTH_DEFAULT = 8;

/**
 * `tokenBudget` bounds, READ from {@link AiDmSeat} rather than re-typed here (issue #1593).
 *
 * A literal `1_000_000_000` beside this reader would be a SECOND place that number lives —
 * exactly the defect this issue closes, one door over. `AiDmSeat.shape.tokenBudget` is
 * `z.number().int().nonnegative().max(1_000_000_000).default(0)`; `.removeDefault()` un-wraps
 * the `ZodDefault` to reach the `ZodNumber`, whose public `.minValue`/`.maxValue` getters report
 * the effective bounds from its `.nonnegative()`/`.max()` checks. If the schema's cap ever
 * changes, this reads the new value automatically — nothing here needs to be told.
 */
const TOKEN_BUDGET_SCHEMA = AiDmSeat.shape.tokenBudget.removeDefault();
const TOKEN_BUDGET_MIN = TOKEN_BUDGET_SCHEMA.minValue ?? 0;
const TOKEN_BUDGET_MAX = TOKEN_BUDGET_SCHEMA.maxValue ?? Number.MAX_SAFE_INTEGER;

/**
 * Read the portable seat fields out of an untrusted export payload.
 *
 * Returns `PortableAiSeat`, so this literal is held to the same derived key set as
 * {@link portableAiSeat}. That matters more here than there: this is the SECOND independent
 * enumeration, and the failure it used to permit was asymmetric — a field could travel fine on
 * export and clone and vanish only on import, which no export-side assertion would ever see.
 *
 * ── Shape is not enough; VALUES must be parsed ────────────────────────────────────────
 * Fixing the silent drop inherited its side effect. Before #1049 these three fields did not
 * travel at all and fell to column defaults — and that omission was, accidentally, also a
 * VALIDATION. Now that they travel, an uploaded archive can put an object-shaped but ILLEGAL
 * value into a `mode: 'json'` column: `{"tone":"grimdark"}` is a perfectly good object and not
 * a legal `AiDmStylePresets`.
 *
 * The damage lands FAR FROM HERE, which is what makes it expensive. `AiDmService.toDomain`
 * parses both blocks with their zod schemas on every read, so an illegal value imports
 * "successfully" and then throws on `GET /ai-dm` and every Driver operation — a permanently
 * unusable seat produced by an import that reported success. An earlier revision of this
 * function checked only that the value was an object, which caught an array or a string and
 * nothing else.
 *
 * FALLBACK, NOT REJECTION. An illegal block is replaced with the schema's defaults and warned
 * about, rather than failing the whole import. Refusing an entire campaign archive — locations,
 * NPCs, quests, sessions, the lot — over one bad enum value in an optional style block is a
 * harsh trade for an operator who mostly wants their campaign back, and the fallback is exactly
 * the state the seat would have been in before these fields travelled at all. The warning is
 * what keeps it from being silent.
 *
 * Note this is per-BLOCK, not per-axis: a partially-specified but legal block (`{tone:'noir'}`)
 * parses fine because every axis defaults independently, so ordinary input is never lossy.
 */
export function readPortableAiSeat(
  src: Record<string, unknown>,
  { str, boolOf, intOr, warn }: ImportCoercers,
): PortableAiSeat {
  return {
    // VALIDATED against its enum, not merely coerced to a string (#1049 review).
    //
    // `str(src.mode, 'off')` accepted any string at all, so an archive could store a mode
    // outside `AiDmMode`. That does not wedge the seat the way an illegal JSON block does —
    // `toDomain` CASTS mode rather than parsing it — but `assertRunnable` gates on
    // `seat.enabled && seat.mode !== 'off'`, which fails OPEN, and readiness then labels the
    // unrecognised mode as Co-DM via the fallback branch of its `mode === 'driver' ? … : …`.
    // An armed seat under a mode no code recognises, described to the DM as something it is
    // not, is the same reports-something-untrue family as the rest of this issue.
    //
    // Falls back to `off` rather than to `co_dm`: a mode we could not read is not consent to
    // arm the seat, and `off` is the only value that gate treats as disarmed.
    mode: enumOrDefault(AiDmMode, src.mode, 'off', 'mode', warn),
    // `enabled` needs no equivalent to `mode`'s enum check and gets none — deliberately, not
    // by oversight. `boolOf` is TOTAL (anything not `true` becomes `false`), so a boolean has
    // no unrepresentable value left to admit. The two closed-domain scalars are handled by
    // their own guards: `mode` is parsed against `AiDmMode`, and `tokenBudget` is clamped to
    // `AiDmSeat.shape.tokenBudget` immediately below.
    enabled: boolOf(src.enabled),
    model: str(src.model),
    instructions: str(src.instructions),
    // CLAMPED to `AiDmSeat`'s own `tokenBudget` bounds (issue #1593), not merely floored at 0.
    //
    // `Math.max(0, …)` enforced the floor but not the schema's `.max(1_000_000_000)` ceiling —
    // so an archive carrying `tokenBudget: 5e9` imported without complaint and read back
    // verbatim, holding a value the schema itself calls illegal. `assertWithinServerTokenCap`
    // governs actual spend regardless of what the seat stores, so this was a schema-integrity
    // gap, not a spend-safety one — but a seat should not report a limit larger than the
    // schema admits. `TOKEN_BUDGET_MIN`/`MAX` are read from the schema (see above), so this
    // cannot silently drift from `AiDmSeat.shape.tokenBudget` the way a re-typed literal could.
    tokenBudget: clamp(intOr(src.tokenBudget, 0), TOKEN_BUDGET_MIN, TOKEN_BUDGET_MAX),
    proactiveSettings: parseOrDefault(AiDmProactiveSettings, src.proactiveSettings, 'proactiveSettings', warn),
    stylePresets: parseOrDefault(AiDmStylePresets, src.stylePresets, 'stylePresets', warn),
    // #874 — same per-block (not per-axis) fallback reasoning as stylePresets immediately above.
    comprehensionProfile: parseOrDefault(AiDmComprehensionProfile, src.comprehensionProfile, 'comprehensionProfile', warn),
    // CLAMPED to the same 1..20 the seat schema enforces, not merely floored at 0.
    //
    // The previous line was `Math.max(0, …)` sitting directly beneath a comment explaining that
    // a depth of 0 was the thing to prevent — the invariant was written down and the guard was
    // one off from it. A stored 0 makes `queue.length >= maxDepth` true immediately, so a seat
    // that looks configured silently rejects every action submitted while a turn is running;
    // a value above 20 bypasses the cap in the other direction.
    actionQueueDepth: clamp(
      intOr(src.actionQueueDepth, ACTION_QUEUE_DEPTH_DEFAULT),
      ACTION_QUEUE_DEPTH_MIN,
      ACTION_QUEUE_DEPTH_MAX,
    ),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Parse an untrusted scalar against a closed enum, falling back to an explicit legal value.
 *
 * Separate from {@link parseOrDefault} because an enum has no `schema.parse({})` to fall back
 * to — the caller has to name the safe value, and which value is safe is a judgement about that
 * field (for `mode` it is `off`, the only one that leaves the seat disarmed). It follows the
 * same absent-is-not-invalid rule for the same reason: a missing key is an old archive, not a
 * malformed one, and telling an operator otherwise is a false accusation.
 */
function enumOrDefault<T extends string>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown } },
  value: unknown,
  fallback: T,
  field: string,
  warn?: (field: string, detail: string) => void,
): T {
  if (value === undefined || value === null) return fallback;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  warn?.(field, `the imported archive's \`${field}\` is not a recognised value; falling back to '${fallback}'`);
  return fallback;
}

/**
 * Parse an untrusted JSON block with its real schema, falling back to the schema's own defaults
 * when it does not validate. Returning `schema.parse({})` rather than `{}` matters: the column
 * is read back through the same schema, so the fallback must itself be a legal value.
 *
 * ── ABSENT is not INVALID ─────────────────────────────────────────────────────────────
 * Both cases end at the same defaults, but only one of them deserves a warning, and the first
 * cut of this function could not tell them apart — it handed the raw value to `safeParse` and
 * called every failure illegal. Whether that accused an innocent archive then depended on an
 * unrelated detail of how each schema happened to be declared:
 *
 *   - `AiDmStylePresets` ends in a top-level `.default(...)`, so `safeParse(undefined)`
 *     SUCCEEDS and it never warned about anything;
 *   - `AiDmProactiveSettings` is a bare `z.object({...})` — per-key defaults, no top-level one —
 *     so `safeParse(undefined)` FAILS, and every archive predating #1044 told its operator that
 *     their AI settings "did not validate" when nothing was wrong with them.
 *
 * The fix belongs HERE rather than in the one schema. Adding a top-level `.default()` to
 * `AiDmProactiveSettings` would equalise today's two blocks and leave the next `config` block
 * to inherit whichever behaviour its author's schema style happened to produce. Deciding it in
 * the reader makes "absent imports quietly, invalid is reported" a property of the import path
 * itself, which is the level the promise is made at.
 *
 * `null` counts as absent for the same reason: JSON has no `undefined`, the seat's JSON columns
 * are nullable, and `portableAiSeat` copies them verbatim — so an unset block leaves in OUR OWN
 * export as `null`. Treating that as illegal would have the importer warn about a value this
 * codebase wrote.
 *
 * This is the mirror image of the defect closed on #1556, where a default meaning "the
 * reassuring thing" turned an omission into a false REASSURANCE. Here a missing default turned
 * an omission into a false ACCUSATION. Same root cause both times — code that cannot distinguish
 * "absent" from "present and wrong" — so it is fixed the same way: teach the code to ask.
 */
function parseOrDefault<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown }; parse(value: unknown): T },
  value: unknown,
  field: string,
  warn?: (field: string, detail: string) => void,
): T {
  // Nothing was carried for this block — an archive predating the feature, or a seat that never
  // configured it. Defaults, and NO warning: there is nothing for the operator to act on.
  if (value === undefined || value === null) return schema.parse({});

  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  warn?.(field, `the imported archive's \`${field}\` did not validate; falling back to defaults`);
  return schema.parse({});
}
