/**
 * The role-projection boundary for the AI-DM SSE stream (#1552). Pure: no DB, no I/O.
 *
 * WHAT WAS WRONG. The controller projected exactly two frame types — `tool` and `transcript` —
 * inline in its `map`, and passed everything else through verbatim. That reads like a boundary
 * but is a per-type ALLOWLIST OF THINGS TO PROTECT, so anything not named is broadcast raw. The
 * `secret-approval` frame carries `tool` plus `entityId`, naming a DM-hidden entity, and went
 * to every member of the table. The transcript row written for that same event is
 * `visibility: 'dm'` and carries a comment saying a player must not merely fail to RENDER a
 * DM-only event they were already handed — the SSE signal beside it did exactly that.
 *
 * WHY THIS FILE EXISTS AT ALL, RATHER THAN ONE MORE `case`. Adding `case 'secret-approval':`
 * to the old switch fixes today's leak and leaves the next frame type exposed, because the
 * shape of the mistake is the default, not the missing case. So the polarity is inverted here:
 * every frame must be CLASSIFIED, and the classification is enforced by the compiler.
 *
 *   - {@link PROJECTED_FRAME_TYPES} are frames whose content depends on the reader's role.
 *     `projectAiDmStreamEventForRole` has an explicit branch for each, and the `default:`
 *     is a `never` exhaustiveness guard — a new projected type that is not handled fails to
 *     compile.
 *   - {@link AI_DM_BROADCAST_SAFE_FRAMES} is a `Record` keyed by EVERY OTHER frame type, with
 *     a written reason each carries no reader-dependent identity. Because the key type is
 *     `Exclude<AiDmStreamEvent['type'], ProjectedFrameType>`, adding a frame type to the union
 *     without classifying it is a COMPILE ERROR — the same allowlist shape as #1070's
 *     inheritable seat fields, pointed the other way: there, unclassified fields must not be
 *     inherited; here, unclassified frames must not be broadcast raw.
 *   - An unknown type arriving at runtime (a cast, a hand-rolled frame) is DROPPED rather than
 *     forwarded. Fail closed on both axes, compile time and run time.
 *
 * WHAT A NON-DM GETS FOR `secret-approval`: NOTHING. See the branch below for why the frame is
 * dropped entirely rather than stripped of its `entityId`.
 */
import type { Role } from '@campfire/schema';
import type { AiDmStreamEvent } from './ai-driver-stream.service';
import { projectAiDmToolEventForRole } from './ai-dm-tool-resource';
import { projectTranscriptEventForRole } from './ai-driver-transcript.service';

/** Frame types whose delivered content depends on who is reading. */
export const PROJECTED_FRAME_TYPES = ['tool', 'transcript', 'secret-approval'] as const;
export type ProjectedFrameType = (typeof PROJECTED_FRAME_TYPES)[number];

/** Every other frame type. Adding a union member without a reason here fails to compile. */
export type BroadcastSafeFrameType = Exclude<AiDmStreamEvent['type'], ProjectedFrameType>;

/**
 * Frames that may reach every campaign member verbatim, and WHY each is safe.
 *
 * The reasons are load-bearing, not decoration: this is the list a future reader consults when
 * adding a frame, and "it looked fine" is not something they can inherit from a bare name. Each
 * entry is an assertion that the frame carries no identity whose visibility depends on role.
 */
export const AI_DM_BROADCAST_SAFE_FRAMES: Record<BroadcastSafeFrameType, string> = {
  'turn.start': 'Carries only the campaign id and a timestamp; the table needs to know a turn began.',
  'narration.delta':
    'The prose the whole table is watching. The system prompt is assembled through a PLAYER-scoped toolset (#387) precisely so narration cannot contain DM-only material.',
  'narration.message': 'The aggregated form of the same table-visible prose as narration.delta.',
  'narration.withheld':
    'A RETRACTION, not content (#598). Carries a normalized finish reason (content_filter / refusal) and a fixed neutral sentence the SERVER chooses — never a fragment of the withheld prose, never an entity id. It must reach every reader the deltas reached, i.e. the whole table: its job is to make clients drop the in-progress bubble before turn.end can promote those deltas into the permanent transcript. Withholding it from anyone would leave exactly the text it exists to retract sitting on their screen, so role-gating this frame would invert its purpose.',
  'turn.cancelled':
    'Narration already shown to the table, plus a stop reason. No entity identity.',
  'turn.error':
    'A provider failure the whole table needs to see (#560), plus budget counters the table already reads off the seat budget meter.',
  'turn.end': 'Stop reason, step count and budget counters — all already table-visible on the budget meter.',
  stuck:
    'Stuck-ladder detection: a reason code, a state, and the player levers being offered. The levers are the players’ own affordances (#314).',
  recovered: 'A lifecycle state name — the table needs to see the seat start running again.',
  state: 'A lifecycle state name (paused, running, human control) that every member’s UI renders.',
  vote: 'A TABLE vote — its whole purpose is that every member sees it (#314).',
  takeover:
    'Names a campaign MEMBER taking the seat, which is already visible to the table from the member list.',
  'tool-confirmation':
    'A confirmation id and the tool name. Carries no entity id, and the `tool` frame already broadcasts `pendingConfirmation` to the whole table by design (#474), so the existence of a pending confirmation is not new information here.',
  'session.reset':
    'COUNTS ONLY, deliberately (#1042): a burst of one frame per revoked approval would have handed the table the DM’s entire approved-secrets set. The discarded items live in the audit log and a DM-only transcript row. Do not add detail to this frame.',
  'transcript.reset': 'Carries only the campaign id — every member must drop stale local scrollback and refetch.',
  grounding:
    'Verdict counts plus the ruling’s provider/model provenance badge and claim row ids for a refetch. The claim read itself is role-gated (#577), and the counts are already on this frame, so the ids disclose nothing further.',
};

/**
 * Project one AI-DM stream frame for a reader's role, or return `null` to withhold it entirely.
 *
 * `null` means the subscriber never receives the frame — the same treatment
 * `projectTranscriptEventForRole` gives a DM-only transcript row, and the reason this returns a
 * nullable rather than always producing something.
 */
export function projectAiDmStreamEventForRole(event: AiDmStreamEvent, role: Role): unknown | null {
  const isDm = role === 'dm';

  switch (event.type) {
    case 'tool':
      // #825 / #262: a hidden encounter's id is stripped for non-DMs. The frame itself is
      // table-visible — players should see that the AI acted — so this projects rather than drops.
      return projectAiDmToolEventForRole(event, role);

    case 'transcript': {
      // #572: row-level redaction. A 'dm' row is DROPPED for players and viewers, and the
      // internal `visibility` hint never leaves the server.
      const projected = projectTranscriptEventForRole(event.event, event.visibility, role);
      if (projected === null) return null;
      return { type: 'transcript' as const, campaignId: event.campaignId, event: projected, at: event.at };
    }

    case 'secret-approval':
      /**
       * #1552 — WITHHELD ENTIRELY from non-DMs, not stripped down to a contentless signal.
       *
       * The alternative was to keep the frame and drop `entityId`. Rejected for three reasons,
       * in increasing order of importance:
       *
       * 1. It would answer one event two different ways. The transcript row for this exact
       *    event is written `visibility: 'dm'`, which drops it wholesale for non-DMs. A
       *    stripped frame beside a dropped row is an inconsistency a future reader has to
       *    re-derive.
       * 2. A stripped frame would be useless anyway. This is a thin signal whose only job is
       *    "refetch GET /ai-dm/session for the authoritative approval list", and that list is
       *    private guard state stripped from every member's session read. A player told to
       *    refetch would learn nothing from the refetch.
       * 3. The EXISTENCE of an approval is itself the disclosure. It tells the table that the
       *    DM has authorised the AI to read something hidden — i.e. that there is something to
       *    know — at a table where the DM may be working hard not to signal that. #1042
       *    reasoned identically when it refused to emit per-approval frames on restart and
       *    sent counts only.
       */
      return isDm ? event : null;

    default: {
      // Compile-time: a new frame type not listed in PROJECTED_FRAME_TYPES must appear in
      // AI_DM_BROADCAST_SAFE_FRAMES, or its `Record` key type stops type-checking. Run-time:
      // anything that reaches here without a classification is DROPPED, never forwarded, so a
      // cast or a hand-rolled frame cannot smuggle itself onto the wire.
      const safeType = event.type as BroadcastSafeFrameType;
      return safeType in AI_DM_BROADCAST_SAFE_FRAMES ? event : null;
    }
  }
}
