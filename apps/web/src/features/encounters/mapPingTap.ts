/**
 * Battle-map ping tap completion (issue #809).
 *
 * Ping used to broadcast on pointerdown, which meant palm rests, grip
 * adjustments, aborted scrolls, and interrupted contacts all went to the whole
 * table. These helpers define a completed tap: arm on primary pointer-down,
 * publish only on a matching pointer-up that stays inside slop + time, and
 * cancel on excess movement, timeout, or ownership loss.
 *
 * Pure / DOM-free so unit tests can pin the thresholds without a browser.
 */

/** Max pointer travel (CSS px) from the arm point while still counting as a tap. */
export const MAP_PING_TAP_SLOP_PX = 10;

/** Max hold duration (ms) from arm to release for a completed tap. */
export const MAP_PING_TAP_MAX_MS = 500;

/** Keyboard / screen-reader activation lands at map center. */
export const MAP_PING_KEYBOARD_POINT = { x: 50, y: 50 } as const;

export type MapPingTapArm = {
  pointerId: number;
  clientX: number;
  clientY: number;
  startedAt: number;
  /** Map percentage coordinates captured at arm time (the published location). */
  x: number;
  y: number;
};

export type MapPingTapCancelReason = 'slop' | 'timeout' | 'mismatch';

export type MapPingTapReleaseDecision =
  | { action: 'publish'; x: number; y: number }
  | { action: 'cancel'; reason: MapPingTapCancelReason };

export function armMapPingTap(input: {
  pointerId: number;
  clientX: number;
  clientY: number;
  startedAt: number;
  x: number;
  y: number;
}): MapPingTapArm {
  return {
    pointerId: input.pointerId,
    clientX: input.clientX,
    clientY: input.clientY,
    startedAt: input.startedAt,
    x: input.x,
    y: input.y,
  };
}

export function mapPingTapDistancePx(
  arm: Pick<MapPingTapArm, 'clientX' | 'clientY'>,
  clientX: number,
  clientY: number,
): number {
  return Math.hypot(clientX - arm.clientX, clientY - arm.clientY);
}

export function mapPingTapExceededSlop(
  arm: Pick<MapPingTapArm, 'clientX' | 'clientY'>,
  clientX: number,
  clientY: number,
  slopPx: number = MAP_PING_TAP_SLOP_PX,
): boolean {
  return mapPingTapDistancePx(arm, clientX, clientY) > slopPx;
}

export function mapPingTapTimedOut(
  arm: Pick<MapPingTapArm, 'startedAt'>,
  nowMs: number,
  maxMs: number = MAP_PING_TAP_MAX_MS,
): boolean {
  return nowMs - arm.startedAt > maxMs;
}

/**
 * Decide whether a pointer-up should publish the armed ping. Ownership is
 * checked first; a mismatched pointer never publishes. Publish uses the arm
 * coordinates so slight within-slop drift does not shift the marker.
 */
export function decideMapPingTapRelease(
  arm: MapPingTapArm | null,
  release: { pointerId: number; clientX: number; clientY: number; nowMs: number },
  options?: { slopPx?: number; maxMs?: number },
): MapPingTapReleaseDecision {
  if (!arm || arm.pointerId !== release.pointerId) {
    return { action: 'cancel', reason: 'mismatch' };
  }
  const slopPx = options?.slopPx ?? MAP_PING_TAP_SLOP_PX;
  const maxMs = options?.maxMs ?? MAP_PING_TAP_MAX_MS;
  if (mapPingTapTimedOut(arm, release.nowMs, maxMs)) {
    return { action: 'cancel', reason: 'timeout' };
  }
  if (mapPingTapExceededSlop(arm, release.clientX, release.clientY, slopPx)) {
    return { action: 'cancel', reason: 'slop' };
  }
  return { action: 'publish', x: arm.x, y: arm.y };
}

/** True for a bare Enter / Space activation (no modifier chord, no key-repeat). */
export function isMapPingKeyboardActivation(event: {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** Browser auto-repeat while a key is held — must not spam pings. */
  repeat?: boolean;
}): boolean {
  if (event.repeat) return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar';
}
