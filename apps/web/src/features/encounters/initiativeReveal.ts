import type { EncounterStatus } from '@campfire/schema';

/**
 * Pure transition guard for the initiative reveal animation (issue #1934).
 *
 * Reveal animation plays when:
 * 1. An encounter transitions from 'preparing' -> 'running' (observed by DM, players, or cast), OR
 * 2. DM triggers roll initiative while in 'preparing' status with `rolledCount > 0`.
 *
 * The guard ensures the reveal plays at most once per encounter ID per client session.
 * Subsequent SSE refetches while 'running' or manual initiative edits do NOT replay the reveal.
 */
export function shouldRevealInitiative({
  prevStatus,
  nextStatus,
  encounterId,
  revealedEncounterIds,
  rolledCount = 0,
}: {
  prevStatus: EncounterStatus | null;
  nextStatus: EncounterStatus | null;
  encounterId: number;
  revealedEncounterIds: ReadonlySet<number>;
  rolledCount?: number;
}): boolean {
  if (revealedEncounterIds.has(encounterId)) {
    return false;
  }

  const transitionedToRunning = prevStatus === 'preparing' && nextStatus === 'running';
  const rolledDuringPrep = (prevStatus === 'preparing' || prevStatus === null) && nextStatus === 'preparing' && rolledCount > 0;

  return transitionedToRunning || rolledDuringPrep;
}
