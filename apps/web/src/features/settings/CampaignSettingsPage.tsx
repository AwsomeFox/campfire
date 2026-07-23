/**
 * Campaign settings — /c/:campaignId/settings, dm-only.
 * Mirrors design/claude-design/Campfire.dc.html "Campaign settings" (~1560+):
 * General card (name/description/danger — existing PATCH), Rule system card
 * (current pack + change via select of installed packs, Manage packs link for
 * server admins), Danger zone (delete campaign, type-name-to-confirm). The
 * design's Tokens/Audit tabs are already served by TokensCard (admin/tokens
 * pages) and MembersPage's audit list — out of scope here to avoid duplicating
 * owned surfaces; this page covers the General + Rule system + Danger tab.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Campaign, CampaignCloneMode, CampaignInvite, DangerLevel, RulePack } from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { adminRulesHref } from '../../lib/adminNavigation';
import { useCampaigns } from '../../app/CampaignContext';
import { Card, ErrorNote, Skeleton } from '../../components/ui';
import { CampaignMetadataFields, isCampaignMetadataDirty } from '../../components/CampaignMetadataFields';
import { mechanicsForPackSlug, ruleSystemAdapterLabel } from '../../lib/rules';
import { decodeLocationHashId } from '../../lib/decodeLocationHashId';
import { scrollBehavior } from '../../lib/prefersReducedMotion';
import AiDmCard from './AiDmCard';
import { GameIcon } from '../../components/GameIcon';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useAnnounce } from '../../components/Announcer';
import {
  confirmOpen,
  initialStatusConfirmState,
  isArchivingTransition,
  reduceStatusConfirm,
  undoArmed,
  type CampaignStatus,
  type StatusConfirmSnapshot,
} from './statusConfirmState';
import {
  assertMutationTarget,
  decideRouteBoundCommit,
  mutationsEnabledForRoute,
  RouteBoundLoadSequencer,
} from '../../lib/routeBoundRecord';
import { useUnsavedWork } from '../../lib/useUnsavedWork';

export default function CampaignSettingsPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const { roleIn, isAdmin } = useAuth();
  const role = roleIn(id);
  const isDm = role === 'dm';
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh: refreshCampaigns } = useCampaigns();

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Issue #853: campaign switch must not leave prior settings/forms painted against
  // the new route id (child cards key off campaign.id; sequencer drops stale commits).
  const loadSequencerRef = useRef(new RouteBoundLoadSequencer());

  const load = async () => {
    const { generation, signal } = loadSequencerRef.current.begin(id);
    setLoading(true);
    setError(null);
    setCampaign(null);
    try {
      const data = await api.get<Campaign>(`${API}/campaigns/${id}`, { signal });
      const decision = decideRouteBoundCommit(loadSequencerRef.current, generation, id, data);
      if (decision.kind !== 'commit') return;
      setCampaign(decision.record);
    } catch (err) {
      if (!loadSequencerRef.current.isCurrent(generation, id)) return;
      setCampaign(null);
      if ((err as { name?: string } | undefined)?.name === 'AbortError') return;
      setError(err instanceof ApiError ? err.message : "Couldn't load campaign settings.");
    } finally {
      if (loadSequencerRef.current.isCurrent(generation, id)) setLoading(false);
    }
  };

  useEffect(() => {
    if (!Number.isFinite(id) || !role) return;
    void load();
    const sequencer = loadSequencerRef.current;
    return () => sequencer.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, role]);

  const settingsReady = mutationsEnabledForRoute(campaign, id, loading);

  // Deep-link support (#343 / #751): the AI-DM onboarding checklist links to specific
  // controls by hash (e.g. #ai-dm-provider, #ai-dm-budget). React Router doesn't
  // auto-scroll to a hash, and the target may appear only after AiDmCard finishes its
  // own async seat load — retry on a short interval until the anchor exists (or 10s).
  useEffect(() => {
    if (!campaign?.id || !location.hash) return;
    const hashId = decodeLocationHashId(location.hash);
    let frame: number | null = null;
    let retryTimer: number | null = null;
    let cancelled = false;
    let delay = 100;

    const clearRetry = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const scrollToAnchor = (): boolean => {
      const el = document.getElementById(hashId);
      if (!el) return false;
      clearRetry();
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        el.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
      });
      return true;
    };

    const scheduleRetry = (startedAt: number) => {
      clearRetry();
      if (cancelled) return;
      if (Date.now() - startedAt >= 10_000) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (cancelled) return;
        if (scrollToAnchor()) return;
        delay = Math.min(delay * 2, 250);
        scheduleRetry(startedAt);
      }, delay);
    };

    if (!scrollToAnchor()) {
      // Bounded backoff polling avoids a subtree MutationObserver on #root.
      const startedAt = Date.now();
      scheduleRetry(startedAt);
    }

    return () => {
      cancelled = true;
      clearRetry();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [campaign?.id, location.hash]);

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (!isDm) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <Card className="text-center space-y-1">
          <p className="flex justify-center text-[var(--color-neutral-400)]"><GameIcon slug="padlock" size={28} reserveSpace /></p>
          <p style={{ fontSize: 13, color: 'var(--color-neutral-300)', fontWeight: 600 }}>DM only</p>
          <p className="text-muted" style={{ fontSize: 12 }}>Only this campaign's DM can change its settings.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full mx-auto px-5 pt-7 pb-12 flex flex-col gap-3.5" style={{ maxWidth: 640 }}>
      <h3 style={{ margin: '4px 0 0' }}>Campaign settings</h3>

      {campaign && settingsReady ? (
        <>
          {error && <ErrorNote message={error} onRetry={load} />}
          <GeneralCard
            key={`general-${campaign.id}`}
            campaignId={id}
            campaign={campaign}
            onSaved={(c) => {
              setCampaign(c);
              void refreshCampaigns();
            }}
          />
          <StatusCard
            key={`status-${campaign.id}`}
            campaignId={id}
            campaign={campaign}
            onSaved={(c) => {
              setCampaign(c);
              void refreshCampaigns();
            }}
          />
          <PublicRecapSharingCard
            key={`recap-${campaign.id}`}
            campaign={campaign}
            onChanged={async () => {
              await load();
              await refreshCampaigns();
            }}
          />
          <PublicInvitesCard
            key={`invites-${campaign.id}`}
            campaign={campaign}
            onChanged={async () => {
              await load();
              await refreshCampaigns();
            }}
          />
          <RuleSystemCard
            key={`rules-${campaign.id}`}
            campaignId={id}
            campaign={campaign}
            isAdmin={isAdmin}
            onSaved={(c) => setCampaign(c)}
          />
          <AiDmCard key={`aidm-${campaign.id}`} campaignId={id} />
          <ExportCard key={`export-${campaign.id}`} campaignId={id} />
          <CloneCard
            key={`clone-${campaign.id}`}
            campaign={campaign}
            onCloned={(c) => {
              void refreshCampaigns();
              navigate(`/c/${c.id}`);
            }}
          />
          <DangerZoneCard
            key={`danger-${campaign.id}`}
            campaign={campaign}
            onDeleted={() => {
              void refreshCampaigns();
              navigate('/');
            }}
          />
        </>
      ) : error && !campaign ? (
        <ErrorNote message={error} onRetry={load} />
      ) : (
        <Card>
          <Skeleton lines={6} />
        </Card>
      )}
    </div>
  );
}

function PublicRecapSharingCard({ campaign, onChanged }: { campaign: Campaign; onChanged: () => Promise<void> }) {
  const [confirming, setConfirming] = useState<'disable' | 'revoke' | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setPolicy(enabled: boolean) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.put<{ revoked: number }>(`${API}/campaigns/${campaign.id}/session-shares/policy`, { enabled });
      setMessage(
        enabled
          ? 'Public recap sharing enabled. Old links remain revoked.'
          : `Public recap sharing disabled. ${result.revoked} ${result.revoked === 1 ? 'link was' : 'links were'} revoked.`,
      );
      setConfirming(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update public recap sharing.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeAll() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.delete<{ revoked: number }>(`${API}/campaigns/${campaign.id}/session-shares`);
      setMessage(`Revoked ${result.revoked} public recap ${result.revoked === 1 ? 'link' : 'links'}.`);
      setConfirming(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't revoke public recap links.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card elev-sm" data-testid="public-recap-sharing-settings">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="card-kicker" style={{ margin: 0 }}>Public recap sharing</span>
        <span className={`tag ${campaign.publicRecapSharingEnabled ? 'tag-accent' : 'tag-neutral'}`}>
          {campaign.publicRecapSharingEnabled ? 'enabled' : 'disabled'}
        </span>
      </div>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        Public links reveal only one live recap, but anyone can forward them. Disabling this policy revokes every
        existing link atomically; turning it back on never restores those URLs.
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        {campaign.publicRecapSharingEnabled ? (
          <button className="btn" disabled={busy} aria-busy={busy || undefined} onClick={() => setConfirming('disable')}>Disable and revoke all</button>
        ) : (
          <button className="btn btn-primary" disabled={busy || campaign.status !== 'active'} aria-busy={busy || undefined} onClick={() => void setPolicy(true)}>
            Enable public sharing
          </button>
        )}
        <button className="btn btn-danger" disabled={busy} aria-busy={busy || undefined} onClick={() => setConfirming('revoke')}>Revoke all links</button>
      </div>
      {!campaign.publicRecapSharingEnabled && campaign.status !== 'active' && (
        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>Unarchive the campaign before enabling public sharing.</p>
      )}
      {message && <p className="text-sm text-emerald-300 m-0" role="status">{message}</p>}
      {error && <p className="text-sm text-red-400 m-0" role="alert">{error}</p>}
      {confirming === 'disable' && (
        <ConfirmDialog
          title="Disable public recap sharing?"
          body="Every existing public recap URL in this campaign will stop working immediately. This cannot be undone."
          confirmLabel="Disable and revoke all"
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void setPolicy(false)}
        />
      )}
      {confirming === 'revoke' && (
        <ConfirmDialog
          title="Revoke every public recap link?"
          body="All current public recap URLs in this campaign will stop working. Campaign sharing stays enabled for future links."
          confirmLabel="Revoke all links"
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void revokeAll()}
        />
      )}
    </div>
  );
}

/**
 * Public invite join-link policy (issue #857). Archive/trash auto-suspends
 * invites; restoring the campaign does NOT revive them — the DM must flip this
 * switch deliberately. Suspend keeps invite rows (same codes can work again);
 * revoke-all deletes them permanently.
 */
function PublicInvitesCard({ campaign, onChanged }: { campaign: Campaign; onChanged: () => Promise<void> }) {
  const [confirming, setConfirming] = useState<'suspend' | 'revoke' | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setPolicy(enabled: boolean) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.put<{ revoked: number }>(`${API}/campaigns/${campaign.id}/invites/policy`, { enabled });
      setMessage(
        enabled
          ? 'Public invites re-enabled. Existing unrevoked links work again.'
          : 'Public invites suspended. Outstanding links stop working until you re-enable them.',
      );
      setConfirming(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update public invites.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeAll() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.delete<{ revoked: number }>(`${API}/campaigns/${campaign.id}/invites`);
      setMessage(`Revoked ${result.revoked} invite ${result.revoked === 1 ? 'link' : 'links'}.`);
      setConfirming(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't revoke invite links.");
    } finally {
      setBusy(false);
    }
  }

  const canEnable = campaign.status === 'active' && campaign.deletedAt == null;

  return (
    <div className="card elev-sm" data-testid="public-invites-settings">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="card-kicker" style={{ margin: 0 }}>Public invites</span>
        <span className={`tag ${campaign.publicInvitesEnabled ? 'tag-accent' : 'tag-neutral'}`}>
          {campaign.publicInvitesEnabled ? 'enabled' : 'suspended'}
        </span>
      </div>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        Join links let anyone with the URL create an account or join this campaign. Archiving or moving the
        campaign to Trash suspends every outstanding link automatically; restoring does not revive them —
        re-enable here deliberately. Revoke destroys codes permanently.
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        {campaign.publicInvitesEnabled ? (
          <button className="btn" disabled={busy} aria-busy={busy || undefined} onClick={() => setConfirming('suspend')}>
            Suspend invites
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={busy || !canEnable}
            aria-busy={busy || undefined}
            onClick={() => void setPolicy(true)}
          >
            Re-enable invites
          </button>
        )}
        <button className="btn btn-danger" disabled={busy} aria-busy={busy || undefined} onClick={() => setConfirming('revoke')}>
          Revoke all links
        </button>
      </div>
      {!campaign.publicInvitesEnabled && !canEnable && (
        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
          Unarchive the campaign before re-enabling public invites.
        </p>
      )}
      {message && <p className="text-sm text-emerald-300 m-0" role="status">{message}</p>}
      {error && <p className="text-sm text-red-400 m-0" role="alert">{error}</p>}
      {confirming === 'suspend' && (
        <ConfirmDialog
          title="Suspend public invites?"
          body="Outstanding join links stop working immediately. Invite rows are kept — re-enabling later restores the same codes unless you revoke them."
          confirmLabel="Suspend invites"
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void setPolicy(false)}
        />
      )}
      {confirming === 'revoke' && (
        <ConfirmDialog
          title="Revoke every invite link?"
          body="All invite codes for this campaign are deleted permanently. Existing members are unaffected."
          confirmLabel="Revoke all links"
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void revokeAll()}
        />
      )}
    </div>
  );
}

function GeneralCard({
  campaignId,
  campaign,
  onSaved,
}: {
  campaignId: number;
  campaign: Campaign;
  onSaved: (c: Campaign) => void;
}) {
  const [name, setName] = useState(campaign.name);
  const [description, setDescription] = useState(campaign.description);
  const [dangerLevel, setDangerLevel] = useState<DangerLevel>(campaign.dangerLevel);
  const [dmControlsProgression, setDmControlsProgression] = useState(campaign.dmControlsProgression);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const metadataDirty = isCampaignMetadataDirty(campaign, { name, description, dangerLevel });
  const dirty = metadataDirty || dmControlsProgression !== campaign.dmControlsProgression;
  // Issue #760: campaign switcher confirms before discarding mid-edit settings.
  useUnsavedWork(`campaign-settings:${campaignId}`, dirty);

  async function save() {
    if (!name.trim()) {
      setError('Campaign name is required.');
      return;
    }
    // Issue #853: refuse to PATCH B with form state opened against A.
    if (!assertMutationTarget(campaign.id, campaignId).ok) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await api.patch<Campaign>(`${API}/campaigns/${campaignId}`, {
        name: name.trim(),
        description,
        dangerLevel,
        dmControlsProgression,
      });
      onSaved(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save changes.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card elev-sm">
      <span className="card-kicker">Campaign</span>
      <CampaignMetadataFields
        idPrefix="settings"
        name={name}
        description={description}
        dangerLevel={dangerLevel}
        onNameChange={setName}
        onDescriptionChange={setDescription}
        onDangerLevelChange={setDangerLevel}
        error={error}
        disabled={saving}
      />
      <div className="field">
        <label className="flex gap-2 items-center" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={dmControlsProgression}
            onChange={(e) => setDmControlsProgression(e.target.checked)}
          />
          <span>DM controls progression</span>
        </label>
        <p className="text-muted" style={{ fontSize: 12 }}>
          When on, only the DM can award XP or level up characters. When off, players may
          award XP and level up their own characters.
        </p>
      </div>
      <div className="flex gap-2 items-center">
        <button className="btn btn-primary" disabled={saving || !dirty} onClick={save}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {saved && <span className="text-muted" style={{ fontSize: 12 }}>Saved.</span>}
      </div>
    </div>
  );
}

const STATUSES: CampaignStatus[] = ['active', 'paused', 'completed'];

const STATUS_LABEL: Record<CampaignStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
};

/** Consequence copy per target status, so the confirmation spells out the real effect. */
const STATUS_CONSEQUENCE: Record<CampaignStatus, string> = {
  active:
    "The campaign becomes editable again — quests, notes, rolls and encounters are no longer read-only, and it leaves the Archive group on the campaign hub. Public invite links stay suspended until you deliberately re-enable them.",
  paused:
    "The campaign becomes read-only for everyone (quests, notes, rolls — everything) and is grouped under Archive on the campaign hub. Outstanding invite links are suspended so old join URLs stop working. No one can edit it until you set it back to Active.",
  completed:
    "The campaign becomes read-only for everyone and is grouped under Archive on the campaign hub, marking the story finished. Outstanding invite links are suspended so old join URLs stop working. Set it back to Active to resume play.",
};

/** Window during which Undo is offered after an archiving change (issue #640). */
const STATUS_UNDO_TIMEOUT_MS = 8000;

/**
 * Archive control (issues #16, #640).
 *
 * #640 — the fire-on-change select used to apply Paused/Completed the instant
 * the DM picked them, locking the whole campaign read-only with no chance to
 * back out. Now the flow is: pick → preview (current→proposed + consequence)
 * → Apply → ConfirmDialog for archiving directions → PATCH → Undo snackbar.
 * Un-archiving (anything → Active) is the safe direction: it PATCHes directly
 * with no confirm, since the recovery IS the edit.
 *
 * Status is PATCHed on its own — the server rejects any other field on an
 * archived (paused/completed) campaign, so this card is the one switch that
 * always works, both ways.
 */
function StatusCard({
  campaignId,
  campaign,
  onSaved,
}: {
  campaignId: number;
  campaign: Campaign;
  onSaved: (c: Campaign) => void;
}) {
  const announce = useAnnounce();
  const [snapshot, setSnapshot] = useState<StatusConfirmSnapshot>(initialStatusConfirmState);
  const [saving, setSaving] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveInviteCount, setLiveInviteCount] = useState(0);
  const [revokeInvitesOnArchive, setRevokeInvitesOnArchive] = useState(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // If the persisted status changes out from under us (reload or an external
  // edit), drop every pending transient so the select reflects the real server
  // state. Our OWN successful PATCH transitions to `undo` explicitly in
  // applyStatus — that phase must survive this effect (which fires because
  // onSaved updates campaign.status), so the recovery snackbar isn't yanked the
  // instant the lock lands. Likewise `confirming` is a mid-action state the DM
  // is actively driving; only reset preview/idle.
  useEffect(() => {
    setSnapshot((cur) => {
      if (cur.phase === 'undo' || cur.phase === 'confirming') return cur;
      return cur.phase === 'idle' ? cur : { ...initialStatusConfirmState };
    });
  }, [campaign.status]);

  // Arm/clear the undo snackbar's real timeout solely from the snapshot. The
  // reducer guarantees undoArmed is true only in `undo`, so entering it arms
  // the timeout and leaving it (expire/undo/reset) clears it — mirroring the
  // UndoSnackbar timer pattern so the recovery window can't leak on unmount.
  useEffect(() => {
    if (!undoArmed(snapshot)) {
      if (undoTimerRef.current != null) {
        clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
      return;
    }
    undoTimerRef.current = setTimeout(() => {
      setSnapshot((cur) => reduceStatusConfirm(cur, { type: 'expire' }));
    }, STATUS_UNDO_TIMEOUT_MS);
    return () => {
      if (undoTimerRef.current != null) {
        clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
    };
  }, [snapshot]);

  // Unmount safety: never leak a pending undo timer if the card is removed.
  useEffect(() => {
    return () => {
      if (undoTimerRef.current != null) clearTimeout(undoTimerRef.current);
    };
  }, []);

  function onSelect(value: CampaignStatus) {
    setError(null);
    // The recovery direction (anything → Active) PATCHes directly with no
    // preview or confirm: the edit itself IS the recovery, so gating it would
    // just add friction to the safe path. Archiving and archive-tier reshuffles
    // (Paused ↔ Completed) go through the preview → confirm flow (#640).
    if (!isArchivingTransition(campaign.status, value)) {
      void applyStatus(value);
      return;
    }
    setSnapshot((cur) =>
      reduceStatusConfirm(cur, { type: 'select', status: value, current: campaign.status }),
    );
  }

  function requestConfirm() {
    setRevokeInvitesOnArchive(false);
    setSnapshot((cur) => reduceStatusConfirm(cur, { type: 'requestConfirm' }));
    // Load outstanding invites for the consequence dialog (#857). Failures are
    // non-fatal — the archive still proceeds; the count just stays at 0.
    void api
      .get<CampaignInvite[]>(`${API}/campaigns/${campaignId}/invites`)
      .then((list) => setLiveInviteCount(list.length))
      .catch(() => setLiveInviteCount(0));
  }

  function cancelConfirm() {
    setRevokeInvitesOnArchive(false);
    setSnapshot((cur) => reduceStatusConfirm(cur, { type: 'cancelConfirm' }));
  }

  function cancelPreview() {
    setSnapshot((cur) => reduceStatusConfirm(cur, { type: 'cancel' }));
  }

  async function applyStatus(value: CampaignStatus) {
    setSaving(true);
    setError(null);
    const from = campaign.status;
    try {
      // Revoke+archive in one server transaction via query flag — never revoke
      // client-side before the status change, or a failed archive permanently
      // destroys invite rows while the campaign stays active (#857 Bugbot).
      const revokeQs =
        isArchivingTransition(from, value) && revokeInvitesOnArchive ? '?revokeInvites=true' : '';
      const updated = await api.patch<Campaign>(`${API}/campaigns/${campaignId}${revokeQs}`, {
        status: value,
      });
      onSaved(updated);
      // Announce via the app-root live region (survives the card re-rendering
      // into the archived state) so a screen reader hears the lock land.
      announce(
        isArchivingTransition(from, value)
          ? `Campaign ${STATUS_LABEL[value].toLowerCase()}: now read-only. Undo available for a few seconds.`
          : `Campaign ${STATUS_LABEL[value].toLowerCase()}.`,
      );
      // Arm the undo window only for archiving directions — un-archiving needs
      // no recovery (the edit itself is the recovery), and arming it there
      // would surface a pointless snackbar after every resume.
      if (isArchivingTransition(from, value)) {
        setSnapshot({ phase: 'undo', pending: null, appliedFrom: from });
      } else {
        setSnapshot({ ...initialStatusConfirmState });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change the campaign status.");
    } finally {
      setSaving(false);
    }
  }

  async function undoApply() {
    if (!snapshot.appliedFrom) return;
    if (undoBusy) return; // duplicate-restore guard, mirroring UndoSnackbar.
    setUndoBusy(true);
    setError(null);
    const target = snapshot.appliedFrom;
    try {
      // Cancel the auto-dismiss timer SYNCHRONOUSLY before awaiting, so a slow
      // network can't yank the snackbar mid-restore (the #694 lesson).
      if (undoTimerRef.current != null) {
        clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
      const updated = await api.patch<Campaign>(`${API}/campaigns/${campaignId}`, { status: target });
      onSaved(updated);
      announce(`Campaign ${STATUS_LABEL[target].toLowerCase()}: reverted to ${STATUS_LABEL[target].toLowerCase()}.`);
      setSnapshot({ ...initialStatusConfirmState });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't undo the status change.");
      // Leave the snackbar up — the DM can retry by clicking Undo again. The
      // reducer's `undo` phase persists until expire/undo/reset, and we did not
      // clear appliedFrom, so a re-click still has a target.
    } finally {
      setUndoBusy(false);
    }
  }

  function dismissUndo() {
    setSnapshot((cur) => reduceStatusConfirm(cur, { type: 'expire' }));
  }

  const archived = campaign.status !== 'active';
  const pending = snapshot.pending;
  const archiving = pending ? isArchivingTransition(campaign.status, pending) : false;
  const undoOpen = undoArmed(snapshot);
  const confirming = confirmOpen(snapshot);
  // The preview card is visible in `preview` AND `confirming`: the modal opens
  // ON TOP of the preview, and CancelConfirm returns to preview, so keeping
  // the preview mounted through the confirm avoids a flash.
  const previewVisible = pending && (snapshot.phase === 'preview' || snapshot.phase === 'confirming');

  return (
    <div className="card elev-sm" data-testid="campaign-status-settings">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="card-kicker" style={{ margin: 0 }}>Status &amp; archive</span>
        {archived && <span className="tag tag-neutral" style={{ fontSize: 10 }}>read-only</span>}
      </div>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        Paused and completed campaigns are archived: read-only for everyone (quests, notes, rolls — everything)
        and grouped under Archive on the campaign hub. Set the status back to Active to resume play.
      </p>
      <div className="field" style={{ maxWidth: 200 }}>
        <label htmlFor="settings-status">Campaign status</label>
        <select
          id="settings-status"
          className="input"
          value={pending ?? campaign.status}
          disabled={saving || undoOpen}
          onChange={(e) => onSelect(e.target.value as CampaignStatus)}
        >
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status]}
            </option>
          ))}
        </select>
      </div>

      {/* Preview card: current → proposed + consequence + Apply/Cancel. The
          select no longer PATCHes on change (#640). Stays mounted through the
          `confirming` phase so the ConfirmDialog opens on top of it and
          CancelConfirm returns to the preview without a flash. */}
      {previewVisible && (
        <div
          data-testid="status-change-preview"
          style={{
            border: '1px solid var(--color-divider)',
            borderRadius: 'var(--radius-md)',
            padding: '10px 12px',
            fontSize: 11.5,
          }}
          className="flex flex-col gap-1.5"
        >
          <p style={{ margin: 0, color: 'var(--color-text)' }}>
            Change status from <strong>{STATUS_LABEL[campaign.status]}</strong> to{' '}
            <strong>{STATUS_LABEL[pending]}</strong>?
          </p>
          <p className="text-muted" style={{ margin: 0 }}>{STATUS_CONSEQUENCE[pending]}</p>
          <div className="flex gap-2 items-center" style={{ marginTop: 4 }}>
            <button
              className="btn btn-primary"
              style={{ fontSize: 12.5 }}
              disabled={saving || confirming}
              aria-busy={saving || undefined}
              onClick={() => {
                // Archiving directions route through the ConfirmDialog (opened
                // via requestConfirm → `confirming` phase) so the consequence is
                // spelled out twice — once in the preview, once in the modal —
                // matching the audit's "consequence-rich confirmation" requirement.
                // The safe direction (anything → Active) PATCHes directly with no
                // confirm, because the edit itself IS the recovery.
                if (archiving) {
                  requestConfirm();
                } else {
                  void applyStatus(pending);
                }
              }}
            >
              {saving ? 'Applying…' : `Apply ${STATUS_LABEL[pending]}`}
            </button>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12.5 }}
              disabled={saving}
              onClick={cancelPreview}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Consequence-rich confirmation for archiving directions. Opens ONLY in
          the `confirming` phase (after the Apply click), NOT on select — so the
          DM gets a chance to back out of the preview before the modal commits.
          The body distinguishes Paused vs Completed so the DM knows what kind of
          read-only they're committing to. */}
      {confirming && pending && (
        <ConfirmDialog
          title={`Archive this campaign as ${STATUS_LABEL[pending]}?`}
          body={
            <div className="flex flex-col gap-2">
              <p style={{ margin: 0 }}>
                {STATUS_CONSEQUENCE[pending]}
              </p>
              {liveInviteCount > 0 && (
                <div
                  data-testid="archive-outstanding-invites"
                  className="flex flex-col gap-1.5"
                  style={{
                    border: '1px solid var(--color-divider)',
                    borderRadius: 'var(--radius-md)',
                    padding: '8px 10px',
                    fontSize: 11.5,
                  }}
                >
                  <p style={{ margin: 0 }}>
                    {liveInviteCount === 1
                      ? '1 outstanding invite link will be suspended.'
                      : `${liveInviteCount} outstanding invite links will be suspended.`}{' '}
                    Restoring Active does not revive them — re-enable invites deliberately afterwards.
                  </p>
                  <label className="flex items-center gap-2" style={{ margin: 0, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={revokeInvitesOnArchive}
                      onChange={(e) => setRevokeInvitesOnArchive(e.target.checked)}
                      data-testid="archive-revoke-invites"
                    />
                    <span>Also revoke all invite links permanently</span>
                  </label>
                </div>
              )}
              <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
                You can undo this for a few seconds, or set the status back to Active at any time.
              </p>
            </div>
          }
          confirmLabel={`Archive as ${STATUS_LABEL[pending]}`}
          busy={saving}
          onCancel={cancelConfirm}
          onConfirm={() => void applyStatus(pending)}
        />
      )}

      {/* Undo snackbar — inline (not the shared UndoSnackbar) because the
          recovery here is a campaign-status PATCH, not a restore endpoint, and
          the shared component is wired to `onExpire`/`onUndo` semantics that
          don't fit. Keeps the same accessible role=status + aria-live pattern. */}
      {undoOpen && snapshot.appliedFrom && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="status-change-undo"
          style={{
            marginTop: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            flexWrap: 'wrap',
            padding: '10px 12px',
            borderRadius: 'var(--radius-md, 10px)',
            background: 'var(--color-neutral-800, #1c1c22)',
            color: 'var(--color-neutral-100, #f2f2f5)',
            border: '1px solid var(--color-neutral-700, #333)',
            fontSize: 12.5,
          }}
        >
          <span>Campaign archived as {STATUS_LABEL[campaign.status]}. Undo?</span>
          <button
            className="btn btn-secondary"
            style={{ fontSize: 12.5, minHeight: 0, padding: '4px 12px' }}
            disabled={undoBusy}
            aria-busy={undoBusy || undefined}
            onClick={() => void undoApply()}
          >
            {undoBusy ? 'Restoring…' : 'Undo'}
          </button>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12.5, minHeight: 0, padding: '4px 12px' }}
            disabled={undoBusy}
            onClick={dismissUndo}
          >
            Dismiss
          </button>
        </div>
      )}

      {error && <p className="text-sm" style={{ color: '#f87171' }} role="alert">{error}</p>}
    </div>
  );
}

function RuleSystemCard({
  campaignId,
  campaign,
  isAdmin,
  onSaved,
}: {
  campaignId: number;
  campaign: Campaign;
  isAdmin: boolean;
  onSaved: (c: Campaign) => void;
}) {
  const [packs, setPacks] = useState<RulePack[] | null>(null);
  const [selected, setSelected] = useState<string>(campaign.ruleSystem ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.get<RulePack[]>(`${API}/rules/packs`);
        if (!cancelled) setPacks(list);
      } catch {
        if (!cancelled) setPacks([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function applyRuleSystem() {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.patch<Campaign>(`${API}/campaigns/${campaignId}`, {
        ruleSystem: selected,
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change the rule system.");
    } finally {
      setSaving(false);
    }
  }

  const currentSlug = campaign.ruleSystem ?? '';
  const currentPack = packs?.find((p) => p.slug === currentSlug);
  // A campaign can point at a slug whose pack has since been uninstalled (#348). Uninstall
  // now clears the slug server-side, but a stale reference (older data, or a race) still
  // resolves to the D&D 5e adapter for combat — surface that plainly rather than a bare slug.
  const dangling = !!currentSlug && !!packs && !currentPack;
  const currentMechanics = currentSlug ? mechanicsForPackSlug(currentSlug) : undefined;

  // The pending switch — what mechanically changes if the admin applies `selected` (#348).
  const dirty = selected !== currentSlug;
  const targetPack = packs?.find((p) => p.slug === selected);
  const targetLabel = selected ? targetPack?.name ?? selected : 'None / homebrew';
  const targetMechanics = selected
    ? mechanicsForPackSlug(selected) ?? `Falls back to ${ruleSystemAdapterLabel(selected)} combat math.`
    : 'No installed rules — dice, sheets and notes still work; combat uses D&D 5e defaults.';

  return (
    <div className="card elev-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="card-kicker" style={{ margin: 0 }}>Rule system</span>
        {currentPack ? (
          <>
            <span className="tag tag-accent-2" style={{ fontSize: 10 }}>{currentPack.name}</span>
            <span className="tag tag-accent" style={{ fontSize: 10 }}>pack installed</span>
          </>
        ) : dangling ? (
          <span className="tag tag-neutral" style={{ fontSize: 10 }}>
            {currentSlug} · pack no longer installed
          </span>
        ) : (
          <span className="tag tag-neutral" style={{ fontSize: 10 }}>None / homebrew</span>
        )}
        <div className="flex-1" />
        {isAdmin && (
          <Link
            to={adminRulesHref(`/c/${campaignId}/settings`)}
            className="btn btn-secondary"
            style={{ fontSize: 12.5 }}
          >
            Manage packs
          </Link>
        )}
      </div>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        Powers the compendium, character math, statblocks and AI rules lookups. Packs install server-wide from open
        sources; switching systems keeps existing sheets and combatant stats and only re-interprets them.
      </p>
      {currentPack && currentMechanics && (
        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
          <strong>Current rules:</strong> {currentMechanics}
        </p>
      )}
      {dangling && (
        <p style={{ margin: 0, fontSize: 11.5, color: '#fbbf24' }}>
          The pack <strong>{currentSlug}</strong> is no longer installed on this server — this campaign is using D&amp;D
          5e defaults for combat math. Pick an installed system below (or None / homebrew) to clear the stale reference.
        </p>
      )}
      {packs && packs.length > 0 && (
        <div className="field" style={{ maxWidth: 320 }}>
          <label htmlFor="settings-rulesystem">Change rule system</label>
          <select
            id="settings-rulesystem"
            className="input"
            value={selected}
            disabled={saving}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">None / homebrew</option>
            {packs.map((pack) => (
              <option key={pack.id} value={pack.slug}>
                {pack.name} (v{pack.version})
              </option>
            ))}
          </select>
        </div>
      )}
      {dirty && packs && packs.length > 0 && (
        <div
          style={{
            border: '1px solid var(--color-divider)',
            borderRadius: 'var(--radius-md)',
            padding: '10px 12px',
            fontSize: 11.5,
          }}
          className="flex flex-col gap-1.5"
        >
          <p style={{ margin: 0, color: 'var(--color-text)' }}>
            Switch to <strong>{targetLabel}</strong>?
          </p>
          <p className="text-muted" style={{ margin: 0 }}>
            {targetMechanics}
          </p>
          <p className="text-muted" style={{ margin: 0 }}>
            Existing encounters and combatants keep their stored numbers — only the interpretation (initiative,
            DC model, condition list, degrees of success) changes at read time. Nothing is recalculated or lost.
          </p>
          <div className="flex gap-2 items-center" style={{ marginTop: 4 }}>
            <button className="btn btn-primary" style={{ fontSize: 12.5 }} disabled={saving} onClick={applyRuleSystem}>
              {saving ? 'Applying…' : 'Apply change'}
            </button>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12.5 }}
              disabled={saving}
              onClick={() => setSelected(currentSlug)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {packs && packs.length === 0 && (
        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
          No rule packs are installed on this server yet.
          {isAdmin ? ' Install one from Server admin → Rule systems.' : ' Ask a server admin to install one.'}
        </p>
      )}
      {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
    </div>
  );
}

function ExportCard({ campaignId }: { campaignId: number }) {
  return (
    <div className="card elev-sm">
      <span className="card-kicker">Export campaign</span>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        Take everything with you — no lock-in. Includes quests, NPCs, locations, characters, sessions and notes.
      </p>
      <div className="flex gap-2 flex-wrap">
        <a className="btn btn-secondary" style={{ fontSize: 12.5 }} href={`${API}/campaigns/${campaignId}/export?format=json`}>
          ⬇ JSON export
        </a>
        <a className="btn btn-secondary" style={{ fontSize: 12.5 }} href={`${API}/campaigns/${campaignId}/export?format=mdzip`}>
          ⬇ Markdown zip
        </a>
      </div>
    </div>
  );
}

function CloneCard({ campaign, onCloned }: { campaign: Campaign; onCloned: (c: Campaign) => void }) {
  const [name, setName] = useState(`${campaign.name} (copy)`);
  const [mode, setMode] = useState<CampaignCloneMode>('full');
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function clone() {
    setCloning(true);
    setError(null);
    try {
      const created = await api.post<Campaign>(`${API}/campaigns/${campaign.id}/clone`, {
        name: name.trim() || undefined,
        mode,
      });
      onCloned(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't duplicate the campaign.");
      setCloning(false);
    }
  }

  return (
    <div className="card elev-sm">
      <span className="card-kicker">Duplicate campaign</span>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        Reuse your prep. A full copy duplicates everything — quests, NPCs, locations, characters, sessions, notes and
        encounters (encounter combat state is reset: fights go back to preparing with full HP and no conditions). A template
        copies the world only and resets progress: quests back to available, objectives unchecked, no sessions or play
        state. Members aren't copied — you become the new campaign's DM.
      </p>
      <div className="field">
        <label htmlFor="settings-clone-name">New campaign name</label>
        <input
          id="settings-clone-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`${campaign.name} (copy)`}
        />
      </div>
      <div className="field" style={{ maxWidth: 260 }}>
        <label htmlFor="settings-clone-mode">What to copy</label>
        <select
          id="settings-clone-mode"
          className="input"
          value={mode}
          onChange={(e) => setMode(e.target.value as CampaignCloneMode)}
        >
          <option value="full">Full copy — everything</option>
          <option value="template">Template — prep only, progress reset</option>
        </select>
      </div>
      {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
      <div className="flex gap-2 items-center">
        <button className="btn btn-secondary" style={{ fontSize: 12.5 }} disabled={cloning} onClick={clone}>
          {cloning ? 'Duplicating…' : mode === 'template' ? 'Create from template' : 'Duplicate campaign'}
        </button>
      </div>
    </div>
  );
}

function DangerZoneCard({ campaign, onDeleted }: { campaign: Campaign; onDeleted: () => void }) {
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [liveInviteCount, setLiveInviteCount] = useState(0);
  const [revokeInvitesOnTrash, setRevokeInvitesOnTrash] = useState(false);

  const canDelete = confirmText.trim() === campaign.name;

  function openConfirm() {
    setOpen(true);
    setRevokeInvitesOnTrash(false);
    void api
      .get<CampaignInvite[]>(`${API}/campaigns/${campaign.id}/invites`)
      .then((list) => setLiveInviteCount(list.length))
      .catch(() => setLiveInviteCount(0));
  }

  async function remove() {
    if (!canDelete) return;
    setDeleting(true);
    setError(null);
    try {
      // Revoke+trash in one server transaction via query flag — never revoke
      // client-side before trash, or a failed trash permanently destroys invite
      // rows while the campaign stays live (#857 Bugbot).
      const revokeQs = revokeInvitesOnTrash ? '?revokeInvites=true' : '';
      await api.delete(`${API}/campaigns/${campaign.id}${revokeQs}`);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete campaign.");
      setDeleting(false);
    }
  }

  return (
    <div className="card elev-sm" style={{ borderLeft: '2px solid #f87171' }}>
      <span className="card-kicker" style={{ color: '#f87171' }}>Danger zone</span>
      {!open ? (
        <div className="flex items-center gap-2">
          <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
            Deleting a campaign moves it to the Trash — it's hidden and restorable. Nothing is
            permanently removed until you purge it from the Trash on your campaigns page.
            Outstanding invite links are suspended automatically.
          </p>
          <div className="flex-1" />
          <button className="btn btn-ghost btn-danger" style={{ fontSize: 12.5 }} onClick={openConfirm}>
            Delete campaign…
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--color-neutral-200)' }}>
            Type <strong>{campaign.name}</strong> to move it to the Trash (you can restore it later).
            Invite links are suspended so old join URLs stop working; restore does not revive them.
          </p>
          {liveInviteCount > 0 && (
            <div
              data-testid="trash-outstanding-invites"
              className="flex flex-col gap-1.5"
              style={{
                border: '1px solid var(--color-divider)',
                borderRadius: 'var(--radius-md)',
                padding: '8px 10px',
                fontSize: 11.5,
              }}
            >
              <p style={{ margin: 0 }}>
                {liveInviteCount === 1
                  ? '1 outstanding invite link will be suspended.'
                  : `${liveInviteCount} outstanding invite links will be suspended.`}
              </p>
              <label className="flex items-center gap-2" style={{ margin: 0, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={revokeInvitesOnTrash}
                  onChange={(e) => setRevokeInvitesOnTrash(e.target.checked)}
                  data-testid="trash-revoke-invites"
                />
                <span>Also revoke all invite links permanently</span>
              </label>
            </div>
          )}
          <input
            className="input"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={campaign.name}
          />
          {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
          <div className="flex gap-2 items-center">
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12.5 }}
              onClick={() => {
                setOpen(false);
                setConfirmText('');
                setError(null);
                setRevokeInvitesOnTrash(false);
              }}
              disabled={deleting}
            >
              Cancel
            </button>
            <div className="flex-1" />
            <button
              className="btn btn-danger"
              style={{ fontSize: 12.5 }}
              disabled={!canDelete || deleting}
              aria-busy={deleting || undefined}
              onClick={() => void remove()}
            >
              {deleting ? 'Moving…' : 'Move to Trash'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
