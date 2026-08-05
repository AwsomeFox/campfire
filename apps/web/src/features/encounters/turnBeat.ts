/**
 * Classifies a received `encounter.turn_changed` frame against the last known
 * turn. This deliberately has no React or browser dependencies: refetches do
 * not call it, so they cannot replay a visible turn-start beat.
 */
export type TurnBeatSnapshot = {
  encounterId: number;
  combatantId: number | null;
  round: number | null;
  isYourTurn: boolean;
};

export type TurnBeatKind = 'your-turn' | 'turn' | 'round-wrap';

export function turnBeatKey(snapshot: TurnBeatSnapshot): string | null {
  if (snapshot.combatantId == null || snapshot.round == null) return null;
  return `${snapshot.encounterId}:${snapshot.combatantId}:${snapshot.round}`;
}

/**
 * The initial snapshot establishes a silent baseline. A new owned turn wins
 * over the generic round/turn ticker; callers can still choose the round
 * treatment for their accompanying non-blocking ticker.
 */
export function detectTurnBeat(
  previous: TurnBeatSnapshot | null,
  next: TurnBeatSnapshot,
): TurnBeatKind | null {
  if (previous == null || previous.encounterId !== next.encounterId) return null;

  const previousKey = turnBeatKey(previous);
  const nextKey = turnBeatKey(next);
  if (previousKey === nextKey) return null;

  if (next.isYourTurn && nextKey != null && (!previous.isYourTurn || previousKey !== nextKey)) {
    return 'your-turn';
  }
  if (next.round != null && previous.round != null && next.round > previous.round) {
    return 'round-wrap';
  }
  if (previous.combatantId !== next.combatantId || previous.round !== next.round) {
    return 'turn';
  }
  return null;
}
