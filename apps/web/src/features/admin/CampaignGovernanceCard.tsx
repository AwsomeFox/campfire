/**
 * Shared-instance governance (issue #851): who may create/import a campaign,
 * per-user/server-wide campaign ceilings, and the operator default storage
 * quota new campaigns inherit — plus the pending creation-request queue.
 * Mirrors SettingsCard.tsx's structure (same admin surface, same patch pattern).
 */
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CampaignCreationPolicy, CampaignCreationRequest, ServerSettings } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { Btn, Card, Skeleton } from '../../components/ui';

/** Blank = unlimited (stored as null). */
function limitToInput(value: number | null): string {
  return value == null ? '' : String(value);
}
/**
 * `null` = unlimited, `INVALID` = refuse to save (issue #851 review).
 *
 * These two used to collapse together: anything non-numeric, zero, or negative returned
 * `null`, and `null` is the wire value for "no limit". An admin tightening a cap who typed
 * `0` — which `type="number"` with `min={1}` does not stop them typing — silently turned the
 * cap OFF and saw a blank box afterwards, believing it was still enforced. Only a genuinely
 * empty field may mean unlimited.
 */
const INVALID = Symbol('invalid');
function inputToLimit(value: string): number | null | typeof INVALID {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : INVALID;
}

const BYTES_PER_MB = 1024 * 1024;
function bytesToMbInput(value: number | null): string {
  return value == null ? '' : String(Math.round(value / BYTES_PER_MB));
}
function mbInputToBytes(value: string): number | null | typeof INVALID {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  // `0` is REFUSED, not accepted (review). Only `null` means unlimited to the server:
  // AttachmentsService enforces any non-null quota, so a saved 0 is a real zero-byte
  // allowance and every campaign created afterwards rejects every map, portrait and handout.
  // The box is labelled "blank = unlimited", so an admin typing 0 to mean "no cap" would get
  // the exact opposite. Same contract as the limit fields above: blank for unlimited,
  // anything else must be a usable number.
  return Number.isFinite(n) && n > 0 ? Math.round(n * BYTES_PER_MB) : INVALID;
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

  /**
   * Re-seed the form only when the STORED values actually change (review).
   *
   * This effect keys on the `settings` PROP, and AdminUsersPage.load() hands down a brand-new
   * object on every reload — including the one decide() triggers after approving or denying a
   * request. So an admin who typed new limits and then actioned a pending request on this same
   * card watched their unsaved edits silently revert.
   *
   * Not calling onChange() from decide() would be the smaller change, but it is wrong here:
   * load() refetches users AS WELL AS settings, and approving a request flips that user's
   * canCreateCampaigns, so the "Approved organizer" toggle on their row would go stale.
   *
   * Comparing values rather than object identity keeps both behaviors — a reload that returns
   * identical settings is inert, and a genuine external change still re-seeds.
   */
  const seededRef = useRef<string | null>(null);
  useEffect(() => {
    if (!settings) return;
    const stored = JSON.stringify([
      settings.campaignCreationPolicy,
      settings.maxActiveCampaignsPerUser,
      settings.maxTotalCampaignsPerUser,
      settings.maxActiveCampaignsServerWide,
      settings.maxTotalCampaignsServerWide,
      settings.defaultCampaignStorageQuotaBytes,
    ]);
    if (seededRef.current === stored) return;
    seededRef.current = stored;
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
      // A success clears the previous failure (review). Without this, a transient 5xx on
      // first load leaves the banner up forever: every later successful reload — a decision
      // on another row, a remount — renders a good queue under a "could not load" warning,
      // which is worse than no message, because the admin distrusts the list they are acting on.
      setRequestsError(null);
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
      const patch = {
        campaignCreationPolicy: policy,
        maxActiveCampaignsPerUser: inputToLimit(maxActivePerUser),
        maxTotalCampaignsPerUser: inputToLimit(maxTotalPerUser),
        maxActiveCampaignsServerWide: inputToLimit(maxActiveServerWide),
        maxTotalCampaignsServerWide: inputToLimit(maxTotalServerWide),
        // An UNTOUCHED box must send back exactly what was stored (review). The display
        // rounds bytes to whole MB, and save() always patches every field, so a quota
        // configured precisely over the API or MCP — 5,000,000 bytes, say — rendered as "5"
        // and would have been rewritten to 5,242,880 the first time an admin saved an
        // unrelated setting on this card. Comparing against the rendered form of the stored
        // value is what makes "unchanged" mean unchanged rather than "round-trips to itself".
        defaultCampaignStorageQuotaBytes:
          defaultQuotaMb === bytesToMbInput(settings?.defaultCampaignStorageQuotaBytes ?? null)
            ? (settings?.defaultCampaignStorageQuotaBytes ?? null)
            : mbInputToBytes(defaultQuotaMb),
      };
      // Refuse the whole save rather than sending a limit the admin did not ask for. Nothing
      // partial: a governance setting must never move because a neighbouring box was mistyped.
      if (Object.values(patch).some((v) => v === INVALID)) {
        setError('Enter a whole number of 1 or more, or leave a box empty for no limit. Nothing was saved.');
        return;
      }
      await api.patch(`${API}/settings`, patch);
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
            min={1}
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
        {/*
          Approving grants organizer eligibility, which only the 'approved_organizers' policy
          consults — assertPolicyAllowed refuses every non-admin under 'admins_only' without
          reading the flag at all (review). The grant is not lost: it applies the moment the
          policy is loosened. But an admin approving a row under 'admins_only' would otherwise
          see it vanish from the queue while the requester stayed blocked, with nothing said.
          HomePage already declines to offer the request path under 'admins_only', so this is
          reachable mainly through a queue left over from tightening the policy.
        */}
        {settings?.campaignCreationPolicy === 'admins_only' && requests !== null && requests.length > 0 && (
          <p className="text-[11px] text-amber-400">
            The policy is currently &ldquo;Only server admins&rdquo;, which ignores organizer eligibility. Approving
            still records the grant, but it takes effect only if you switch the policy to &ldquo;Approved
            organizers&rdquo;.
          </p>
        )}
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
