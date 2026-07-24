/**
 * Route-bound record loading (issue #853).
 *
 * Several entity editors keep the prior record painted while the route identity
 * changes. Mutation handlers already target the new route id, so a slow or failed
 * navigation can write A's prose/attendance/settings into B.
 *
 * This module is the shared generation-token + match helper used by Location,
 * Sessions, and Campaign settings pages (and unit-tested without DOM):
 *   - begin(id) aborts the prior load and bumps a generation
 *   - only the latest generation may commit a record
 *   - mutations stay blocked until the loaded record's id matches the route
 *   - a failed load clears the prior record so A's content never stays on B's URL
 */

export type RouteBoundRecordIdentity = { id: number };

/**
 * Monotonic generation gate for route-bound fetches. Every `begin()` aborts the
 * prior in-flight load; only the latest generation for the active route id may
 * commit. Mirrors PlayerDisplayLoadSequencer (#743) for entity editors.
 */
export class RouteBoundLoadSequencer {
  private generation = 0;
  private controller: AbortController | null = null;
  private activeId: number | null = null;

  get currentGeneration(): number {
    return this.generation;
  }

  get activeRouteId(): number | null {
    return this.activeId;
  }

  /**
   * Start a new load for `routeId`. Aborts any prior in-flight load and bumps
   * the generation so late responses from the old load are ignored.
   */
  begin(routeId: number): { generation: number; signal: AbortSignal } {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.generation += 1;
    this.activeId = routeId;
    return { generation: this.generation, signal: controller.signal };
  }

  /** True when this generation is still the active load for `routeId`. */
  isCurrent(generation: number, routeId: number): boolean {
    return (
      generation === this.generation
      && this.activeId === routeId
      && this.controller != null
      && !this.controller.signal.aborted
    );
  }

  /**
   * Abort in-flight work and bump the generation so late responses cannot
   * commit. Call from React effect cleanup on route change / unmount — do not
   * also call from the next effect body, or the generation double-bumps.
   */
  invalidate(): void {
    this.controller?.abort();
    this.controller = null;
    this.generation += 1;
    this.activeId = null;
  }
}

/** True when the loaded record is the one the route currently addresses. */
export function recordMatchesRoute(
  record: RouteBoundRecordIdentity | null | undefined,
  routeId: number,
): boolean {
  return record != null && Number.isFinite(routeId) && record.id === routeId;
}

/**
 * Mutation controls must stay disabled until the painted record matches the
 * route and is not mid-load. Prevents editing A's fields into B's id.
 */
export function mutationsEnabledForRoute(
  record: RouteBoundRecordIdentity | null | undefined,
  routeId: number,
  loading: boolean,
): boolean {
  return !loading && recordMatchesRoute(record, routeId);
}

export type RouteBoundCommitDecision<T extends RouteBoundRecordIdentity> =
  | { kind: 'commit'; record: T }
  | { kind: 'ignore'; reason: 'stale-generation' | 'identity-mismatch' };

/**
 * Decide whether a fetch result may replace editor state. Rejects superseded
 * generations and responses whose body id does not match the route (so a
 * misrouted/cached body for A can never paint on B).
 */
export function decideRouteBoundCommit<T extends RouteBoundRecordIdentity>(
  sequencer: RouteBoundLoadSequencer,
  generation: number,
  routeId: number,
  record: T,
): RouteBoundCommitDecision<T> {
  if (!sequencer.isCurrent(generation, routeId)) {
    return { kind: 'ignore', reason: 'stale-generation' };
  }
  if (record.id !== routeId) {
    return { kind: 'ignore', reason: 'identity-mismatch' };
  }
  return { kind: 'commit', record };
}

/**
 * After a sequenced load fails, clear painted state so retry never keeps
 * presenting prior content (A's canon on B's URL, or a failed B looking live).
 */
export function recordAfterLoadFailure<T extends RouteBoundRecordIdentity>(
  _current: T | null,
  _routeId: number,
): T | null {
  return null;
}

/**
 * Build a mutation payload guard: if the draft was opened against record A but
 * the route is now B, refuse to send. Callers pass the id the editor believes
 * it is editing (`loadedId`) and the route id.
 */
export function assertMutationTarget(
  loadedId: number | null | undefined,
  routeId: number,
): { ok: true } | { ok: false; reason: 'no-record' | 'route-mismatch' } {
  if (loadedId == null || !Number.isFinite(loadedId)) return { ok: false, reason: 'no-record' };
  if (loadedId !== routeId) return { ok: false, reason: 'route-mismatch' };
  return { ok: true };
}

/**
 * True when a prospective request body (or URL) still carries identifiers from
 * a prior record — used by tests to assert A→B navigation never ships A's ids
 * in B's mutation.
 */
export function payloadContainsForeignId(
  payload: unknown,
  foreignId: number,
  routeId: number,
): boolean {
  if (foreignId === routeId) return false;
  const needle = String(foreignId);
  try {
    return JSON.stringify(payload).includes(needle);
  } catch {
    return false;
  }
}
