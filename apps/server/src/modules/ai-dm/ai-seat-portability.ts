import type { aiDmSeats } from '../../db/schema';
import { AiDmProactiveSettings, AiDmStylePresets } from '@campfire/schema';

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
 * {@link AI_SEAT_FIELD_ROLE} is `Record<keyof AiDmSeatRow, AiSeatFieldRole>`. Adding a column
 * to `ai_dm_seats` is therefore a COMPILE ERROR here until someone says what it is — which is
 * the only mechanism that actually stops the next silent drop. A wider literal would fix
 * today's three fields and leave the mechanism that swallowed them intact.
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
 */
export const AI_SEAT_FIELD_ROLE: Record<keyof AiDmSeatRow, AiSeatFieldRole> = {
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
};

/** The seat fields that travel. Derived from the map, so it can never disagree with it. */
export type PortableAiSeat = Pick<
  AiDmSeatRow,
  'mode' | 'enabled' | 'model' | 'instructions' | 'tokenBudget' | 'proactiveSettings' | 'stylePresets' | 'actionQueueDepth'
>;

/** Field names with role `config`, for tests and for the coercing import reader. */
export const PORTABLE_AI_SEAT_FIELDS = (Object.keys(AI_SEAT_FIELD_ROLE) as Array<keyof AiDmSeatRow>).filter(
  (key) => AI_SEAT_FIELD_ROLE[key] === 'config',
) as Array<keyof PortableAiSeat>;

/**
 * Project a stored seat row down to what travels (export + clone).
 *
 * Written field-by-field rather than by iterating {@link PORTABLE_AI_SEAT_FIELDS} so the result
 * is a precisely-typed `PortableAiSeat` instead of a partial index type — the exhaustive Record
 * above is what guards against omission, and this stays readable.
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
    actionQueueDepth: row.actionQueueDepth,
  };
}

/** The runtime counters an insert must zero, so a clone/import starts its own accounting. */
export function freshAiSeatCounters(): Pick<
  AiDmSeatRow,
  'tokensUsed' | 'tokensReserved' | 'tokensRefunded' | 'tokensUnknown' | 'tokensOverage' | 'turnCount' | 'lastTurnAt'
> {
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
 * Read the portable seat fields out of an untrusted export payload.
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
    mode: str(src.mode, 'off'),
    enabled: boolOf(src.enabled),
    model: str(src.model),
    instructions: str(src.instructions),
    tokenBudget: Math.max(0, intOr(src.tokenBudget, 0)),
    proactiveSettings: parseOrDefault(AiDmProactiveSettings, src.proactiveSettings, 'proactiveSettings', warn),
    stylePresets: parseOrDefault(AiDmStylePresets, src.stylePresets, 'stylePresets', warn),
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
 * Parse an untrusted JSON block with its real schema, falling back to the schema's own defaults
 * when it does not validate. Returning `schema.parse({})` rather than `{}` matters: the column
 * is read back through the same schema, so the fallback must itself be a legal value.
 */
function parseOrDefault<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown }; parse(value: unknown): T },
  value: unknown,
  field: string,
  warn?: (field: string, detail: string) => void,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  warn?.(field, `the imported archive's \`${field}\` did not validate; falling back to defaults`);
  return schema.parse({});
}
