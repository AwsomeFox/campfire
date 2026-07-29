import type { DriverTool } from '../mcp/mcp-tools';

/** How the driver may commit a tool call under the campaign policy (#474). */
export type DriverToolPolicyClass = 'auto' | 'confirm' | 'propose' | 'deny';

/** Session phase for per-profile policy (#474): prep, live combat, or post-fight aftermath. */
export type DriverSessionProfile = 'prep' | 'live' | 'aftermath';

/** Inputs for resolving the active session profile from encounter state. */
export interface DriverSessionProfileInput {
  hasRunningEncounter: boolean;
  hasPreparingEncounter: boolean;
  hasEndedEncounter: boolean;
}

/** Context passed to {@link resolveDriverToolPolicy}. */
export interface DriverToolPolicyContext {
  profile: DriverSessionProfile;
  tool: Pick<DriverTool, 'name' | 'mutating' | 'proposalCapable'>;
  /** Whether the tool is on the explicit live-play allow-list (default-deny writes). */
  onLivePlayAllowList: boolean;
  /**
   * Collaborative handoff (#1051): the AI narrates, a human decides the mechanics. Promotes the
   * tools in {@link DRIVER_COLLABORATIVE_DEFER_TOOLS} from `auto` to `confirm`; nothing else
   * changes. See that set for which tools defer and why.
   */
  collaborative?: boolean;
}

/** Result of evaluating a tool call against policy (#474). */
export interface DriverToolPolicyDecision {
  policy: DriverToolPolicyClass;
  profile: DriverSessionProfile;
  /** When true the model may see the tool in its schema for this turn. */
  offer: boolean;
  /** Human-readable reason when policy is deny or confirm. */
  reason?: string;
  /** Whether a successful commit can be reversed with undo_action (#414). */
  undoable: boolean;
}

/** A DM-reviewed, single-use execution grant for a queued confirm-policy tool (#474). */
export interface AiDmPendingToolConfirmation {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  toolCallId: string;
  profile: DriverSessionProfile;
  policy: DriverToolPolicyClass;
  requestedAt: string;
  /** Seat actor (`ai-dm-seat:{campaignId}`). */
  actor: string;
  /** Player who triggered the turn. */
  triggeredBy: string;
  turnNumber: number;
  /**
   * Internal lifecycle marker for a chain this confirmation temporarily kept beyond preview TTL.
   * It is shared by every queued confirmation for that chain, so release waits for the final
   * owner even when an earlier confirmation performed the false-to-true transition.
   */
  retainedActionChain?: { encounterId: number; chainId: string };
}

/** Tool-name prefixes the driver seat may never call — every hard delete, even proposed. */
export const DRIVER_FORBIDDEN_PREFIXES = ['delete_'] as const;

/** Per-turn cap on map-generation tools (#488 / #474). */
export const DRIVER_GENERATE_MAP_BUDGET_PER_TURN = 1;
/** Per-call treasury grant cap (per denomination) for autonomous live play. */
export const DRIVER_TREASURY_GRANT_MAX_PER_DENOMINATION = 10_000;
/** Max confirm-policy tool calls queued or attempted per driver turn (#474). */
export const DRIVER_CONFIRM_TOOL_ATTEMPTS_PER_TURN = 3;
/** Policy violations (deny / rate-limit / guard reject) before an emergency pause (#474). */
export const DRIVER_POLICY_VIOLATIONS_BEFORE_EMERGENCY_PAUSE = 5;
/** Max unconsumed confirm-policy grants held in a session at once (#474). */
export const MAX_PENDING_TOOL_CONFIRMATIONS = 20;

/**
 * Tools that defer to the DM under collaborative handoff (#1051).
 *
 * THE LINE THIS SET DRAWS is between producing INFORMATION and COMMITTING A MECHANICAL
 * OUTCOME. "The AI narrates, the human decides mechanics" is not "the AI asks permission to
 * think" — it is "the AI does not change the board without a human saying so".
 *
 * DEFERRED — each one changes the mechanical state of play: what a creature's numbers are, who
 * is on the board, or whose turn it is. These are the calls a DM would want to make themselves
 * in a game where they have handed narration to a co-DM but kept the rules.
 *
 * NOT DEFERRED, deliberately:
 *  - `roll_dice` / `roll_action_dice` / `roll_initiative` / `saving_throw`. A roll produces a
 *    NUMBER; it does not change anything until something applies it. Gating dice would make the
 *    mode unusable — a single attack is a roll, a save, and an apply — and would burn the
 *    per-turn confirm budget on results nobody needs to approve. Applying is where the decision
 *    lives, and applying is gated.
 *  - `undo_action`. It exists to reverse a mistake. Putting a confirmation in front of the undo
 *    button means a wrong outcome stays on the board until someone approves removing it.
 *  - Reads, canon writes (already `propose`), and anything already `confirm` or `deny` in the
 *    active profile — collaborative mode only ever tightens `auto`, never loosens anything.
 *
 * Note the overlap with {@link DRIVER_UNDOABLE_TOOLS}: those four are the mechanical commits the
 * resolver can reverse, so they are necessarily in here. The set is written out explicitly
 * rather than derived from that one, because a policy list is read by people auditing what the
 * AI may do unsupervised, and a clever derivation is a worse answer to "which tools?" than a
 * list.
 */
export const DRIVER_COLLABORATIVE_DEFER_TOOLS: ReadonlySet<string> = new Set([
  // Committing an action's outcome onto the board.
  'resolve_action',
  'apply_action',
  'update_character_hp',
  'set_character_conditions',
  // Who is on the board, and whose turn it is.
  'next_turn',
  'add_combatant',
  'update_combatant',
  'set_escalation_die',
  // Standing up a fight. (`begin_encounter` is already `confirm` in every profile, #474.)
  'create_encounter',
  'commit_encounter',
]);

/**
 * Per-turn confirm budget under collaborative handoff (#1051).
 *
 * The default of {@link DRIVER_CONFIRM_TOOL_ATTEMPTS_PER_TURN} exists to stop a runaway model
 * spamming confirmations at a DM who did not ask for any — three is an anomaly there. Under
 * collaborative handoff a confirmation is the EXPECTED path, and one ordinary combat turn is
 * easily four (resolve, apply, condition, next turn). Leaving the cap at three would make the
 * mode trip its own rate limit, surface tool errors, feed the stuck ladder, and march toward the
 * emergency pause at five policy violations — a mode that breaks itself the moment it is used.
 */
export const DRIVER_COLLABORATIVE_CONFIRM_ATTEMPTS_PER_TURN = 12;

/** Live-play tools whose successful commits support undo_action (#414 / #474). */
export const DRIVER_UNDOABLE_TOOLS: ReadonlySet<string> = new Set([
  'resolve_action',
  'apply_action',
  'update_character_hp',
  'set_character_conditions',
]);

/**
 * Explicit per-profile overrides for live-play and consequential tools (#474).
 * Omitted tools fall through to the default rules in {@link resolveDriverToolPolicy}.
 */
const PROFILE_TOOL_OVERRIDES: Readonly<
  Record<DriverSessionProfile, Partial<Record<string, DriverToolPolicyClass>>>
> = {
  prep: {
    remove_combatant: 'auto',
    end_encounter: 'deny',
    begin_encounter: 'confirm',
    award_xp: 'confirm',
    level_up_character: 'confirm',
    add_note: 'auto',
    adjust_treasury: 'confirm',
    add_inventory_item: 'confirm',
    update_inventory_item: 'confirm',
  },
  live: {
    remove_combatant: 'confirm',
    end_encounter: 'confirm',
    begin_encounter: 'confirm',
    award_xp: 'confirm',
    level_up_character: 'confirm',
    add_note: 'auto',
    adjust_treasury: 'confirm',
    add_inventory_item: 'confirm',
    update_inventory_item: 'confirm',
  },
  aftermath: {
    remove_combatant: 'deny',
    end_encounter: 'deny',
    begin_encounter: 'confirm',
    award_xp: 'auto',
    level_up_character: 'confirm',
    add_note: 'auto',
    adjust_treasury: 'auto',
    add_inventory_item: 'auto',
    update_inventory_item: 'auto',
  },
};

/** Resolve the session profile from encounter presence (#474). */
export function resolveDriverSessionProfile(input: DriverSessionProfileInput): DriverSessionProfile {
  if (input.hasRunningEncounter) return 'live';
  if (input.hasPreparingEncounter) return 'prep';
  if (input.hasEndedEncounter) return 'aftermath';
  return 'prep';
}

/** Whether a tool name matches a forbidden prefix (hard deletes). */
export function isDriverForbiddenToolName(name: string): boolean {
  return DRIVER_FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Campaign-scoped tool policy for the autonomous driver seat (#474).
 * Default-deny for mutating direct writes; proposal-capable canon tools always propose;
 * destructive / irreversible live-play tools require DM confirmation in the active profile.
 */
export function resolveDriverToolPolicy(ctx: DriverToolPolicyContext): DriverToolPolicyDecision {
  const { tool, profile, onLivePlayAllowList } = ctx;
  const undoable = DRIVER_UNDOABLE_TOOLS.has(tool.name);

  if (isDriverForbiddenToolName(tool.name)) {
    return { policy: 'deny', profile, offer: false, reason: 'Hard deletes are never permitted.', undoable: false };
  }

  const override = PROFILE_TOOL_OVERRIDES[profile][tool.name];
  if (override) {
    return {
      policy: override,
      profile,
      offer: override !== 'deny',
      reason: policyReason(override, tool.name, profile),
      undoable,
    };
  }

  if (!tool.mutating) {
    return { policy: 'auto', profile, offer: true, undoable: false };
  }

  if (tool.proposalCapable) {
    return { policy: 'propose', profile, offer: true, reason: 'Canon writes are submitted as proposals.', undoable: false };
  }

  if (onLivePlayAllowList) {
    // #1051 — collaborative handoff promotes mechanical commits to `confirm`. Applied HERE, at
    // the bottom of the chain, so it can only ever tighten: a tool the profile already denies,
    // proposes, or confirms never reaches this branch, and a read never gets here at all.
    if (ctx.collaborative && DRIVER_COLLABORATIVE_DEFER_TOOLS.has(tool.name)) {
      return {
        policy: 'confirm',
        profile,
        offer: true,
        reason: `${tool.name} is a mechanical decision — the table is in collaborative handoff, so a DM confirms it.`,
        undoable,
      };
    }
    return { policy: 'auto', profile, offer: true, undoable };
  }

  return {
    policy: 'deny',
    profile,
    offer: false,
    reason: 'Not on the live-play allow-list.',
    undoable: false,
  };
}

function policyReason(policy: DriverToolPolicyClass, tool: string, profile: DriverSessionProfile): string | undefined {
  if (policy === 'confirm') return `${tool} requires DM confirmation during ${profile} play.`;
  if (policy === 'deny') return `${tool} is not permitted during ${profile} play.`;
  return undefined;
}

/** Per-turn counters reset at the start of each driver turn (#474). */
export interface DriverTurnPolicyCounters {
  generateMapCallsThisTurn?: number;
  confirmToolAttemptsThisTurn?: number;
  policyViolationsThisTurn?: number;
}

/** Reset per-turn policy counters at turn start. */
export function resetDriverTurnPolicyCounters(session: DriverTurnPolicyCounters): void {
  session.generateMapCallsThisTurn = 0;
  session.confirmToolAttemptsThisTurn = 0;
  session.policyViolationsThisTurn = 0;
}

export function noteDriverPolicyViolation(session: DriverTurnPolicyCounters): number {
  const next = (session.policyViolationsThisTurn ?? 0) + 1;
  session.policyViolationsThisTurn = next;
  return next;
}

export function noteDriverConfirmToolAttempt(session: DriverTurnPolicyCounters): number {
  const next = (session.confirmToolAttemptsThisTurn ?? 0) + 1;
  session.confirmToolAttemptsThisTurn = next;
  return next;
}

export type DriverPolicyRateLimitResult =
  | { ok: true }
  | { ok: false; code: string; message: string; emergencyPause: boolean };

/**
 * Rate-limit confirm-policy attempts and aggregate policy violations per turn (#474 / #1051).
 *
 * `collaborative` raises only the CONFIRM cap. The policy-violation ceiling that triggers the
 * emergency pause is untouched on purpose: a model attempting denied tools is misbehaving in
 * every mode, and collaborative handoff is a statement about who decides mechanics, not a
 * relaxation of what the seat may attempt.
 */
export function checkDriverPolicyRateLimits(
  session: DriverTurnPolicyCounters,
  opts?: { collaborative?: boolean },
): DriverPolicyRateLimitResult {
  const violations = session.policyViolationsThisTurn ?? 0;
  if (violations >= DRIVER_POLICY_VIOLATIONS_BEFORE_EMERGENCY_PAUSE) {
    return {
      ok: false,
      code: 'emergency_pause',
      message: `Driver emergency pause: ${violations} policy violations this turn.`,
      emergencyPause: true,
    };
  }
  const confirmCap = opts?.collaborative
    ? DRIVER_COLLABORATIVE_CONFIRM_ATTEMPTS_PER_TURN
    : DRIVER_CONFIRM_TOOL_ATTEMPTS_PER_TURN;
  const confirmAttempts = session.confirmToolAttemptsThisTurn ?? 0;
  if (confirmAttempts >= confirmCap) {
    return {
      ok: false,
      code: 'confirm_tool_rate_limit',
      message: `The driver may queue at most ${confirmCap} confirmation-required tool(s) per turn.`,
      emergencyPause: false,
    };
  }
  return { ok: true };
}

/** Stable key for a pending confirmation (tool + toolCallId). */
export function pendingConfirmationKey(tool: string, toolCallId: string): string {
  return `${tool}:${toolCallId}`;
}
