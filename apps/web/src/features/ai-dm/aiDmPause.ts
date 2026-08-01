/**
 * The pause/resume request the AI DM seat's UI sends (#1501).
 *
 * The POST /ai-dm/pause DTO is strict (`{ paused: boolean }`) and 400'd on the empty body the UI
 * used to send; POST /ai-dm/resume ignores the body entirely. Sending `{ paused }` to BOTH is safe,
 * so a single helper keeps the `{ action, body }` pair every call site needs correct in lockstep —
 * the toggle posts `pause` with `{ paused: true }` and `resume` with `{ paused: false }`, mirroring
 * the one correct caller that already existed (StuckLadder).
 */
export interface AiDmPauseRequest {
  action: 'pause' | 'resume';
  body: { paused: boolean };
}

export function aiDmPauseRequest(paused: boolean): AiDmPauseRequest {
  return { action: paused ? 'resume' : 'pause', body: { paused: !paused } };
}
