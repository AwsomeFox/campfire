/**
 * Compact dice widget for the dashboard — the encounter dice log
 * (RunSessionPage's DiceLog) is the only place players ever saw a roller,
 * so out-of-combat rolls (checks, saves, loot) were invisible. Same
 * POST /campaigns/:id/roll endpoint, trimmed down to fit a dashboard card.
 *
 * Now a thin wrapper over the campaign-shared dice log (issue #35) — rolls
 * are persisted server-side and every member sees the same feed.
 */
import { SharedDiceLog } from '../dice/SharedDiceLog';

export function DiceWidget({ campaignId }: { campaignId: number }) {
  return <SharedDiceLog campaignId={campaignId} compact />;
}
