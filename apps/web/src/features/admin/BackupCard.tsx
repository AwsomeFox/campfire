/**
 * Backup & export card — extracted from AdminPage.tsx as part of the /admin/*
 * page split (issue #350). Lives on /admin/storage, alongside StorageCard.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Campaign } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, ErrorNote } from '../../components/ui';

const CAMPAIGN_SELECT_ID = 'backup-campaign';
const JSON_DESCRIPTION_ID = 'backup-json-description';
const MARKDOWN_DESCRIPTION_ID = 'backup-markdown-description';
const PRIVACY_DESCRIPTION_ID = 'backup-privacy-description';

export function BackupCard() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadCampaigns = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const list = await api.get<Campaign[]>(`${API}/campaigns`);
      setCampaigns(list);
      setCampaignId((currentId) =>
        list.some((campaign) => String(campaign.id) === currentId) ? currentId : String(list[0]?.id ?? ''),
      );
    } catch (err) {
      setCampaigns([]);
      setCampaignId('');
      setError(err instanceof ApiError ? err.message : "Couldn't load campaigns.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

  const selectedCampaign = campaigns.find((campaign) => String(campaign.id) === campaignId);
  const canExport = Boolean(selectedCampaign) && !isLoading && !error;
  const unavailableReason = isLoading
    ? 'campaigns are loading'
    : error
      ? 'campaigns could not be loaded'
      : 'no campaign is available';

  return (
    <Card className="backup-export-card space-y-3">
      <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Backup &amp; export</h2>
      <p className="text-xs text-slate-400">Take everything with you — no lock-in.</p>
      <label className="block text-xs font-semibold text-slate-300" htmlFor={CAMPAIGN_SELECT_ID}>
        Campaign to export
      </label>
      {isLoading && (
        <p role="status" className="text-xs text-slate-400">
          Loading campaigns…
        </p>
      )}
      {error && <ErrorNote message={error} onRetry={() => void loadCampaigns()} />}
      <select
        id={CAMPAIGN_SELECT_ID}
        className="cf-select !min-h-0 !py-2 text-sm"
        value={campaignId}
        onChange={(e) => setCampaignId(e.target.value)}
        disabled={isLoading || Boolean(error) || campaigns.length === 0}
        aria-describedby={PRIVACY_DESCRIPTION_ID}
      >
        {isLoading ? (
          <option value="">Loading campaigns…</option>
        ) : error ? (
          <option value="">Campaigns unavailable</option>
        ) : campaigns.length === 0 ? (
          <option value="">No campaigns available</option>
        ) : (
          campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))
        )}
      </select>
      <div className="flex flex-col gap-2 sm:flex-row" role="group" aria-label="Campaign export downloads">
        <a
          className={`cf-btn cf-btn-ghost !min-h-0 !py-2 text-xs sm:w-auto ${!canExport ? 'pointer-events-none opacity-50' : ''}`}
          href={canExport ? `${API}/campaigns/${campaignId}/export?format=json` : undefined}
          role="link"
          aria-disabled={canExport ? undefined : true}
          tabIndex={canExport ? undefined : -1}
          aria-label={
            selectedCampaign
              ? `Download ${selectedCampaign.name} as a JSON export`
              : `JSON export unavailable: ${unavailableReason}`
          }
          aria-describedby={`${JSON_DESCRIPTION_ID} ${PRIVACY_DESCRIPTION_ID}`}
        >
          ⬇ JSON export
        </a>
        <a
          className={`cf-btn cf-btn-ghost !min-h-0 !py-2 text-xs sm:w-auto ${!canExport ? 'pointer-events-none opacity-50' : ''}`}
          href={canExport ? `${API}/campaigns/${campaignId}/export?format=mdzip` : undefined}
          role="link"
          aria-disabled={canExport ? undefined : true}
          tabIndex={canExport ? undefined : -1}
          aria-label={
            selectedCampaign
              ? `Download ${selectedCampaign.name} as a Markdown zip`
              : `Markdown zip unavailable: ${unavailableReason}`
          }
          aria-describedby={`${MARKDOWN_DESCRIPTION_ID} ${PRIVACY_DESCRIPTION_ID}`}
        >
          ⬇ Markdown zip
        </a>
      </div>
      <div className="space-y-1 text-[11px] text-slate-400">
        <p id={JSON_DESCRIPTION_ID}><strong>JSON:</strong> A complete, machine-readable campaign export.</p>
        <p id={MARKDOWN_DESCRIPTION_ID}><strong>Markdown zip:</strong> Readable Markdown files in a zip archive.</p>
        <p id={PRIVACY_DESCRIPTION_ID}>Exports include DM-only campaign data. Keep downloaded files private.</p>
      </div>
    </Card>
  );
}
