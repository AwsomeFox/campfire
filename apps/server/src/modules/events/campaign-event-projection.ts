import type { Role, CampaignEvent } from '@campfire/schema';
import { projectAiDmToolEventForRole } from '../ai-driver/ai-dm-tool-resource';
import { projectTranscriptEventForRole } from '../ai-driver/ai-driver-transcript.service';

/** Frame types whose delivered content depends on who is reading. */
export const PROJECTED_FRAME_TYPES = ['tool', 'transcript', 'secret-approval'] as const;
export type ProjectedFrameType = (typeof PROJECTED_FRAME_TYPES)[number];

/** Every other frame type. Adding a union member without a reason here fails to compile. */
export type BroadcastSafeFrameType = Exclude<CampaignEvent['type'], ProjectedFrameType>;

/**
 * Frames that may reach every campaign member verbatim, and WHY each is safe.
 *
 * The reasons are load-bearing, not decoration: this is the list a future reader consults when
 * adding a frame, and "it looked fine" is not something they can inherit from a bare name. Each
 * entry is an assertion that the frame carries no identity whose visibility depends on role.
 */
export const CAMPAIGN_BROADCAST_SAFE_FRAMES: Record<BroadcastSafeFrameType, string> = {
  // Existing CampaignEvent types
  'party.rest.updated': 'Thin signal, refetches permission-checked party stats.',
  'encounter.updated': 'Thin signal, refetches permission-checked encounter.',
  'encounter.turn_changed': 'Public turn state notification for encounter advancement.',
  'encounter.deleted': 'Id-only deletion signal, carries no payload or secrets.',
  'encounter.ping': 'Public map ping click coordinates visible to all players.',
  'schedule.updated': 'Id-only invalidation signal, refetch is permission-checked.',
  'membership.revoked': 'Filtered server-side, never sent as data.',
  'membership.updated': 'Public role change notification for campaign members.',
  'treasury.updated': 'Thin invalidation signal for treasury updates.',
  'character.updated': 'Thin invalidation signal for character sheet changes.',
  'check.requested': 'Thin invalidation signal for requested ability checks.',
  'check.resolved': 'Thin signal indicating a check request was resolved.',
  'campaign.trashed': 'Filtered server-side, never sent as data.',
  'safety.hold': 'Active state only, contains no actor or user identity.',

  // AI-DM stream types
  'turn.start': 'Carries only the campaign id and a timestamp; the table needs to know a turn began.',
  'narration.delta': 'The prose the whole table is watching. The system prompt is assembled through a PLAYER-scoped toolset (#387) precisely so narration cannot contain DM-only material.',
  'narration.message': 'The aggregated form of the same table-visible prose as narration.delta.',
  'narration.withheld': 'A RETRACTION, not content (#598). Carries a normalized finish reason (content_filter / refusal) and a fixed neutral sentence the SERVER chooses — never a fragment of the withheld prose, never an entity id. It must reach every reader the deltas reached, i.e. the whole table: its job is to make clients drop the in-progress bubble before turn.end can promote those deltas into the permanent transcript. Withholding it from anyone would leave exactly the text it exists to retract sitting on their screen, so role-gating this frame would invert its purpose.',
  'turn.cancelled': 'Narration already shown to the table, plus a stop reason. No entity identity.',
  'turn.error': 'A provider failure the whole table needs to see (#560), plus budget counters the table already reads off the seat budget meter.',
  'turn.end': 'Stop reason, step count and budget counters — all already table-visible on the budget meter.',
  stuck: 'Stuck-ladder detection: a reason code, a state, and the player levers being offered. The levers are the players’ own affordances (#314).',
  recovered: 'A lifecycle state name — the table needs to see the seat start running again.',
  state: 'A lifecycle state name (paused, running, human control) that every member’s UI renders.',
  phase: 'A session lifecycle phase name (greeting, active, wrap_up, ended) and nothing else (#1043) — the same shape as `state`, and the source of the table-visible phase note every member’s UI renders. Start Session is a lever any member may pull, so the phase is not DM-only information.',
  vote: 'A TABLE vote — its whole purpose is that every member sees it (#314).',
  takeover: 'Names a campaign MEMBER taking the seat, which is already visible to the table from the member list.',
  'tool-confirmation': 'A confirmation id and the tool name. Carries no entity id, and the `tool` frame already broadcasts `pendingConfirmation` to the whole table by design (#474), so the existence of a pending confirmation is not new information here.',
  'session.reset': 'COUNTS ONLY, deliberately (#1042): a burst of one frame per revoked approval would have handed the table the DM’s entire approved-secrets set. The discarded items live in the audit log and a DM-only transcript row. Do not add detail to this frame.',
  'transcript.reset': 'Carries only the campaign id — every member must drop stale local scrollback and refetch.',
  grounding: 'Verdict counts plus the ruling’s provider/model provenance badge and claim row ids for a refetch. The claim read itself is role-gated (#577), and the counts are already on this frame, so the ids disclose nothing further.',
  'player-display-scene': 'Public player display scene update.',
};

/**
 * Project one campaign stream frame for a reader's role, or return `null` to withhold it entirely.
 *
 * `null` means the subscriber never receives the frame — the same treatment
 * `projectTranscriptEventForRole` gives a DM-only transcript row, and the reason this returns a
 * nullable rather than always producing something.
 */
export function projectCampaignEventForRole(event: CampaignEvent, role: Role): unknown | null {
  const isDm = role === 'dm';

  switch (event.type) {
    case 'tool':
      // #825 / #262: a hidden encounter's id is stripped for non-DMs. The frame itself is
      // table-visible — players should see that the AI acted — so this projects rather than drops.
      return projectAiDmToolEventForRole(event as any, role);

    case 'transcript': {
      // #572: row-level redaction. A 'dm' row is DROPPED for players and viewers, and the
      // internal `visibility` hint never leaves the server.
      const projected = projectTranscriptEventForRole(event.event, event.visibility as any, role);
      if (projected === null) return null;
      return { type: 'transcript' as const, campaignId: event.campaignId, event: projected, at: event.at };
    }

    case 'secret-approval':
      return isDm ? event : null;

    default: {
      const safeType = event.type as BroadcastSafeFrameType;
      return safeType in CAMPAIGN_BROADCAST_SAFE_FRAMES ? event : null;
    }
  }
}
