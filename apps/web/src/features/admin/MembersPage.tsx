import { useTranslation } from 'react-i18next';
/**
 * Campaign members & roles — /c/:campaignId/members.
 * Mirrors design/claude-design/Campfire.dc.html "Players" (~1508-1559): an invite-link
 * card, live invite links, and a members table (role select + character link + remove).
 *
 * The invite card is backed by the campaign-invites API (issue #7): a DM generates a
 * /join/<code> link at a chosen role (player/viewer — never dm), copies it, and can
 * revoke it any time. Whoever opens the link creates their own account (or joins with
 * an existing one) and lands in this campaign — no server admin involved per player.
 *
 * Audit log kept (existing functionality, not in this design block).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useAnnounce } from '../../components/Announcer';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  Character,
  CampaignMember,
  CampaignInvite,
  GuestDmGrant,
  GuestDmGrantScope,
  InviteRole,
  Role,
  AuditEntry,
  TrashedEntity,
} from '@campfire/schema';
import { api, API, ApiError, translateApiError } from '../../lib/api';
import { joinPublicBase } from '../../lib/public-base';
import { usePanelData } from '../../lib/usePanelData';
import { useAuth } from '../../app/auth';
import { useCampaign, useCampaigns } from '../../app/CampaignContext';
import { Card, Btn, TextInput, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useDialog } from '../../components/useDialog';
import { CopyControl } from '../../components/CopyControl';
import { formatDateTime } from '../../lib/format';
import { GameIcon } from '../../components/GameIcon';
import { AuditEntryRow } from './campaignAuditDisplay';
import { firstGrapheme } from '../../lib/avatarText';
import {
  INVITE_COPY_FAILURE,
  INVITE_COPY_SUCCESS,
  inviteCopyButtonLabel,
  inviteLinkFieldLabel,
  inviteRoleOptions,
} from './inviteRoleOptions';
import {
  ADD_MEMBER_CANCEL_LABEL,
  ADD_MEMBER_DIALOG_TITLE,
  ADD_MEMBER_ROLE_HELP,
  ADD_MEMBER_ROLE_LABEL,
  ADD_MEMBER_SEARCH_LABEL,
  MEMBER_CHARACTER_LINK_HELP,
  MEMBER_CHARACTER_TRANSFER_BODY,
  MEMBER_CHARACTER_TRANSFER_CONFIRM_LABEL,
  memberAddedAnnouncement,
  memberCharacterControlLabel,
  memberCharacterOptionLabel,
  memberCharacterSavedAnnouncement,
  memberCharacterTransferTitle,
  memberDisplayName,
  memberRemoveLabel,
  memberRoleControlLabel,
  memberRoleSavedAnnouncement,
} from './memberControlsA11y';
import { useDisclosure } from '../../components/useDisclosure';
import { InviteQrCard } from './InviteQrCard';
import { SafetyControlsCard } from '../safety/SafetyControlsCard';

const ROLE_CHIP: Record<Role, string> = {
  dm: 'cf-chip-dm',
  player: 'cf-chip-party',
  viewer: 'cf-chip-private',
};
const ROLE_LABEL: Record<Role, string> = { dm: 'DM', player: 'Player', viewer: 'Viewer' };
const GRANT_SCOPE_LABEL: Record<GuestDmGrantScope, string> = {
  dm: 'DM play authority',
  membership_admin: 'Membership admin',
  destructive: 'Destructive lifecycle',
};

export default function MembersPage() {
  const { t } = useTranslation();
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const { roleIn, me } = useAuth();
  const role = roleIn(id);
  const myUserId = me?.user?.id ?? null;

  // Core content is the member roster — it drives the page. The character list
  // (for linking characters to members) and the audit log are AUXILIARY panels
  // (issue #697): each loads on its own, so a character or audit outage degrades
  // only its own card and never blanks the roster or maps to a page-level error.
  const [members, setMembers] = useState<CampaignMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const isDm = role === 'dm';

  // Auxiliary panels load independently with panel-scoped error/retry. A failure
  // here sets only `charactersPanel.error` / `auditPanel.error` — never the
  // page-level `error` above, and never a not-found state.
  const charactersPanel = usePanelData<Character[]>(
    useCallback(() => api.get<Character[]>(`${API}/campaigns/${id}/characters`), [id]),
    isDm,
    t('admin.errors.loadCharacters'),
  );
  const auditPanel = usePanelData<AuditEntry[]>(
    useCallback(() => api.get<AuditEntry[]>(`${API}/campaigns/${id}/audit`), [id]),
    isDm,
    t('admin.errors.loadAuditLog'),
  );
  const trashPanel = usePanelData<TrashedEntity[]>(
    useCallback(() => api.get<TrashedEntity[]>(`${API}/campaigns/${id}/trash`), [id]),
    isDm,
    t('errors.loadFailed'),
  );
  useEffect(() => {
    if (!isDm) return;
    const onFocus = () => trashPanel.retry();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [isDm, trashPanel.retry]);
  const grantsPanel = usePanelData<GuestDmGrant[]>(
    useCallback(() => api.get<GuestDmGrant[]>(`${API}/campaigns/${id}/members/grants`), [id]),
    isDm,
    t('admin.errors.loadGuestDmGrants'),
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const m = await api.get<CampaignMember[]>(`${API}/campaigns/${id}/members`);
      setMembers(m);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (Number.isFinite(id) && role) void load();
  }, [id, role, load]);

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message={t('common.noCampaign')} />
      </div>
    );
  }

  if (!role) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <Card className="text-center space-y-1">
          <p className="flex justify-center text-[var(--color-neutral-400)]"><GameIcon slug="padlock" size={28} reserveSpace /></p>
          <p className="text-sm text-slate-300 font-semibold">You're not a member of this campaign</p>
        </Card>
      </div>
    );
  }

  if (loading && !members) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5 space-y-5">
        <Card>
          <Skeleton lines={4} />
        </Card>
      </div>
    );
  }

  if (error && !members) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message={error} onRetry={load} />
      </div>
    );
  }

  if (!isDm) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
        <h1 className="text-xl font-extrabold text-white">{t('nav.yourData')}</h1>
        {error && <ErrorNote message={error} onRetry={load} />}
        <Card className="space-y-3">
          <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Members</h2>
          <ReadOnlyMemberTable members={members ?? []} />
        </Card>
        <AiConsentCard campaignId={id} members={members ?? []} myUserId={myUserId} onChange={() => load()} />
        <SafetyControlsCard campaignId={id} members={members ?? []} myUserId={myUserId} />
        <YourMembershipCard campaignId={id} members={members ?? []} myUserId={myUserId} />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10" style={{ maxWidth: 760 }}>
      <h1 className="text-xl font-extrabold text-white m-0">Members</h1>
      {error && <ErrorNote message={error} onRetry={load} />}

      <InviteCard campaignId={id} />

      <MembersCard
        campaignId={id}
        members={members ?? []}
        characters={charactersPanel.data ?? []}
        charactersLoading={charactersPanel.loading}
        charactersError={charactersPanel.error}
        onRetryCharacters={charactersPanel.retry}
        onChange={() => {
          void load();
          charactersPanel.retry();
        }}
      />

      <AiConsentCard campaignId={id} members={members ?? []} myUserId={myUserId} onChange={() => load()} />

      <SafetyControlsCard campaignId={id} members={members ?? []} myUserId={myUserId} />

      <GuestDmGrantsCard
        campaignId={id}
        members={members ?? []}
        grants={grantsPanel.data ?? []}
        loading={grantsPanel.loading}
        error={grantsPanel.error}
        onRetry={grantsPanel.retry}
        onChange={() => {
          grantsPanel.retry();
          void load();
        }}
      />

      <Card className="space-y-3">
        <div className="flex items-center justify-between border-b border-slate-700 pb-2">
          <h2 className="font-bold text-white text-sm m-0">Audit log</h2>
          <Link to={`/c/${id}/audit`} className="text-[11px] text-secondary hover:text-white">
            View full log →
          </Link>
        </div>
        {auditPanel.loading && !auditPanel.data && <Skeleton lines={3} />}
        {auditPanel.error && !auditPanel.data ? (
          <ErrorNote message={auditPanel.error} onRetry={auditPanel.retry} />
        ) : (
          <AuditList
            entries={auditPanel.data ?? []}
            members={members ?? []}
            campaignId={id}
            trashedTimelineEventIds={
              trashPanel.data == null || trashPanel.loading || trashPanel.error != null
                ? null
                : new Set(trashPanel.data.filter((item) => item.type === 'timeline_event').map((item) => item.id))
            }
          />
        )}
      </Card>
    </div>
  );
}

function inviteLinkFor(code: string): string {
  return `${window.location.origin}${joinPublicBase('/join/')}${code}`;
}

/** "expires in 6d" / "expires in 3h" — invites are short-lived, no need for finer grain. */
function expiresIn(iso: string): string {
  const msLeft = new Date(iso).getTime() - Date.now();
  if (msLeft <= 0) return 'expired';
  const hours = Math.ceil(msLeft / 3_600_000);
  if (hours < 24) return `expires in ${hours}h`;
  return `expires in ${Math.ceil(hours / 24)}d`;
}

/** Expiry preset options for invite creation (#821). */
type ExpiryPreset = 'end-of-today' | '24h' | '7d' | '30d' | 'custom';

/** Max-uses preset options for invite creation (#821). */
type MaxUsesPreset = 'unlimited' | '1' | '5' | '10' | 'custom';

/** Compute expiresInDays from the selected preset or custom date. */
function computeExpiryDays(preset: ExpiryPreset, customDate: string): number {
  switch (preset) {
    case 'end-of-today':
      return 1;
    case '24h':
      return 1;
    case '7d':
      return 7;
    case '30d':
      return 30;
    case 'custom': {
      if (!customDate) return 7;
      const diff = Math.ceil((new Date(customDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      return Math.max(1, Math.min(365, diff));
    }
  }
}

/** Human-readable expiry description for the preview. */
function describeExpiry(preset: ExpiryPreset, customDate: string): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  switch (preset) {
    case 'end-of-today': {
      const eod = new Date();
      eod.setHours(23, 59, 59, 999);
      return `End of today (${formatDateTime(eod)} ${tz})`;
    }
    case '24h': {
      const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
      return `24 hours (${formatDateTime(d)} ${tz})`;
    }
    case '7d': {
      const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      return `7 days (${formatDateTime(d)} ${tz})`;
    }
    case '30d': {
      const d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      return `30 days (${formatDateTime(d)} ${tz})`;
    }
    case 'custom': {
      if (!customDate) return 'Select a date';
      const d = new Date(customDate);
      return `${formatDateTime(d)} ${tz}`;
    }
  }
}

/** Compute maxUses value for the API from preset/custom input. */
function computeMaxUses(preset: MaxUsesPreset, customValue: string): number | null {
  switch (preset) {
    case 'unlimited':
      return null;
    case '1':
      return 1;
    case '5':
      return 5;
    case '10':
      return 10;
    case 'custom': {
      const n = parseInt(customValue, 10);
      return Number.isFinite(n) && n >= 1 ? Math.min(n, 1000) : null;
    }
  }
}

/** Human-readable max-uses description for the preview. */
function describeMaxUses(preset: MaxUsesPreset, customValue: string): string {
  switch (preset) {
    case 'unlimited':
      return 'Unlimited';
    case '1':
      return '1 use';
    case '5':
      return '5 uses';
    case '10':
      return '10 uses';
    case 'custom': {
      const n = parseInt(customValue, 10);
      if (!Number.isFinite(n) || n < 1) return 'Enter a number';
      return `${Math.min(n, 1000)} use${n === 1 ? '' : 's'}`;
    }
  }
}

/** Whether the current preset combo is recommended for events/conventions. */
function isEventPreset(expiryPreset: ExpiryPreset, maxUsesPreset: MaxUsesPreset): boolean {
  const shortLived = expiryPreset === 'end-of-today' || expiryPreset === '24h';
  const limited = maxUsesPreset !== 'unlimited';
  return shortLived && limited;
}

/**
 * Invite-link generation + live links list, backed by /campaigns/:id/invites.
 * Anyone with a link self-onboards at the chosen role via /join/<code> (see
 * features/auth/JoinPage.tsx) — revoke a link here if it leaks.
 *
 * Issue #821: exposes expiry presets (end-of-today, 24h, 7d, 30d, custom) and
 * max-uses controls (unlimited, 1, 5, 10, custom) with a preview before generation.
 */
const INVITE_ROLE_SELECT_ID = 'invite-join-role';

function InviteCard({ campaignId }: { campaignId: number }) {
  const { t } = useTranslation();
  const campaign = useCampaign(campaignId);
  const { refresh: refreshCampaigns } = useCampaigns();
  const [invites, setInvites] = useState<CampaignInvite[]>([]);
  const [role, setRole] = useState<InviteRole>('player');
  const [expiryPreset, setExpiryPreset] = useState<ExpiryPreset>('7d');
  const [customDate, setCustomDate] = useState('');
  const [maxUsesPreset, setMaxUsesPreset] = useState<MaxUsesPreset>('unlimited');
  const [customMaxUses, setCustomMaxUses] = useState('');
  const [creating, setCreating] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const announce = useAnnounce();
  const invitesEnabled = campaign?.publicInvitesEnabled !== false;
  const canCreate = invitesEnabled && campaign?.status === 'active';

  const load = useCallback(async () => {
    try {
      setInvites(await api.get<CampaignInvite[]>(`${API}/campaigns/${campaignId}/invites`));
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const expiresInDays = computeExpiryDays(expiryPreset, customDate);
      const maxUses = computeMaxUses(maxUsesPreset, customMaxUses);
      await api.post<CampaignInvite>(`${API}/campaigns/${campaignId}/invites`, {
        role,
        expiresInDays,
        ...(maxUses != null ? { maxUses } : {}),
      });
      await load();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    } finally {
      setCreating(false);
    }
  }

  async function reactivate() {
    setReactivating(true);
    setError(null);
    try {
      await api.put(`${API}/campaigns/${campaignId}/invites/policy`, { enabled: true });
      await refreshCampaigns();
      announce('Public invites re-enabled.');
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    } finally {
      setReactivating(false);
    }
  }

  async function revoke(inviteId: number) {
    setError(null);
    try {
      await api.delete(`${API}/campaigns/${campaignId}/invites/${inviteId}`);
      await load();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    }
  }

  // Minimum date for custom picker: tomorrow
  const minDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  // Maximum date: 365 days from now
  const maxDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  return (
    <Card id="invite" className="space-y-2.5" data-testid="invite-card">
      <p className="card-kicker mb-0">Invite</p>

      {!invitesEnabled && (
        <div
          data-testid="invites-suspended-banner"
          className="cf-inset border-amber-600/40 rounded px-3 py-2.5 space-y-1.5"
        >
          <p className="text-[12px] text-amber-200 m-0">
            Public invites are suspended — outstanding join links return as invalid until you re-enable them.
            Archiving or trashing a campaign suspends invites automatically; restore does not revive them.
          </p>
          <button
            className="btn btn-primary"
            style={{ minHeight: 32, fontSize: 12.5 }}
            disabled={reactivating || campaign?.status !== 'active'}
            aria-busy={reactivating || undefined}
            onClick={() => void reactivate()}
          >
            {reactivating ? 'Re-enabling…' : 'Re-enable invites'}
          </button>
          {campaign?.status !== 'active' && (
            <p className="text-muted text-[11px] m-0">Unarchive the campaign before re-enabling invites.</p>
          )}
        </div>
      )}

      {/* Role */}
      <div className="flex gap-2 flex-wrap items-end">
        <div className="field" style={{ minWidth: 110 }}>
          <label htmlFor={INVITE_ROLE_SELECT_ID}>Joins as</label>
          <select
            id={INVITE_ROLE_SELECT_ID}
            className="input"
            value={role}
            onChange={(e) => setRole(e.target.value as InviteRole)}
            disabled={!canCreate}
          >
            {inviteRoleOptions().map((opt) => (
              <option key={opt.role} value={opt.role}>
                {opt.description}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Expiry */}
      <div className="field">
        <label htmlFor="invite-expiry">Link expires</label>
        <select
          id="invite-expiry"
          className="input"
          style={{ maxWidth: 220 }}
          value={expiryPreset}
          onChange={(e) => setExpiryPreset(e.target.value as ExpiryPreset)}
          disabled={!canCreate}
        >
          <option value="end-of-today">End of today</option>
          <option value="24h">24 hours</option>
          <option value="7d">7 days</option>
          <option value="30d">30 days</option>
          <option value="custom">Custom…</option>
        </select>
        {expiryPreset === 'custom' && (
          <input
            type="date"
            className="input mt-1.5"
            style={{ maxWidth: 200 }}
            aria-label="Custom expiry date"
            min={minDate}
            max={maxDate}
            value={customDate}
            onChange={(e) => setCustomDate(e.target.value)}
            disabled={!canCreate}
          />
        )}
      </div>

      {/* Max uses */}
      <div className="field">
        <label htmlFor="invite-max-uses">Maximum uses</label>
        <select
          id="invite-max-uses"
          className="input"
          style={{ maxWidth: 220 }}
          value={maxUsesPreset}
          onChange={(e) => setMaxUsesPreset(e.target.value as MaxUsesPreset)}
          disabled={!canCreate}
        >
          <option value="unlimited">Unlimited</option>
          <option value="1">1 use</option>
          <option value="5">5 uses</option>
          <option value="10">10 uses</option>
          <option value="custom">Custom…</option>
        </select>
        {maxUsesPreset === 'custom' && (
          <input
            type="number"
            className="input mt-1.5"
            style={{ maxWidth: 120 }}
            aria-label="Custom max uses"
            min={1}
            max={1000}
            value={customMaxUses}
            onChange={(e) => setCustomMaxUses(e.target.value)}
            disabled={!canCreate}
          />
        )}
      </div>

      {/* Event recommendation badge */}
      {isEventPreset(expiryPreset, maxUsesPreset) && (
        <p className="text-[11px] text-emerald-400 m-0" data-testid="event-recommendation">
          ✓ Recommended for events — short-lived and seat-limited
        </p>
      )}

      {/* Preview section */}
      <div
        className="cf-inset border-slate-600/40 rounded px-3 py-2.5 space-y-1"
        aria-label="Invite preview"
        data-testid="invite-preview"
      >
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest m-0">Preview</p>
        <p className="text-[12px] text-slate-300 m-0">
          <span className="text-secondary">Role:</span>{' '}
          <span className={`cf-chip ${ROLE_CHIP[role]}`}>{ROLE_LABEL[role]}</span>
        </p>
        <p className="text-[12px] text-slate-300 m-0">
          <span className="text-secondary">Expires:</span> {describeExpiry(expiryPreset, customDate)}
        </p>
        <p className="text-[12px] text-slate-300 m-0">
          <span className="text-secondary">Max admissions:</span> {describeMaxUses(maxUsesPreset, customMaxUses)}
        </p>
        <p className="text-[11px] text-amber-400/80 m-0 mt-1.5">
          ⚠ Anyone with this link can join — treat it like a password.
        </p>
      </div>

      <button className="btn btn-primary" style={{ minHeight: 36 }} onClick={create} disabled={creating || !canCreate}>
        {creating ? 'Generating…' : 'Generate invite link'}
      </button>

      {/* Copy failures are already announced via the polite live region
          (CopyControl → useAnnounce); giving this paragraph role="alert" too
          would announce the same message a second time, assertively.
          Create/revoke failures have no other announcement path, so they keep
          role="alert" here. */}
      {error && (
        <p
          className="text-xs text-rose-400 m-0"
          role={error === INVITE_COPY_FAILURE ? undefined : 'alert'}
        >
          {error}
        </p>
      )}

      {/* Live invite links */}
      {invites.map((invite) => {
        const linkFieldId = `invite-link-${invite.id}`;
        return (
        <div key={invite.id} className="space-y-2" data-testid="invite-row">
          <div className="flex gap-2 flex-wrap items-center">
            <div className="field !mb-0" style={{ flex: 1, minWidth: 190 }}>
              <label className="sr-only" htmlFor={linkFieldId}>
                {inviteLinkFieldLabel(invite.role, invite.id)}
              </label>
              <input
                id={linkFieldId}
                className="input"
                style={{ width: '100%' }}
                readOnly
                aria-readonly="true"
                value={inviteLinkFor(invite.code)}
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
            <span className={`cf-chip ${ROLE_CHIP[invite.role]}`}>{ROLE_LABEL[invite.role]}</span>
            <span className="text-muted text-[11px] whitespace-nowrap" data-testid="invite-status">
              {expiresIn(invite.expiresAt)}
              {invite.maxUses != null
                ? ` · ${invite.maxUses - invite.useCount} of ${invite.maxUses} remaining`
                : ` · used ${invite.useCount}×`}
            </span>
            <CopyControl
              text={inviteLinkFor(invite.code)}
              selectTargetId={linkFieldId}
              label="Copy link"
              aria-label={inviteCopyButtonLabel(invite.role, invite.id)}
              successAnnouncement={INVITE_COPY_SUCCESS}
              failureAnnouncement={INVITE_COPY_FAILURE}
              // Card-level error paragraph owns the visible failure copy (and the
              // #516 e2e assertion); skip the control's inline failure line.
              showFailureMessage={false}
              unstyled
              className="btn btn-primary"
              style={{ minHeight: 36 }}
              onResult={(outcome) => {
                // `error` is shared across create/revoke/copy for this card, so
                // only clear it on success if it's the copy-failure message —
                // otherwise a successful copy could silently dismiss an unrelated
                // create/revoke failure that's still unresolved.
                if (outcome.ok) {
                  setError((current) => (current === INVITE_COPY_FAILURE ? null : current));
                } else {
                  setError(INVITE_COPY_FAILURE);
                }
              }}
            />
            <button className="btn btn-ghost" style={{ minHeight: 36, fontSize: 12.5 }} onClick={() => revoke(invite.id)}>
              Revoke
            </button>
          </div>
          <InviteQrCard invite={invite} scannable={invitesEnabled} />
        </div>
        );
      })}

      <p className="text-muted text-[11.5px] m-0">
        Anyone with a link creates their own account (or signs in) and joins as the chosen role — no server
        admin needed. Revoke a link any time if it leaks.
      </p>
    </Card>
  );
}

type GrantDurationPreset = '2h' | '24h' | '7d';

function grantExpiryForPreset(preset: GrantDurationPreset): string {
  const ms =
    preset === '2h'
      ? 2 * 60 * 60 * 1000
      : preset === '24h'
        ? 24 * 60 * 60 * 1000
        : 7 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ms).toISOString();
}

function grantStatus(grant: GuestDmGrant): 'active' | 'upcoming' | 'expired' | 'revoked' | 'handed back' {
  if (grant.revokedAt) return 'revoked';
  if (grant.handedBackAt) return 'handed back';
  const now = Date.now();
  if (new Date(grant.startsAt).getTime() > now) return 'upcoming';
  if (new Date(grant.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}

function GuestDmGrantsCard({
  campaignId,
  members,
  grants,
  loading,
  error,
  onRetry,
  onChange,
}: {
  campaignId: number;
  members: CampaignMember[];
  grants: GuestDmGrant[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const eligibleMembers = members.filter((member) => !member.disabled);
  const [selectedUserId, setSelectedUserId] = useState<number | ''>('');
  const [duration, setDuration] = useState<GrantDurationPreset>('2h');
  const [scopes, setScopes] = useState<GuestDmGrantScope[]>(['dm']);
  const [creating, setCreating] = useState(false);
  const [mutatingGrantId, setMutatingGrantId] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const selectedMember = selectedUserId === '' ? null : members.find((member) => member.userId === selectedUserId) ?? null;
  const previewExpiry = grantExpiryForPreset(duration);
  const safeDefault = scopes.includes('dm') && !scopes.includes('membership_admin') && !scopes.includes('destructive');

  function toggleScope(scope: GuestDmGrantScope, checked: boolean) {
    setScopes((current) => {
      const next = checked ? [...new Set([...current, scope])] : current.filter((s) => s !== scope);
      return next.length > 0 ? next : ['dm'];
    });
  }

  async function createGrant() {
    if (selectedUserId === '') return;
    setCreating(true);
    setLocalError(null);
    try {
      await api.post<GuestDmGrant>(`${API}/campaigns/${campaignId}/members/grants`, {
        granteeUserId: selectedUserId,
        scopes,
        expiresAt: grantExpiryForPreset(duration),
      });
      announce(`Temporary DM grant created for ${selectedMember ? memberDisplayName(selectedMember) : 'member'}.`);
      setSelectedUserId('');
      setScopes(['dm']);
      setDuration('2h');
      onChange();
    } catch (err) {
      const msg = translateApiError(err, t, { fallbackKey: 'errors.loadFailed' });
      setLocalError(msg);
      announce(msg, { assertive: true });
    } finally {
      setCreating(false);
    }
  }

  async function revokeGrant(grantId: number) {
    setMutatingGrantId(grantId);
    setLocalError(null);
    try {
      await api.post<GuestDmGrant>(`${API}/campaigns/${campaignId}/members/grants/${grantId}/revoke`, {});
      announce('Temporary DM grant revoked.');
      onChange();
    } catch (err) {
      const msg = translateApiError(err, t, { fallbackKey: 'errors.loadFailed' });
      setLocalError(msg);
      announce(msg, { assertive: true });
    } finally {
      setMutatingGrantId(null);
    }
  }

  return (
    <Card className="space-y-2.5" data-testid="guest-dm-grants-card">
      <div className="flex items-center gap-2">
        <p className="card-kicker mb-0">Temporary DM handoff</p>
        {loading && !error && <span className="text-[11px] text-secondary">Loading grants…</span>}
      </div>
      <p className="text-muted text-[11.5px] m-0">
        Give a trusted guest limited DM authority for a session. The default scope can run play and read DM-only
        prep, but cannot manage members, demote the protected owner, or trash/purge the campaign.
      </p>
      {(error || localError) && <ErrorNote message={error ?? localError ?? ''} onRetry={error ? onRetry : undefined} />}

      <div className="cf-inset border-slate-600/40 rounded px-3 py-2.5 space-y-2">
        <div className="grid sm:grid-cols-2 gap-2">
          <div className="field">
            <label htmlFor="guest-dm-member">Member</label>
            <select
              id="guest-dm-member"
              className="input"
              value={selectedUserId}
              onChange={(event) => setSelectedUserId(event.target.value ? Number(event.target.value) : '')}
            >
              <option value="">Choose a member…</option>
              {eligibleMembers.map((member) => (
                <option key={member.id} value={member.userId}>
                  {memberDisplayName(member)}{member.primaryOwner ? ' (protected owner)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="guest-dm-duration">Expires</label>
            <select
              id="guest-dm-duration"
              className="input"
              value={duration}
              onChange={(event) => setDuration(event.target.value as GrantDurationPreset)}
            >
              <option value="2h">In 2 hours</option>
              <option value="24h">In 24 hours</option>
              <option value="7d">In 7 days</option>
            </select>
          </div>
        </div>

        <fieldset className="space-y-1">
          <legend className="text-[10px] font-bold uppercase tracking-wide text-secondary">Scopes</legend>
          {(['dm', 'membership_admin', 'destructive'] as GuestDmGrantScope[]).map((scope) => (
            <label key={scope} className="flex items-center gap-2 text-[12px] text-slate-300">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(event) => toggleScope(scope, event.target.checked)}
              />
              <span>{GRANT_SCOPE_LABEL[scope]}</span>
            </label>
          ))}
        </fieldset>

        <div className="cf-inset border-amber-500/25 rounded px-3 py-2 space-y-1" aria-label="Guest DM grant preview">
          <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest m-0">Preview</p>
          <p className="text-[12px] text-slate-300 m-0">
            {selectedMember ? memberDisplayName(selectedMember) : 'Selected member'} receives {scopes.map((scope) => GRANT_SCOPE_LABEL[scope]).join(', ')}
            {' '}until {formatDateTime(previewExpiry)}.
          </p>
          <p className={`text-[11px] m-0 ${safeDefault ? 'text-emerald-400' : 'text-amber-300'}`}>
            {safeDefault
              ? 'Safe default: membership admin and destructive actions stay excluded.'
              : 'Elevated scopes selected: use only for trusted co-DMs.'}
          </p>
        </div>

        <Btn density="xs" className="text-xs" onClick={createGrant} disabled={creating || selectedUserId === ''}>
          {creating ? 'Granting…' : 'Grant temporary DM'}
        </Btn>
      </div>

      <div className="space-y-1.5">
        {grants.length === 0 ? (
          <p className="text-muted text-[11px] m-0">No temporary DM grants yet.</p>
        ) : (
          grants.map((grant) => {
            const status = grantStatus(grant);
            const activeOrUpcoming = status === 'active' || status === 'upcoming';
            return (
              <div key={grant.id} className="flex items-center gap-2 flex-wrap text-[12px] border-t border-slate-800 pt-2">
                <span className="font-semibold text-white">{grant.displayName || grant.username || `User ${grant.granteeUserId}`}</span>
                <span className="text-secondary">{status}</span>
                <span className="text-muted">until {formatDateTime(grant.expiresAt)}</span>
                <span className="text-muted">{grant.scopes.map((scope) => GRANT_SCOPE_LABEL[scope]).join(', ')}</span>
                {activeOrUpcoming && (
                  <button
                    type="button"
                    className="text-[12px] text-secondary hover:text-rose-400 ml-auto"
                    disabled={mutatingGrantId === grant.id}
                    onClick={() => void revokeGrant(grant.id)}
                  >
                    {mutatingGrantId === grant.id ? 'Revoking…' : 'Revoke'}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}

function ReadOnlyMemberTable({ members }: { members: CampaignMember[] }) {
  const { t } = useTranslation();
  if (members.length === 0) return <EmptyState icon="shield" title={t('admin.empty.noMembers')} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase text-secondary text-left">
            <th className="py-2 pr-4 font-bold">User</th>
            <th className="pr-4 font-bold">Role</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {members.map((m) => (
            <tr key={m.id}>
              <td className="py-2.5 pr-4">
                <span className="font-semibold text-white">{m.displayName || m.username}</span>
                {m.disabled && <span className="ml-2 text-[10px] text-rose-400">disabled</span>}
              </td>
              <td className="pr-4">
                <span className={`cf-chip ${ROLE_CHIP[m.role]}`}>{ROLE_LABEL[m.role]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Player data rights (issue #128): a member's own controls on the campaign they
 * can see but not administer — export THEIR OWN data (characters/notes/proposals),
 * and leave the campaign themselves. Distinct from the DM's campaign-wide export
 * (settings page, dm-only) and the DM's remove-member control above.
 */
/**
 * Issue #501: a member's OWN consent for external AI use of the source notes they wrote.
 *
 * Rendered for every member, DM included — a DM authors inbox notes too, and consent is
 * a member-level decision, not a role privilege. Nobody can widen anyone else's consent;
 * this is the only writer, and it PATCHes `members/me/ai-consent`.
 */
function AiConsentCard({
  campaignId,
  members,
  myUserId,
  onChange,
}: {
  campaignId: number;
  members: CampaignMember[];
  myUserId: number | null;
  /**
   * Refetch the shared member list. MUST be awaitable: the optimistic `pending` value is
   * held until the refreshed `members` prop has actually arrived, otherwise the checkbox
   * flickers next → old → next (see `save`).
   */
  onChange: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const myMember = myUserId != null ? members.find((m) => m.userId === myUserId) : undefined;
  // Server value is the single source of truth while idle; during an in-flight save the
  // pending value wins so a concurrent list refresh cannot flicker the checkbox back.
  const [pending, setPending] = useState<boolean | null>(null);
  const checked = pending ?? myMember?.aiExternalUseConsent ?? false;

  if (!myMember) return null;

  async function save(next: boolean) {
    setSaving(true);
    setError(null);
    setPending(next);
    try {
      await api.patch<CampaignMember>(`${API}/campaigns/${campaignId}/members/me/ai-consent`, {
        aiExternalUseConsent: next,
      });
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
      // The write failed, so the server value is still authoritative — drop the optimistic
      // value immediately and let the checkbox snap back to what is actually stored.
      setPending(null);
      setSaving(false);
      return;
    }

    // Saved. Refetch the shared list so the DM-facing consent chip is not stale, and AWAIT
    // it: clearing `pending` before the refreshed `members` prop arrives would let `checked`
    // fall back to the stale prop for a frame — the exact next → old → next flicker the
    // pending value exists to prevent.
    try {
      await onChange();
    } catch {
      // The refresh is best-effort; the consent write itself already succeeded, so this
      // must not revert the checkbox or surface as a save error.
    }
    setPending(null);
    setSaving(false);
  }

  return (
    <Card className="space-y-2.5" data-testid="ai-consent-card">
      <p className="card-kicker mb-0">External AI use of your notes</p>
      <label className="flex items-start gap-2 cursor-pointer cf-inset p-3">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={checked}
          disabled={saving}
          onChange={(event) => void save(event.target.checked)}
        />
        <span>
          <span className="block text-[12.5px] font-semibold text-white">
            Allow external AI use of my authored source notes
          </span>
          <span className="block text-[11px] text-secondary">
            When the campaign policy permits external AI, the scribe may include resolved inbox notes you authored and
            shared with the DM or the party. Private and whisper notes are never sent, and opting out again stops your
            notes being included in future runs.
          </span>
        </span>
      </label>
      {error && <p className="text-xs text-rose-400 m-0">{error}</p>}
    </Card>
  );
}

function YourMembershipCard({
  campaignId,
  members,
  myUserId,
}: {
  campaignId: number;
  members: CampaignMember[];
  myUserId: number | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { refresh: refreshCampaigns } = useCampaigns();
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewManifest, setPreviewManifest] = useState<any>(null);

  useEffect(() => {
    let active = true;
    api.get(`${API}/campaigns/${campaignId}/export/me/preview`)
      .then((res: any) => {
        if (active) setPreviewManifest(res.manifest);
      })
      .catch((err) => {
        console.error('Failed to load export preview:', err);
      });
    return () => { active = false; };
  }, [campaignId]);

  const myMember = myUserId != null ? members.find((m) => m.userId === myUserId) : undefined;
  if (!myMember) return null;

  async function leave() {
    if (!myMember) return;
    setLeaving(true);
    setError(null);
    try {
      await api.delete(`${API}/campaigns/${campaignId}/members/${myMember.id}`);
      await refreshCampaigns();
      navigate('/');
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
      setLeaving(false);
      setConfirming(false);
    }
  }

  return (
    <Card className="space-y-2.5" data-testid="your-membership-card">
      <p className="card-kicker mb-0">{t('nav.yourData')}</p>
      <p className="text-muted text-[11.5px] m-0">
        Take a copy of what's yours, or leave the table. Your export includes only the characters you own, the
        notes you wrote and the proposals you submitted — not the DM's secrets or anyone else's private data.
      </p>
      {error && <p className="text-xs text-rose-400 m-0">{error}</p>}
      
      {previewManifest && (
        <div className="bg-gray-800/50 p-2 rounded text-[11px] text-muted space-y-1">
          <p className="m-0 font-medium text-gray-300">Data included in your export:</p>
          <ul className="m-0 pl-4 list-disc">
            <li>Characters: {previewManifest.counts.characters}</li>
            <li>Notes: {previewManifest.counts.notes}</li>
            <li>Comments & replies: {previewManifest.counts.comments}</li>
            <li>Proposals: {previewManifest.counts.proposals}</li>
            <li>RSVPs: {previewManifest.counts.rsvps}</li>
            <li>Dice rolls: {previewManifest.counts.diceRolls} (subject to retention limits)</li>
            <li>Revisions: {previewManifest.counts.revisions}</li>
            <li>Audit actions: {previewManifest.counts.auditActions}</li>
          </ul>
          <p className="m-0 mt-1 italic">{previewManifest.excludedReason}</p>
        </div>
      )}

      <div className="flex gap-2 flex-wrap items-center">
        <a
          className="btn btn-secondary"
          style={{ fontSize: 12.5 }}
          href={`${API}/campaigns/${campaignId}/export/me`}
        >
          ⬇ Export my data
        </a>
        <button
          type="button"
          className="btn btn-ghost btn-danger"
          style={{ fontSize: 12.5 }}
          onClick={() => setConfirming(true)}
        >
          Leave campaign…
        </button>
      </div>
      <p className="text-muted text-[11px] m-0">
        Leaving closes your seat. Character sheets you own stay with the campaign (they're just un-owned); your
        notes stay too. A sole DM must hand off DM before leaving.
      </p>
      {confirming && (
        <ConfirmDialog
          title="Leave this campaign?"
          body="You'll lose access to it. Export your data first if you want a copy."
          confirmLabel="Leave"
          busy={leaving}
          onConfirm={leave}
          onCancel={() => setConfirming(false)}
        />
      )}
    </Card>
  );
}

function MembersCard({
  campaignId,
  members,
  characters,
  charactersLoading,
  charactersError,
  onRetryCharacters,
  onChange,
}: {
  campaignId: number;
  members: CampaignMember[];
  characters: Character[];
  charactersLoading: boolean;
  charactersError: string | null;
  onRetryCharacters: () => void;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  // A failed character roster reads as an empty list. Without this flag the
  // per-member character select would still render (with only "— unlinked —"),
  // and a DM could silently unlink a member from its character by saving the
  // "empty" selection. We block the select entirely while the roster is
  // unavailable so a failed load can never clear an assignment (#697 review).
  const charactersUnavailable = !!charactersError;
  const { open: showAdd, setOpen: setShowAdd, buttonProps: addMemberButtonProps } = useDisclosure({
    id: 'add-member-dialog',
    regionLabel: 'Add a campaign member',
  });
  const [error, setError] = useState<string | null>(null);
  const linkHelpId = useId();

  return (
    <Card className="space-y-2.5" data-testid="members-card">
      <div className="flex items-center gap-2">
        <p className="card-kicker mb-0">Members</p>
        <Btn density="xs" className="text-xs ml-auto" {...addMemberButtonProps}>
          + Add member
        </Btn>
      </div>

      {error && (
        <p className="text-xs text-rose-400" role="alert">
          {error}
        </p>
      )}

      {showAdd && (
        <AddMemberForm
          campaignId={campaignId}
          existingUserIds={members.map((m) => m.userId)}
          onCancel={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            onChange();
          }}
          onError={setError}
        />
      )}

      {/* Character roster is auxiliary (#697): if it fails to load, the roster still
          renders; linking is just unavailable until retry succeeds. */}
      {charactersError && (
        <ErrorNote message={charactersError} onRetry={onRetryCharacters} />
      )}

      {members.length === 0 ? (
        <EmptyState icon="shield" title={t('admin.empty.noMembers')} hint={t('admin.empty.noMembersHint')} />
      ) : (
        <div className="flex flex-col" data-testid="members-rows">
          {members.map((m) => (
            <MemberRow
              key={m.id}
              campaignId={campaignId}
              member={m}
              members={members}
              characters={characters}
              charactersLoading={charactersLoading}
              charactersUnavailable={charactersUnavailable}
              characterLinkHelpId={linkHelpId}
              onChange={onChange}
              onError={setError}
            />
          ))}
        </div>
      )}
      <p id={linkHelpId} className="text-[11px] text-secondary">
        {MEMBER_CHARACTER_LINK_HELP}
      </p>
    </Card>
  );
}

function MemberRow({
  campaignId,
  member,
  members,
  characters,
  charactersLoading,
  charactersUnavailable,
  characterLinkHelpId,
  onChange,
  onError,
}: {
  campaignId: number;
  member: CampaignMember;
  members: CampaignMember[];
  characters: Character[];
  charactersLoading: boolean;
  charactersUnavailable: boolean;
  characterLinkHelpId: string;
  onChange: () => void;
  onError: (msg: string | null) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const [savingRole, setSavingRole] = useState(false);
  const [savingGuest, setSavingGuest] = useState(false);
  const [savingChar, setSavingChar] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [pendingTransfer, setPendingTransfer] = useState<{
    characterId: number;
    characterName: string;
    fromName: string;
  } | null>(null);
  const name = memberDisplayName(member);

  async function changeRole(role: Role) {
    setSavingRole(true);
    onError(null);
    try {
      await api.patch(`${API}/campaigns/${campaignId}/members/${member.id}`, { role });
      announce(memberRoleSavedAnnouncement(name, ROLE_LABEL[role]));
      onChange();
    } catch (err) {
      const msg = translateApiError(err, t, { fallbackKey: 'errors.loadFailed' });
      onError(msg);
      announce(msg, { assertive: true });
    } finally {
      setSavingRole(false);
    }
  }

  /**
   * Issue #597: grant / revoke the interactive-guest capability on a viewer seat.
   * Only rendered for a viewer, because it is only CONSULTED for a viewer — a player
   * or DM is interactive by role, and showing a dead toggle beside them would imply
   * the flag means something there.
   */
  async function changeInteractiveGuest(next: boolean) {
    setSavingGuest(true);
    onError(null);
    try {
      await api.patch(`${API}/campaigns/${campaignId}/members/${member.id}`, { interactiveGuest: next });
      announce(
        next
          ? `${name} can now take part in discussion as an interactive guest.`
          : `${name} is now a read-only viewer.`,
      );
      onChange();
    } catch (err) {
      const msg = translateApiError(err, t, { fallbackKey: 'errors.loadFailed' });
      onError(msg);
      announce(msg, { assertive: true });
    } finally {
      setSavingGuest(false);
    }
  }

  async function changeCharacter(characterId: number | null, confirmTransfer = false) {
    setSavingChar(true);
    onError(null);
    try {
      await api.patch(`${API}/campaigns/${campaignId}/members/${member.id}`, {
        characterId,
        ...(confirmTransfer ? { confirmTransfer: true } : {}),
      });
      const linkedName = characterId != null ? characters.find((c) => c.id === characterId)?.name ?? null : null;
      announce(memberCharacterSavedAnnouncement(name, linkedName));
      setPendingTransfer(null);
      onChange();
    } catch (err) {
      // Server-enforced exclusive seat (issue #819): open the transfer confirm when
      // the DM skipped the local check (stale roster) or raced another assignment.
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.code === 'CHARACTER_SEAT_TAKEN' &&
        characterId != null &&
        !confirmTransfer
      ) {
        const char = characters.find((c) => c.id === characterId);
        const holder = members.find((m) => m.id !== member.id && m.characterId === characterId);
        setPendingTransfer({
          characterId,
          characterName: char?.name ?? `Character ${characterId}`,
          fromName: holder ? memberDisplayName(holder) : 'another member',
        });
        return;
      }
      const msg = translateApiError(err, t, { fallbackKey: 'errors.loadFailed' });
      onError(msg);
      announce(msg, { assertive: true });
      setPendingTransfer(null);
    } finally {
      setSavingChar(false);
    }
  }

  function requestCharacterChange(nextCharacterId: number | null) {
    if (nextCharacterId == null) {
      void changeCharacter(null);
      return;
    }
    const seatHolder = members.find((m) => m.id !== member.id && m.characterId === nextCharacterId);
    const char = characters.find((c) => c.id === nextCharacterId);
    const ownerHolder =
      !seatHolder && char?.ownerUserId != null && char.ownerUserId !== String(member.userId)
        ? members.find((m) => String(m.userId) === char.ownerUserId) ?? null
        : null;
    const from = seatHolder ?? ownerHolder;
    if (from || (char?.ownerUserId != null && char.ownerUserId !== String(member.userId) && !seatHolder)) {
      setPendingTransfer({
        characterId: nextCharacterId,
        characterName: char?.name ?? `Character ${nextCharacterId}`,
        fromName: from ? memberDisplayName(from) : 'another member',
      });
      return;
    }
    void changeCharacter(nextCharacterId);
  }

  async function remove() {
    setRemoving(true);
    onError(null);
    try {
      await api.delete(`${API}/campaigns/${campaignId}/members/${member.id}`);
      setConfirmingRemove(false);
      onChange();
    } catch (err) {
      const msg = translateApiError(err, t, { fallbackKey: 'errors.loadFailed' });
      onError(msg);
      announce(msg, { assertive: true });
    } finally {
      setRemoving(false);
    }
  }

  // Two fields can describe "who plays this character": the membership pointer
  // (campaignMembers.characterId) and character ownership (characters.ownerUserId).
  // Ownership is authoritative app-wide — it drives edit rights, inventory and
  // encounters, and it's what the character sheet's "played by …" shows. The
  // membership pointer is normally kept in sync, but a direct DM ownerUserId change
  // (PATCH /characters/:id) leaves it stale, which read as a contradiction (issue
  // #274): sheet says "played by Pete" while Members said "— unlinked —". Fall back
  // to the owned character so both surfaces agree. Exclusive-seat assignment (#819)
  // prevents two membership rows from claiming the same characterId.
  const linkedCharacter = characters.find((c) => c.id === member.characterId);
  const ownedCharacter = characters.find(
    (c) => c.ownerUserId != null && c.ownerUserId === String(member.userId),
  );
  const character = linkedCharacter ?? ownedCharacter;

  return (
    <div
      className="flex items-center gap-2.5 py-2.5 flex-wrap"
      style={{ borderTop: '1px solid var(--color-divider)' }}
      data-testid={`member-row-${member.id}`}
    >
      <span className="h-8 w-8 shrink-0 rounded-full bg-[var(--color-neutral-900)] border border-[var(--color-divider)] flex items-center justify-center text-[12px] text-[var(--color-neutral-300)]">
        {firstGrapheme(member.displayName || member.username || '?')}
      </span>
      <div className="min-w-0">
        <p className="text-[13.5px] m-0 flex items-center gap-1.5">
          {member.displayName || member.username}
          {member.primaryOwner && <span className="text-[10px] text-amber-300">protected owner</span>}
          {member.disabled && <span className="text-[10px] text-rose-400">disabled</span>}
          <span
            className={`text-[10px] ${member.aiExternalUseConsent ? 'text-emerald-300' : 'text-secondary'}`}
            title="Member-controlled consent for external AI use of their authored source notes"
          >
            AI source {member.aiExternalUseConsent ? 'allowed' : 'opted out'}
          </span>
        </p>
        <p className="text-muted text-[11px] m-0">{character?.name || 'no character linked'}</p>
      </div>
      <div className="flex-1" />
      <select
        className="cf-select text-xs cf-density-xs"
        style={{ width: 96 }}
        value={member.role}
        disabled={savingRole || member.primaryOwner}
        aria-label={memberRoleControlLabel(name)}
        title={member.primaryOwner ? 'Protected campaign owner cannot be demoted.' : undefined}
        onChange={(e) => changeRole(e.target.value as Role)}
      >
        <option value="dm" disabled={member.disabled}>dm</option>
        <option value="player">player</option>
        <option value="viewer">viewer</option>
      </select>
      {member.role === 'viewer' && (
        <label
          className="flex items-center gap-1.5 text-[11px] text-secondary"
          title={
            'Issue #597: a viewer seat is read-only by default — no comments, shared notes, whispers, or DM-inbox ' +
            'posts. Grant this to let a non-player take part in discussion without giving them authority over ' +
            'campaign content.'
          }
        >
          <input
            type="checkbox"
            checked={member.interactiveGuest}
            disabled={savingGuest}
            aria-label={`Interactive guest for ${name}`}
            onChange={(e) => void changeInteractiveGuest(e.target.checked)}
          />
          interactive guest
        </label>
      )}
      <select
        className="cf-select text-xs cf-density-xs"
        style={{ width: 130 }}
        value={character?.id ?? ''}
        disabled={savingChar || charactersLoading || charactersUnavailable || !!pendingTransfer}
        aria-label={memberCharacterControlLabel(name)}
        aria-describedby={characterLinkHelpId}
        title={
          charactersUnavailable
            ? "Character roster didn't load — retry above before changing links."
            : MEMBER_CHARACTER_LINK_HELP
        }
        onChange={(e) => requestCharacterChange(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">— unlinked —</option>
        {characters.map((c) => {
          const holder = members.find((m) => m.id !== member.id && m.characterId === c.id);
          return (
            <option key={c.id} value={c.id}>
              {memberCharacterOptionLabel(c.name, holder ? memberDisplayName(holder) : null)}
            </option>
          );
        })}
      </select>
      <button
        type="button"
        className="text-[12px] text-secondary hover:text-rose-400"
        aria-label={memberRemoveLabel(name)}
        disabled={member.primaryOwner}
        title={member.primaryOwner ? 'Protected campaign owner cannot be removed.' : undefined}
        onClick={() => setConfirmingRemove(true)}
      >
        Remove
      </button>
      {confirmingRemove && (
        <ConfirmDialog
          title={`Remove ${member.displayName || member.username} from this campaign?`}
          confirmLabel="Remove"
          busy={removing}
          onConfirm={remove}
          onCancel={() => setConfirmingRemove(false)}
        />
      )}
      {pendingTransfer && (
        <ConfirmDialog
          title={memberCharacterTransferTitle(pendingTransfer.characterName, pendingTransfer.fromName, name)}
          body={MEMBER_CHARACTER_TRANSFER_BODY}
          confirmLabel={MEMBER_CHARACTER_TRANSFER_CONFIRM_LABEL}
          busy={savingChar}
          onConfirm={() => void changeCharacter(pendingTransfer.characterId, true)}
          onCancel={() => setPendingTransfer(null)}
        />
      )}
    </div>
  );
}

interface LookupUser {
  id: number;
  username: string;
  displayName: string;
}

function AddMemberForm({
  campaignId,
  existingUserIds,
  onCancel,
  onAdded,
  onError,
}: {
  campaignId: number;
  existingUserIds: number[];
  onCancel: () => void;
  onAdded: () => void;
  onError: (msg: string | null) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LookupUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<LookupUser | null>(null);
  const [role, setRole] = useState<Role>('player');
  const [saving, setSaving] = useState(false);
  const idPrefix = useId();
  const titleId = `${idPrefix}-title`;
  const descriptionId = `${idPrefix}-description`;
  const searchId = `${idPrefix}-search`;
  const roleId = `${idPrefix}-role`;
  const roleHelpId = `${idPrefix}-role-help`;
  // Safe default: initial focus on Cancel (issue #451 — ambiguous Cancel focus).
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialog<HTMLDivElement>({
    onClose: onCancel,
    disabled: saving,
    initialFocusRef: cancelRef,
  });

  useEffect(() => {
    if (selected) return; // don't re-search after picking
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const found = await api.get<LookupUser[]>(`${API}/users/lookup?query=${encodeURIComponent(q)}`);
        setResults(found.filter((u) => !existingUserIds.includes(u.id)));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [query, selected, existingUserIds]);

  async function add() {
    if (!selected) return;
    setSaving(true);
    onError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/members`, { userId: selected.id, role });
      announce(memberAddedAnnouncement(memberDisplayName(selected), ROLE_LABEL[role]));
      onAdded();
    } catch (err) {
      const msg = translateApiError(err, t, { fallbackKey: 'errors.loadFailed' });
      onError(msg);
      announce(msg, { assertive: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      ref={dialogRef}
      id="add-member-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="add-member-dialog"
      className="cf-inset border-amber-500/30 p-3.5 space-y-2"
    >
      <p id={titleId} className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">
        {ADD_MEMBER_DIALOG_TITLE}
      </p>
      <p id={descriptionId} className="text-[12px] text-amber-200/90 cf-inset !border-amber-500/20 px-2.5 py-2">
        Add someone who already has an account on this server by username. To bring in someone new, send them
        an invite link from the Invite card above instead.
      </p>
      {selected ? (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-sm text-white">
            {selected.displayName || selected.username} <span className="text-secondary">{selected.username}</span>
          </p>
          <button
            type="button"
            className="text-[11px] text-secondary hover:text-white"
            onClick={() => {
              setSelected(null);
              setQuery('');
            }}
          >
            change
          </button>
        </div>
      ) : (
        <div className="space-y-1">
          <label htmlFor={searchId} className="block text-[10px] font-bold uppercase tracking-wide text-secondary">
            {ADD_MEMBER_SEARCH_LABEL}
          </label>
          <TextInput density="xs"
            id={searchId}
            className="text-sm"
            placeholder="Search by username or display name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {searching && <p className="text-[11px] text-secondary">Searching…</p>}
          {!searching && query.trim().length >= 2 && results.length === 0 && (
            <p className="text-[11px] text-secondary">No matching users.</p>
          )}
          {results.length > 0 && (
            <ul className="cf-inset divide-y divide-slate-800" role="listbox" aria-label="Matching users">
              {results.map((u) => (
                <li key={u.id} role="option">
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-800/60"
                    onClick={() => setSelected(u)}
                  >
                    {u.displayName || u.username} <span className="text-secondary">{u.username}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="grid sm:grid-cols-3 gap-2">
        <div className="space-y-1">
          <label htmlFor={roleId} className="block text-[10px] font-bold uppercase tracking-wide text-secondary">
            {ADD_MEMBER_ROLE_LABEL}
          </label>
          <select
            id={roleId}
            className="cf-select text-sm cf-density-compact"
            value={role}
            aria-describedby={roleHelpId}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            <option value="dm">DM</option>
            <option value="player">Player</option>
            <option value="viewer">Viewer</option>
          </select>
          <p id={roleHelpId} className="text-[11px] text-secondary m-0">
            {ADD_MEMBER_ROLE_HELP}
          </p>
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <Btn density="xs"
          ref={cancelRef}
          ghost
          className="text-xs"
          onClick={onCancel}
          disabled={saving}
          aria-label={ADD_MEMBER_CANCEL_LABEL}
        >
          Cancel
        </Btn>
        <Btn density="xs" className="text-xs" onClick={add} disabled={saving || !selected}>
          Add
        </Btn>
      </div>
    </div>
  );
}

function AuditList({
  entries,
  members,
  campaignId,
  trashedTimelineEventIds,
}: {
  entries: AuditEntry[];
  members: CampaignMember[];
  campaignId: number;
  trashedTimelineEventIds: ReadonlySet<number> | null;
}) {
  const { t } = useTranslation();
  const preview = entries.slice(0, 10);
  if (entries.length === 0) return <EmptyState icon="scroll-unfurled" title={t('admin.empty.noActivity')} />;
  return (
    <div className="text-xs space-y-2 text-slate-400" role="list">
      {preview.map((e) => (
        <AuditEntryRow key={e.id} entry={e} members={members} trashedTimelineEventIds={trashedTimelineEventIds} />
      ))}
      {entries.length > preview.length && (
        <div className="text-[11px] text-secondary pt-1">
          <Link to={`/c/${campaignId}/audit`} className="hover:text-white">
            {entries.length - preview.length} more entries — open full audit log
          </Link>
        </div>
      )}
    </div>
  );
}
