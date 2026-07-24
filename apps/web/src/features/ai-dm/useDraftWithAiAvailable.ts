/**
 * Whether the current user can see a "Draft with AI" entry for this campaign
 * (DM + seat enabled). Shared by DraftWithAiButton and PageHeader secondary
 * overflow items (issue #707) so pages don't mount a second trigger.
 */
import { useCampaignAccessFor } from '../../app/CampaignAccessContext';
import { useAiDmSeat } from '../../lib/query';

export function useDraftWithAiAvailable(campaignId: number): boolean {
  const { canDmWrite } = useCampaignAccessFor(campaignId);
  const { data: seat } = useAiDmSeat(canDmWrite ? campaignId : undefined);
  return Boolean(canDmWrite && seat && seat.mode !== 'off' && seat.enabled);
}
