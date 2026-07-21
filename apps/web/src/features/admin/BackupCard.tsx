/**
 * Backup & export card — extracted from AdminPage.tsx as part of the /admin/*
 * page split (issue #350). Lives on /admin/storage, alongside StorageCard.
 */
import { useEffect, useState } from 'react';
import type { Campaign } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card } from '../../components/ui';

export function BackupCard() {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [campaignId, setCampaignId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const list = await api.get<Campaign[]>(`${API}/campaigns`);
        setCampaigns(list);
        if (list.length > 0) setCampaignId(String(list[0].id));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Couldn't load campaigns.");
      }
    })();
  }, []);

  const canExport = Boolean(campaignId);

  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Backup &amp; export</h2>
      <p className="text-xs text-slate-400">Take everything with you — no lock-in.</p>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      <select
        className="cf-select !min-h-0 !py-2 text-sm"
        value={campaignId}
        onChange={(e) => setCampaignId(e.target.value)}
        disabled={!campaigns || campaigns.length === 0}
      >
        {(campaigns ?? []).length === 0 ? (
          <option value="">No campaigns</option>
        ) : (
          campaigns!.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))
        )}
      </select>
      <div className="flex gap-2">
        <a
          className={`cf-btn cf-btn-ghost !min-h-0 !py-2 text-xs ${!canExport ? 'pointer-events-none opacity-50' : ''}`}
          href={canExport ? `${API}/campaigns/${campaignId}/export?format=json` : undefined}
        >
          ⬇ JSON export
        </a>
        <a
          className={`cf-btn cf-btn-ghost !min-h-0 !py-2 text-xs ${!canExport ? 'pointer-events-none opacity-50' : ''}`}
          href={canExport ? `${API}/campaigns/${campaignId}/export?format=mdzip` : undefined}
        >
          ⬇ Markdown zip
        </a>
      </div>
      <p className="text-[11px] text-slate-600">DM-only per campaign.</p>
    </Card>
  );
}
