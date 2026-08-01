import { CampaignEvent as CampaignEventSchema, type CampaignEvent } from '@campfire/schema';

export function parseAiDmStreamEvent(raw: unknown): CampaignEvent | null {
  const result = CampaignEventSchema.safeParse(raw);
  if (!result.success) return null;
  const v = result.data as any;
  if (v.type === 'narration.withheld') {
    const reason = v.reason === 'refusal' ? 'refusal' : 'content_filter';
    return { ...v, reason } as CampaignEvent;
  }
  return result.data as CampaignEvent;
}
