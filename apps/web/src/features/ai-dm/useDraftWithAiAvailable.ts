/**
 * Whether the current user can see a "Draft with AI" entry for this campaign
 * (DM + seat enabled). Shared by DraftWithAiButton and PageHeader secondary
 * overflow items (issue #707) so pages don't mount a second trigger.
 */
import { useAuth } from '../../app/auth';
import { useAiDmSeat } from '../../lib/query';

export function useDraftWithAiAvailable(campaignId: number): boolean {
  const { roleIn } = useAuth();
  const isDm = roleIn(campaignId) === 'dm';
  const { data: seat } = useAiDmSeat(isDm ? campaignId : undefined);
  return Boolean(isDm && seat && seat.mode !== 'off' && seat.enabled);
}
