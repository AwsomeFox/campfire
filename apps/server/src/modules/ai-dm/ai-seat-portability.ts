import type { aiDmSeats } from '../../db/schema';
import type { AiDmProactiveSettings, AiDmStylePresets } from '@campfire/schema';

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
 * This is deliberately one object and two small functions, not a framework: the classification
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
  // NOTE: `enabled` travels today, and that is pre-existing #1078 behaviour rather than a
  // decision taken here. It is defensible — an imported seat still cannot spend anything
  // without a provider config (never exported: encrypted and install-specific), the server-wide
  // experimental flag, and the server token cap — but "does consent to spend follow a campaign
  // to another install?" is a product question, not a portability one. Flagged in the PR body;
  // flipping it to `runtime` is a one-line change here if the answer is no.
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
}

/**
 * Read the portable seat fields out of an untrusted export payload.
 *
 * Separate from {@link portableAiSeat} on purpose: this side cannot trust its input. The two
 * JSON blocks are accepted only when they are actual objects — an array or a string would
 * otherwise be written straight into a `mode: 'json'` column and surface as a malformed settings
 * object at read time, far from here.
 */
export function readPortableAiSeat(
  src: Record<string, unknown>,
  { str, boolOf, intOr }: ImportCoercers,
): PortableAiSeat {
  return {
    mode: str(src.mode, 'off'),
    enabled: boolOf(src.enabled),
    model: str(src.model),
    instructions: str(src.instructions),
    tokenBudget: Math.max(0, intOr(src.tokenBudget, 0)),
    proactiveSettings: jsonObject(src.proactiveSettings) as AiDmProactiveSettings,
    stylePresets: jsonObject(src.stylePresets) as AiDmStylePresets,
    // Mirrors the column default (8) rather than 0: a queue depth of 0 would silently disable
    // action queueing for an imported campaign that never asked for that.
    actionQueueDepth: Math.max(0, intOr(src.actionQueueDepth, 8)),
  };
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
