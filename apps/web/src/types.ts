export type CampaignStatus = string;

export interface Campaign {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  dangerLevel: string | number | null;
  sessionCount: number;
  createdAt: string;
}

export interface HealthResponse {
  ok: boolean;
  version?: string;
  [key: string]: unknown;
}
