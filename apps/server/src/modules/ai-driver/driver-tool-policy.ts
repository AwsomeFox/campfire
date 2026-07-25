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

/** Rate-limit confirm-policy attempts and aggregate policy violations per turn (#474). */
export function checkDriverPolicyRateLimits(session: DriverTurnPolicyCounters): DriverPolicyRateLimitResult {
  const violations = session.policyViolationsThisTurn ?? 0;
  if (violations >= DRIVER_POLICY_VIOLATIONS_BEFORE_EMERGENCY_PAUSE) {
    return {
      ok: false,
      code: 'emergency_pause',
      message: `Driver emergency pause: ${violations} policy violations this turn.`,
      emergencyPause: true,
    };
  }
  const confirmAttempts = session.confirmToolAttemptsThisTurn ?? 0;
  if (confirmAttempts >= DRIVER_CONFIRM_TOOL_ATTEMPTS_PER_TURN) {
    return {
      ok: false,
      code: 'confirm_tool_rate_limit',
      message: `The driver may queue at most ${DRIVER_CONFIRM_TOOL_ATTEMPTS_PER_TURN} confirmation-required tool(s) per turn.`,
      emergencyPause: false,
    };
  }
  return { ok: true };
}

/** Stable key for a pending confirmation (tool + toolCallId). */
export function pendingConfirmationKey(tool: string, toolCallId: string): string {
  return `${tool}:${toolCallId}`;
}
