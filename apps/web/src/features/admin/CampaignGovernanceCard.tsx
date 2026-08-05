/**
 * Shared-instance governance (issue #851): who may create/import a campaign,
 * per-user/server-wide campaign ceilings, and the operator default storage
 * quota new campaigns inherit — plus the pending creation-request queue.
 * Mirrors SettingsCard.tsx's structure (same admin surface, same patch pattern).
 */
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useState } from 'react';
import type { CampaignCreationPolicy, CampaignCreationRequest, ServerSettings } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { Btn, Card, Skeleton } from '../../components/ui';

/** Blank = unlimited (stored as null). */
function limitToInput(value: number | null): string {
  return value == null ? '' : String(value);
}
function inputToLimit(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

const BYTES_PER_MB = 1024 * 1024;
function bytesToMbInput(value: number | null): string {
  return value == null ? '' : String(Math.round(value / BYTES_PER_MB));
}
function mbInputToBytes(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * BYTES_PER_MB) : null;
}

export function CampaignGovernanceCard({ settings, onChange }: { settings: ServerSettings | null; onChange: () => void }) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [policy, setPolicy] = useState<CampaignCreationPolicy>(settings?.campaignCreationPolicy ?? 'everyone');
  const [maxActivePerUser, setMaxActivePerUser] = useState(limitToInput(settings?.maxActiveCampaignsPerUser ?? null));
  const [maxTotalPerUser, setMaxTotalPerUser] = useState(limitToInput(settings?.maxTotalCampaignsPerUser ?? null));
  const [maxActiveServerWide, setMaxActiveServerWide] = useState(limitToInput(settings?.maxActiveCampaignsServerWide ?? null));
  const [maxTotalServerWide, setMaxTotalServerWide] = useState(limitToInput(settings?.maxTotalCampaignsServerWide ?? null));
  const [defaultQuotaMb, setDefaultQuotaMb] = useState(bytesToMbInput(settings?.defaultCampaignStorageQuotaBytes ?? null));

  useEffect(() => {
    if (!settings) return;
    setPolicy(settings.campaignCreationPolicy);
    setMaxActivePerUser(limitToInput(settings.maxActiveCampaignsPerUser));
    setMaxTotalPerUser(limitToInput(settings.maxTotalCampaignsPerUser));
    setMaxActiveServerWide(limitToInput(settings.maxActiveCampaignsServerWide));
    setMaxTotalServerWide(limitToInput(settings.maxTotalCampaignsServerWide));
    setDefaultQuotaMb(bytesToMbInput(settings.defaultCampaignStorageQuotaBytes));
  }, [settings]);

  const [requests, setRequests] = useState<CampaignCreationRequest[] | null>(null);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<number | null>(null);

  const loadRequests = useCallback(async () => {
    try {
      const rows = await api.get<CampaignCreationRequest[]>(`${API}/campaigns/creation-requests`);
      setRequests(rows);
    } catch (err) {
      setRequestsError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    }
  }, [t]);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`${API}/settings`, {
        campaignCreationPolicy: policy,
        maxActiveCampaignsPerUser: inputToLimit(maxActivePerUser),
        maxTotalCampaignsPerUser: inputToLimit(maxTotalPerUser),
        maxActiveCampaignsServerWide: inputToLimit(maxActiveServerWide),
        maxTotalCampaignsServerWide: inputToLimit(maxTotalServerWide),
        defaultCampaignStorageQuotaBytes: mbInputToBytes(defaultQuotaMb),
      });
      onChange();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    } finally {
      setSaving(false);
    }
  }

  async function decide(id: number, decision: 'approve' | 'deny') {
    setDecidingId(id);
    setRequestsError(null);
    try {
      await api.post(`${API}/campaigns/creation-requests/${id}/${decision}`, {});
      await loadRequests();
      onChange();
    } catch (err) {
      setRequestsError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    } finally {
      setDecidingId(null);
    }
  }

  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Campaign creation &amp; storage governance</h2>
      <p className="text-[11px] text-secondary">
        Controls who may create or import a campaign, how many campaigns a user (or the whole server) may hold at once,
        and the default upload quota a brand-new campaign starts with. Changing these never affects an existing
        campaign's own storage quota.
      </p>
      {error && <p className="text-xs text-rose-400">{error}</p>}

      <div className="cf-inset p-3.5 space-y-3">
        <div className="field">
          <label htmlFor="campaign-creation-policy" className="text-sm font-semibold text-white">
            Who may create or import a campaign
          </label>
          <select
            id="campaign-creation-policy"
            className="cf-select text-sm cf-density-compact"
            value={policy}
            onChange={(e) => setPolicy(e.target.value as CampaignCreationPolicy)}
            disabled={!settings || saving}
          >
            <option value="everyone">Everyone (any authenticated user)</option>
            <option value="approved_organizers">Approved organizers only (plus server admins)</option>
            <option value="admins_only">Server admins only</option>
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="field">
            <label htmlFor="max-active-per-user" className="text-xs text-slate-300">
              Max active campaigns per user (blank = unlimited)
            </label>
            <input
              id="max-active-per-user"
              type="number"
              min={1}
              className="cf-input text-sm cf-density-compact"
              value={maxActivePerUser}
              onChange={(e) => setMaxActivePerUser(e.target.value)}
              disabled={!settings || saving}
            />
          </div>
          <div className="field">
            <label htmlFor="max-total-per-user" className="text-xs text-slate-300">
              Max total campaigns per user (blank = unlimited)
            </label>
            <input
              id="max-total-per-user"
              type="number"
              min={1}
              className="cf-input text-sm cf-density-compact"
              value={maxTotalPerUser}
              onChange={(e) => setMaxTotalPerUser(e.target.value)}
              disabled={!settings || saving}
            />
          </div>
          <div className="field">
            <label htmlFor="max-active-server" className="text-xs text-slate-300">
              Max active campaigns server-wide (blank = unlimited)
            </label>
            <input
              id="max-active-server"
              type="number"
              min={1}
              className="cf-input text-sm cf-density-compact"
              value={maxActiveServerWide}
              onChange={(e) => setMaxActiveServerWide(e.target.value)}
              disabled={!settings || saving}
            />
          </div>
          <div className="field">
            <label htmlFor="max-total-server" className="text-xs text-slate-300">
              Max total campaigns server-wide (blank = unlimited)
            </label>
            <input
              id="max-total-server"
              type="number"
              min={1}
              className="cf-input text-sm cf-density-compact"
              value={maxTotalServerWide}
              onChange={(e) => setMaxTotalServerWide(e.target.value)}
              disabled={!settings || saving}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="default-quota-mb" className="text-xs text-slate-300">
            Default storage quota for new campaigns, in MB (blank = unlimited)
          </label>
          <input
            id="default-quota-mb"
            type="number"
            min={0}
            className="cf-input text-sm cf-density-compact"
            value={defaultQuotaMb}
            onChange={(e) => setDefaultQuotaMb(e.target.value)}
            disabled={!settings || saving}
          />
        </div>

        <div className="flex justify-end">
          <Btn density="compact" className="text-xs" onClick={() => void save()} disabled={!settings || saving}>
            {saving ? 'Saving…' : 'Save governance settings'}
          </Btn>
        </div>
      </div>

      <div className="cf-inset p-3.5 space-y-2">
        <h3 className="text-sm font-semibold text-white">Pending campaign-creation requests</h3>
        {requestsError && <p className="text-xs text-rose-400">{requestsError}</p>}
        {requests === null && !requestsError && <Skeleton lines={2} />}
        {requests !== null && requests.length === 0 && (
          <p className="text-[11px] text-secondary">No pending requests.</p>
        )}
        {requests !== null && requests.length > 0 && (
          <ul className="space-y-2">
            {requests.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 flex-wrap text-sm text-slate-300">
                <span style={{ overflowWrap: 'anywhere' }}>
                  {r.displayName || r.username} ({r.username}){r.note ? ` — "${r.note}"` : ''}
                </span>
                <span className="flex gap-2">
                  <Btn
                    density="compact"
                    className="text-xs"
                    onClick={() => void decide(r.id, 'approve')}
                    disabled={decidingId === r.id}
                  >
                    Approve
                  </Btn>
                  <Btn
                    density="compact"
                    className="text-xs"
                    onClick={() => void decide(r.id, 'deny')}
                    disabled={decidingId === r.id}
                  >
                    Deny
                  </Btn>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
