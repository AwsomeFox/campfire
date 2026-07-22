import { useCallback, useEffect, useState } from 'react';
import type { MembershipIntegrityReport, User } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Btn, Card, EmptyState } from '../../components/ui';

export function MembershipIntegrityCard({ users }: { users: User[] }) {
  const [report, setReport] = useState<MembershipIntegrityReport | null>(null);
  const [targets, setTargets] = useState<Record<number, number>>({});
  const [busyCampaignId, setBusyCampaignId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await api.get<MembershipIntegrityReport>(`${API}/admin/membership-integrity`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load membership integrity diagnostics.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const enabledUsers = users.filter((user) => !user.disabled);

  async function repair(campaignId: number) {
    const userId = targets[campaignId];
    if (!userId) return;
    setBusyCampaignId(campaignId);
    setError(null);
    try {
      await api.post(`${API}/admin/membership-integrity/repair-dm`, { campaignId, userId });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't assign the recovery DM.");
    } finally {
      setBusyCampaignId(null);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="border-b border-slate-700 pb-3">
        <h2 className="font-bold text-white text-sm">Campaign authority integrity</h2>
        <p className="text-[11px] text-slate-400 mt-1">
          Operational metadata only. This does not reveal campaign content or make a server admin a campaign DM.
        </p>
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}
      {!report ? (
        <p className="text-xs text-slate-400">Loading diagnostics…</p>
      ) : report.campaigns.length === 0 ? (
        <EmptyState icon="shield" title="All campaigns have usable DM authority" />
      ) : (
        <div className="space-y-2">
          {report.campaigns.map((campaign) => (
            <div key={campaign.campaignId} className="cf-inset p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-white">{campaign.campaignName}</span>
                <span className={campaign.repairRequired ? 'text-xs text-rose-400' : 'text-xs text-amber-300'}>
                  {campaign.usableDmCount} enabled DM{campaign.usableDmCount === 1 ? '' : 's'}
                </span>
                {campaign.disabledDmUserIds.length > 0 && (
                  <span className="text-xs text-slate-400">{campaign.disabledDmUserIds.length} disabled DM seat(s)</span>
                )}
                {campaign.removedGhostMembershipCount > 0 && (
                  <span className="text-xs text-slate-400">{campaign.removedGhostMembershipCount} ghost row(s) repaired</span>
                )}
              </div>
              {campaign.repairRequired && (
                <div className="flex gap-2 items-center flex-wrap">
                  <select
                    className="cf-select !min-h-0 !py-1 text-xs"
                    aria-label={`Recovery DM for ${campaign.campaignName}`}
                    value={targets[campaign.campaignId] ?? ''}
                    onChange={(event) =>
                      setTargets((current) => ({ ...current, [campaign.campaignId]: Number(event.target.value) }))
                    }
                  >
                    <option value="">Choose an enabled account…</option>
                    {enabledUsers.map((user) => (
                      <option key={user.id} value={user.id}>{user.displayName || user.username}</option>
                    ))}
                  </select>
                  <Btn
                    type="button"
                    className="!min-h-0 !py-1.5 text-xs"
                    disabled={!targets[campaign.campaignId] || busyCampaignId === campaign.campaignId}
                    onClick={() => void repair(campaign.campaignId)}
                  >
                    {busyCampaignId === campaign.campaignId ? 'Assigning…' : 'Assign recovery DM'}
                  </Btn>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {report && report.repairs.length > 0 && (
        <p className="text-[11px] text-slate-500">
          Migration repair history: {report.repairs.length} row{report.repairs.length === 1 ? '' : 's'} recorded.
        </p>
      )}
    </Card>
  );
}
