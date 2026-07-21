/**
 * Shared AI-DM gate-error taxonomy (issue #343).
 *
 * Every AI surface (the Table page, the co-DM draft buttons, the scribe panel) hits the
 * same server gates, and the server rejects a blocked action with a plain 403/409 whose
 * message is descriptive but not something you'd show a player. Rather than each caller
 * re-deriving "what does THIS error mean and where do I fix it", they classify the error
 * here once and render a friendly explainer + the right deep link.
 *
 * The server (apps/server/src/modules/ai-dm) throws stable English messages with no
 * machine code, so we match on message substrings. The mapping is intentionally
 * conservative: an unrecognized error stays `unknown` and callers fall back to the raw
 * message (via translateApiError) rather than mislabelling it.
 */
import { ApiError } from '../../lib/api';

/** The known reasons an AI action is blocked, plus `unknown` for anything unmapped. */
export type AiGateKind =
  | 'flagDisabled' // server-wide experimental flag is off — admin fixes
  | 'seatDisabled' // per-campaign seat off / mode not chosen — DM fixes
  | 'budgetExhausted' // per-campaign token budget spent — DM fixes
  | 'serverCap' // server-wide token cap reached — admin fixes
  | 'needBudget' // switching to Driver without a budget — DM fixes
  | 'needProvider' // switching to Driver without a provider — DM fixes
  | 'paused' // session paused (a state, not an error) — DM resumes
  | 'humanControl' // a human took the seat — hand back to resume
  | 'unknown';

/** Who can clear the gate — drives the "Needs …" attribution and which surface to link. */
export type AiGateActor = 'admin' | 'dm' | 'table';

export interface AiGateInfo {
  kind: AiGateKind;
  actor: AiGateActor;
  /** i18n key under `aiOnboarding.gate.<kind>` for a short title. */
  titleKey: string;
  /** i18n key under `aiOnboarding.gate.<kind>` for the one-line explainer. */
  bodyKey: string;
  /**
   * Deep link to the exact control that clears this gate, or null when the resolution
   * isn't a place the current user can navigate to (e.g. a non-admin facing `flagDisabled`).
   * Takes the campaignId because DM-side fixes live under `/c/:id/settings`.
   */
  to: ((campaignId: number) => string) | null;
}

/** Case-insensitive substring test kept tiny so the matcher below reads as a table. */
function has(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Classify an AI gate error (or a known session state string) into a friendly descriptor.
 * Pass an {@link ApiError} from a rejected AI call, or one of the session `state` values
 * (`'paused'` / `'human_control'`) to reuse the same explainer copy for those states.
 */
export function classifyAiGate(err: unknown): AiGateInfo {
  // Session states reuse the taxonomy so a paused/human-control banner reads consistently.
  if (err === 'paused') return GATE.paused;
  if (err === 'human_control') return GATE.humanControl;

  if (err instanceof ApiError) {
    const m = err.message ?? '';
    if (has(m, 'experimental') && has(m, 'disabled')) return GATE.flagDisabled;
    if (has(m, 'seat is not enabled')) return GATE.seatDisabled;
    if (has(m, 'budget exhausted')) return GATE.budgetExhausted;
    if (has(m, 'server-wide ai token cap')) return GATE.serverCap;
    if (has(m, 'requires a positive token budget')) return GATE.needBudget;
    if (has(m, 'requires a configured ai provider')) return GATE.needProvider;
  }
  return GATE.unknown;
}

/** True when the error is a recognised AI gate (i.e. worth showing the mapped explainer). */
export function isKnownAiGate(err: unknown): boolean {
  return classifyAiGate(err).kind !== 'unknown';
}

const SETTINGS = (anchor: string) => (campaignId: number) => `/c/${campaignId}/settings#${anchor}`;
const ADMIN_AI = () => '/admin/ai';

/** The descriptor table. Deep links target routes that exist in app/router.tsx. */
const GATE: Record<AiGateKind, AiGateInfo> = {
  flagDisabled: { kind: 'flagDisabled', actor: 'admin', titleKey: 'aiOnboarding.gate.flagDisabled.title', bodyKey: 'aiOnboarding.gate.flagDisabled.body', to: ADMIN_AI },
  serverCap: { kind: 'serverCap', actor: 'admin', titleKey: 'aiOnboarding.gate.serverCap.title', bodyKey: 'aiOnboarding.gate.serverCap.body', to: ADMIN_AI },
  seatDisabled: { kind: 'seatDisabled', actor: 'dm', titleKey: 'aiOnboarding.gate.seatDisabled.title', bodyKey: 'aiOnboarding.gate.seatDisabled.body', to: SETTINGS('ai-dm-mode') },
  budgetExhausted: { kind: 'budgetExhausted', actor: 'dm', titleKey: 'aiOnboarding.gate.budgetExhausted.title', bodyKey: 'aiOnboarding.gate.budgetExhausted.body', to: SETTINGS('ai-dm-budget') },
  needBudget: { kind: 'needBudget', actor: 'dm', titleKey: 'aiOnboarding.gate.needBudget.title', bodyKey: 'aiOnboarding.gate.needBudget.body', to: SETTINGS('ai-dm-budget') },
  needProvider: { kind: 'needProvider', actor: 'dm', titleKey: 'aiOnboarding.gate.needProvider.title', bodyKey: 'aiOnboarding.gate.needProvider.body', to: SETTINGS('ai-dm-provider') },
  paused: { kind: 'paused', actor: 'dm', titleKey: 'aiOnboarding.gate.paused.title', bodyKey: 'aiOnboarding.gate.paused.body', to: null },
  humanControl: { kind: 'humanControl', actor: 'table', titleKey: 'aiOnboarding.gate.humanControl.title', bodyKey: 'aiOnboarding.gate.humanControl.body', to: null },
  unknown: { kind: 'unknown', actor: 'dm', titleKey: 'aiOnboarding.gate.seatDisabled.title', bodyKey: 'aiOnboarding.gate.seatDisabled.body', to: null },
};
