import type { Role } from '@campfire/schema';
import type { CampaignEvent } from '@campfire/schema';
import {
  CAMPAIGN_BROADCAST_SAFE_FRAMES as AI_DM_BROADCAST_SAFE_FRAMES,
  PROJECTED_FRAME_TYPES,
  projectCampaignEventForRole,
} from '../../src/modules/events/campaign-event-projection';

/**
 * Role projection at the AI-DM SSE boundary (#1552).
 *
 * THE BUG: the controller projected `tool` and `transcript` inline and forwarded every other
 * frame verbatim. `secret-approval` carries `tool` + `entityId`, naming a DM-hidden entity, and
 * reached every member of the table — while the transcript row for that same event is written
 * `visibility: 'dm'` under a comment saying a player must not merely fail to RENDER a DM-only
 * event they were already handed.
 *
 * The point of these tests is NOT that one more case was added. It is that the polarity is now
 * inverted: every frame type must be classified, unclassified frames are dropped, and the list
 * below is the runtime counterpart to the compile-time `Record` that makes an unclassified
 * frame type a build error.
 */

const at = '2026-07-27T10:00:00.000Z';

/**
 * One sample frame per union member. This list is deliberately hand-maintained: a new frame
 * type must be added here, which is the moment its author decides what a player may see. The
 * `satisfies` keeps every sample a real member of the union rather than a lookalike.
 */
const SAMPLES = [
  { type: 'turn.start', campaignId: 1, at },
  { type: 'narration.delta', campaignId: 1, text: 'A door.', at },
  { type: 'narration.message', campaignId: 1, text: 'A door.', at },
  { type: 'tool', campaignId: 1, name: 'get_npc', isError: false, proposed: false, encounterId: 9, encounterHidden: true, at },
  { type: 'turn.cancelled', campaignId: 1, narration: 'cut', stopReason: 'stopped', at },
  { type: 'turn.error', campaignId: 1, stopReason: 'provider_error', code: 'x', message: 'boom', retryable: true, steps: 1, tokensUsed: 2, budgetRemaining: 3, at },
  { type: 'turn.end', campaignId: 1, stopReason: 'complete', steps: 1, tokensUsed: 2, budgetRemaining: 3, at },
  { type: 'stuck', campaignId: 1, reason: 'tool_error', detail: 'd', state: 'awaiting_players', levers: ['nudge'], at },
  { type: 'recovered', campaignId: 1, state: 'running', at },
  { type: 'state', campaignId: 1, state: 'paused', at },
  { type: 'vote', campaignId: 1, action: 'opened', kind: 'pause', at },
  { type: 'takeover', campaignId: 1, action: 'requested', memberId: 'm1', at },
  { type: 'secret-approval', campaignId: 1, action: 'granted', tool: 'get_npc', entityId: 4242, at },
  { type: 'tool-confirmation', campaignId: 1, action: 'queued', confirmationId: 'c1', tool: 'end_encounter', at },
  {
    type: 'transcript',
    campaignId: 1,
    visibility: 'dm',
    event: {
      eventId: 'e1', seq: 1, campaignId: 1, kind: 'control', actorUserId: null, actorName: null,
      clientRef: null, turnId: null, payload: { control: 'secret-approval', entityId: 4242 }, at,
    },
    at,
  },
  { type: 'session.reset', campaignId: 1, voteExpired: false, approvalsRevoked: 2, confirmationsDiscarded: 0, at },
  { type: 'transcript.reset', campaignId: 1, at },
  { type: 'grounding', campaignId: 1, status: 'clean', supportedCount: 1, unsupportedCount: 0, provider: 'mock', model: 'm', claimIds: [1], at },
] satisfies CampaignEvent[];

const NON_DM_ROLES: Role[] = ['player', 'viewer'];

describe('#1552 every frame type is classified', () => {
  it('covers the whole union: each frame is projected or explicitly broadcast-safe', () => {
    // The runtime half of the guarantee. The compile-time half is
    // `Record<Exclude<CampaignEvent['type'], ProjectedFrameType>, string>`, which stops
    // type-checking when a union member is added without a reason. This catches the case where
    // someone silences that with a cast.
    for (const sample of SAMPLES) {
      const projected = (PROJECTED_FRAME_TYPES as readonly string[]).includes(sample.type);
      const safe = sample.type in AI_DM_BROADCAST_SAFE_FRAMES;
      expect(projected !== safe).toBe(true); // exactly one, never both, never neither
    }
  });

  it('records a REASON for every broadcast-safe frame, not just a name', () => {
    // "We checked and it carries no identity" is the information a future reader needs; a bare
    // list of names decays into "frames nobody got round to projecting".
    for (const [type, reason] of Object.entries(AI_DM_BROADCAST_SAFE_FRAMES)) {
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(25);
      expect(type.length).toBeGreaterThan(0);
    }
  });

  it('DROPS an unclassified frame rather than forwarding it', () => {
    // Fail closed at runtime too. A hand-rolled or cast frame that no branch recognises must
    // not reach the wire just because nothing said it could not.
    const rogue = { type: 'totally.new', campaignId: 1, entityId: 99, at } as unknown as CampaignEvent;
    expect(projectCampaignEventForRole(rogue, 'player')).toBeNull();
    expect(projectCampaignEventForRole(rogue, 'dm')).toBeNull();
  });
});

describe('#1552 secret-approval is withheld from non-DMs', () => {
  const secretApproval = SAMPLES.find((s) => s.type === 'secret-approval')!;

  it('sends NO FRAME to a player or viewer', () => {
    // Decided over stripping `entityId` and still sending: the sibling transcript row is
    // dropped wholesale for non-DMs, a stripped frame would prompt a refetch of a list players
    // cannot read, and the EXISTENCE of an approval already tells the table there is something
    // hidden to know.
    for (const role of NON_DM_ROLES) {
      expect(projectCampaignEventForRole(secretApproval, role)).toBeNull();
    }
  });

  it('still delivers the full frame to the DM', () => {
    // As important as the leak test: a fix that projected everyone's frames into uselessness
    // would pass the assertion above and break the feature.
    const forDm = projectCampaignEventForRole(secretApproval, 'dm') as Record<string, unknown>;
    expect(forDm).not.toBeNull();
    expect(forDm.entityId).toBe(4242);
    expect(forDm.tool).toBe('get_npc');
    expect(forDm.action).toBe('granted');
  });
});

describe('#1552 the previously-projected frames still behave', () => {
  it('strips a hidden encounter id from a tool frame for non-DMs, keeps it for the DM', () => {
    const tool = SAMPLES.find((s) => s.type === 'tool')!;
    for (const role of NON_DM_ROLES) {
      const projected = projectCampaignEventForRole(tool, role) as Record<string, unknown>;
      expect(projected).not.toBeNull();
      expect(projected.encounterId).toBeUndefined();
      // The internal hint never leaves the server for anyone.
      expect(projected.encounterHidden).toBeUndefined();
    }
    const forDm = projectCampaignEventForRole(tool, 'dm') as Record<string, unknown>;
    expect(forDm.encounterId).toBe(9);
    expect(forDm.encounterHidden).toBeUndefined();
  });

  it('drops a DM-only transcript frame for non-DMs and strips the internal visibility hint', () => {
    const transcript = SAMPLES.find((s) => s.type === 'transcript')!;
    for (const role of NON_DM_ROLES) {
      expect(projectCampaignEventForRole(transcript, role)).toBeNull();
    }
    const forDm = projectCampaignEventForRole(transcript, 'dm') as Record<string, unknown>;
    expect(forDm).not.toBeNull();
    expect(forDm.visibility).toBeUndefined();
  });
});

describe('#1552 broadcast-safe frames reach everyone unchanged', () => {
  it('forwards every safe frame verbatim to a player', () => {
    // The other half of "do not project everything into uselessness": narration, lifecycle and
    // vote signals are the table's shared experience and must not be degraded by this fix.
    for (const sample of SAMPLES) {
      if (!(sample.type in AI_DM_BROADCAST_SAFE_FRAMES)) continue;
      expect(projectCampaignEventForRole(sample, 'player')).toEqual(sample);
    }
  });

  it('keeps session.reset counts-only for every role (#1042 restraint)', () => {
    // #1042 refused to emit one frame per revoked approval precisely because this leak existed;
    // its restraint must survive the fix rather than being undone by it.
    const reset = SAMPLES.find((s) => s.type === 'session.reset')!;
    for (const role of [...NON_DM_ROLES, 'dm' as Role]) {
      const out = projectCampaignEventForRole(reset, role) as Record<string, unknown>;
      expect(out.approvalsRevoked).toBe(2);
      expect(JSON.stringify(out)).not.toContain('4242');
    }
  });
});
