/**
 * Per-intent idempotency for NON-idempotent encounter mutations (issue #580).
 *
 * The failure this exists to stop: the web client auto-retries one network/5xx failure
 * (see apps/web/src/lib/query.ts). HP deltas and turn advancement are relative writes, so
 * a request that COMMITTED on the server but whose response was lost in transit gets
 * replayed by that retry — the same damage lands twice, or the turn advances twice. The
 * client cannot tell "never arrived" from "arrived, applied, response lost", so the server
 * has to.
 *
 * Three properties make this correct, and all three are load-bearing:
 *
 *  1. **The key identifies an intent, not an attempt.** It is minted at the click (see
 *     apps/web/src/lib/keyedMutation.ts) and carried unchanged through every retry of that
 *     click. A key minted inside a fetch wrapper would differ per attempt and protect
 *     nothing.
 *
 *  2. **The claim commits with the effect.** {@link findPriorEncounterOp} and
 *     {@link recordEncounterOp} are called INSIDE the caller's synchronous better-sqlite3
 *     transaction, never before or after it. A separate "have I seen this key" write would
 *     leave a crash window that yields either a phantom block (key stored, damage never
 *     applied — the player is stuck) or a double-apply (damage applied, key lost).
 *
 *  3. **A duplicate replays the ORIGINAL response.** The client retried precisely because
 *     it does not know the outcome; a bare 200 or 409 leaves it exactly as ignorant. It
 *     needs the committed HP / turn pointer, so the response body is stored with the claim.
 *
 * Deliberately NOT a general-purpose middleware: dedup has to be inside each mutation's own
 * transaction to satisfy (2), so it is a set of helpers the mutation calls rather than a
 * wrapper around it.
 */
import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { Role } from '@campfire/schema';
import { encounterOpIdempotency } from '../../db/schema';

/**
 * How long a key stays replayable. Six hours is chosen against the real retry envelope,
 * not the HTTP one: TanStack's automatic retry lands in seconds, but a tablet that slept
 * mid-session and resumed can re-issue a queued mutation much later, and "hours not
 * seconds" is what makes sleep/resume safe. Longer would be safer still, but the table is
 * unbounded in principle, so this trades a bounded row count for a replay window that
 * comfortably exceeds any realistic at-the-table gap. Past the window a retry is treated
 * as a fresh intent and re-applies — the same exposure the system had before this change,
 * now confined to retries that arrive more than six hours late.
 */
export const ENCOUNTER_OP_IDEMPOTENCY_TTL_MS = 6 * 60 * 60 * 1000;

/** The non-idempotent encounter operations that carry keys. */
export type EncounterOperation =
  | 'combatant.update'
  | 'combatant.death_save_roll'
  | 'combatant.roll_initiative'
  | 'combatant.resource_adjust'
  | 'turn.advance';

// The drizzle transaction handle and the DB handle are structurally identical for the
// handful of statements issued here (one table, three shapes). Typing them precisely means
// threading the full schema generic through every helper — a lot of noise for no safety
// gain, since the queries below are hand-written and never vary by caller.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTx = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface EncounterOpClaim {
  actorId: string;
  operation: EncounterOperation;
  key: string;
  encounterId: number;
  campaignId: number;
  /** Stable hash of the request payload — binds the key to ONE intent. */
  fingerprint: string;
}

/**
 * Thrown (inside a transaction) when a key was already used for a DIFFERENT operation,
 * encounter, or payload. Surfaces as a 409 so a client bug — reusing one key across two
 * genuinely different actions — fails loudly instead of silently swallowing the second.
 */
export function idempotencyKeyReuse(): ConflictException {
  return new ConflictException({
    code: 'IDEMPOTENCY_KEY_REUSE',
    message: 'idempotencyKey was already used for a different encounter action',
  });
}

/**
 * Marker for the narrow race where two concurrent requests carry the same key: our SELECT
 * found nothing but our INSERT hit the primary key. Thrown to roll the effect back; the
 * caller re-reads the winner's row outside the transaction and replays it.
 */
export class EncounterOpRaceMarker extends Error {
  constructor(readonly claim: EncounterOpClaim) {
    super('encounter idempotency race');
  }
}

/**
 * Stable fingerprint of a request payload. Key reuse across different payloads is a client
 * bug, and silently replaying the first response for a second, different action would hide
 * it — so the payload is hashed and compared. `undefined` fields are dropped and object
 * keys sorted so an equivalent body always hashes the same.
 */
export function encounterOpFingerprint(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** A prior claim found by {@link findPriorEncounterOp}. */
export interface EncounterOpPrior {
  /** The stored original response, already parsed — null when it was never backfilled. */
  response: unknown | null;
  /** The role the stored response was rendered for; a mismatch means re-derive. */
  responseRole: Role | null;
}

/**
 * Look for a prior claim, INSIDE the caller's transaction, and opportunistically prune the
 * expired ones. Returns the prior when this key has already been honored (the caller must
 * then skip the effect entirely and replay), or null when this is a fresh intent.
 *
 * Throws {@link idempotencyKeyReuse} when the key exists but was minted for a different
 * operation/encounter/campaign/payload.
 */
export function findPriorEncounterOp(tx: AnyTx, claim: EncounterOpClaim, now: number): EncounterOpPrior | null {
  // Bounded retention: drop rows past the replay window. Indexed on created_at, and this
  // runs only on keyed writes, so the cost is a no-op index probe in the common case.
  const cutoff = new Date(now - ENCOUNTER_OP_IDEMPOTENCY_TTL_MS).toISOString();
  tx.delete(encounterOpIdempotency).where(lt(encounterOpIdempotency.createdAt, cutoff)).run();

  const [prior] = tx
    .select()
    .from(encounterOpIdempotency)
    .where(
      and(
        eq(encounterOpIdempotency.actorId, claim.actorId),
        eq(encounterOpIdempotency.operation, claim.operation),
        eq(encounterOpIdempotency.key, claim.key),
      ),
    )
    .limit(1)
    .all();
  if (!prior) return null;

  if (
    prior.encounterId !== claim.encounterId ||
    prior.campaignId !== claim.campaignId ||
    prior.fingerprint !== claim.fingerprint
  ) {
    throw idempotencyKeyReuse();
  }
  return {
    response: prior.responseJson === null ? null : (JSON.parse(prior.responseJson) as unknown),
    responseRole: (prior.responseRole as Role | null) ?? null,
  };
}

/**
 * Write the claim. MUST be called inside the same transaction as the effect it guards, at
 * the point where the effect's own rows have already been written — so the two either both
 * land or both roll back.
 *
 * `response` is the original response body when the caller can produce it synchronously
 * (the combatant PATCH can). Callers whose response is derived asynchronously after commit
 * pass null here and backfill via {@link backfillEncounterOpResponse}.
 */
export function recordEncounterOp(
  tx: AnyTx,
  claim: EncounterOpClaim,
  nowIsoString: string,
  response: { body: unknown; role: Role } | null,
): void {
  try {
    tx.insert(encounterOpIdempotency)
      .values({
        actorId: claim.actorId,
        operation: claim.operation,
        key: claim.key,
        encounterId: claim.encounterId,
        campaignId: claim.campaignId,
        fingerprint: claim.fingerprint,
        responseJson: response ? JSON.stringify(response.body) : null,
        responseRole: response ? response.role : null,
        createdAt: nowIsoString,
      })
      .run();
  } catch (err) {
    // Another request with the same key committed between our SELECT and this INSERT.
    // Roll our effect back and let the caller replay theirs — exactly one apply survives.
    const message = err instanceof Error ? err.message : String(err);
    if (!/UNIQUE|unique|PRIMARY KEY/i.test(message)) throw err;
    throw new EncounterOpRaceMarker(claim);
  }
}

/**
 * Attach the original response to an already-committed claim (issue #580).
 *
 * Used by the turn endpoints, whose response is the whole role-redacted encounter and is
 * assembled asynchronously after the transaction commits. Splitting the write this way
 * keeps the property that matters — the CLAIM is atomic with the effect, so no double-apply
 * and no phantom block — and makes only the cached body best-effort. A replay that finds no
 * body (crash in the millisecond between commit and backfill) falls back to fresh server
 * truth; it never re-executes the effect.
 */
export async function backfillEncounterOpResponse(
  db: AnyTx,
  claim: EncounterOpClaim,
  response: { body: unknown; role: Role },
): Promise<void> {
  await db
    .update(encounterOpIdempotency)
    .set({ responseJson: JSON.stringify(response.body), responseRole: response.role })
    .where(
      and(
        eq(encounterOpIdempotency.actorId, claim.actorId),
        eq(encounterOpIdempotency.operation, claim.operation),
        eq(encounterOpIdempotency.key, claim.key),
      ),
    );
}

/**
 * Re-read a claim after an {@link EncounterOpRaceMarker} rollback, outside the transaction.
 * Returns the winner's stored response, or throws 409 if the row that won belongs to a
 * different intent.
 */
export async function readEncounterOpAfterRace(db: AnyTx, claim: EncounterOpClaim): Promise<EncounterOpPrior> {
  const [prior] = await db
    .select()
    .from(encounterOpIdempotency)
    .where(
      and(
        eq(encounterOpIdempotency.actorId, claim.actorId),
        eq(encounterOpIdempotency.operation, claim.operation),
        eq(encounterOpIdempotency.key, claim.key),
      ),
    )
    .limit(1);
  if (
    !prior ||
    prior.encounterId !== claim.encounterId ||
    prior.campaignId !== claim.campaignId ||
    prior.fingerprint !== claim.fingerprint
  ) {
    throw idempotencyKeyReuse();
  }
  return {
    response: prior.responseJson === null ? null : (JSON.parse(prior.responseJson) as unknown),
    responseRole: (prior.responseRole as Role | null) ?? null,
  };
}
