import type { Role } from '@campfire/schema';

/**
 * Safe resource identity for an AI-DM `tool` stream event (#825).
 *
 * Derived server-side from validated tool arguments / results — never from
 * model-authored narration. `encounterHidden` is an INTERNAL projection hint:
 * {@link projectAiDmToolEventForRole} strips it from the wire and omits
 * `encounterId` for non-DM subscribers when the encounter is DM-only prep.
 */
export interface ToolResourceIdentity {
  encounterId?: number;
  encounterHidden?: boolean;
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function tryParseJsonObject(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Extract encounter resource identity from a tool call's args and/or result text.
 * Pure — no DB. Callers that need authoritative `hidden` should resolve the row
 * when `encounterId` is present but `encounterHidden` is unknown.
 */
export function extractToolResourceIdentity(
  toolName: string,
  args: Record<string, unknown>,
  resultText: string | undefined,
  isError: boolean,
): ToolResourceIdentity {
  const argEncounterId = asPositiveInt(args.encounterId);
  const result = !isError ? tryParseJsonObject(resultText) : null;

  // create_encounter returns the new row; identity lives on the result, not args.
  if (toolName === 'create_encounter') {
    const id = asPositiveInt(result?.id);
    if (id === undefined) return {};
    const hidden =
      typeof result?.hidden === 'boolean'
        ? result.hidden
        : typeof args.hidden === 'boolean'
          ? args.hidden
          : undefined;
    return hidden === undefined ? { encounterId: id } : { encounterId: id, encounterHidden: hidden };
  }

  if (argEncounterId === undefined) return {};

  let hidden: boolean | undefined;
  if (typeof result?.hidden === 'boolean') {
    hidden = result.hidden;
  } else if (toolName === 'update_encounter' && typeof args.hidden === 'boolean') {
    // A reveal/hide write: the arg is the post-update visibility the DM just set.
    hidden = args.hidden;
  }

  return hidden === undefined
    ? { encounterId: argEncounterId }
    : { encounterId: argEncounterId, encounterHidden: hidden };
}

/** Wire shape of a `tool` event after role projection (no internal hidden flag). */
export type AiDmToolStreamWireEvent = {
  type: 'tool';
  campaignId: number;
  name: string;
  isError: boolean;
  proposed: boolean;
  encounterId?: number;
  at: string;
};

/**
 * Project a tool stream event for a subscriber's role (#825 / #262):
 * non-DMs must not receive the id of a hidden (DM-prep) encounter.
 * The internal `encounterHidden` flag never leaves the server.
 */
export function projectAiDmToolEventForRole(
  event: {
    type: 'tool';
    campaignId: number;
    name: string;
    isError: boolean;
    proposed: boolean;
    encounterId?: number;
    encounterHidden?: boolean;
    at: string;
  },
  role: Role,
): AiDmToolStreamWireEvent {
  const { encounterHidden, encounterId, ...rest } = event;
  const reveal =
    encounterId !== undefined && (role === 'dm' || encounterHidden !== true);
  return reveal ? { ...rest, encounterId } : { ...rest };
}
