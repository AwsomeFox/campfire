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
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  AiExternalContentPolicy,
  Campaign,
  CampaignCatalogPrivacySetting,
  CampaignCloneMode,
  CampaignClonePreview,
  CampaignExportRequest,
  CampaignExportRequestPage,
  CampaignInvite,
  CampaignStatusTransition,
  CastSession,
  CastSessionCreated,
  DangerLevel,
  ExportInventory,
  ExportProfile,
  RulePack,
} from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { adminRulesHref } from '../../lib/adminNavigation';
import { useCampaigns } from '../../app/CampaignContext';
import { Card, ErrorNote, Skeleton } from '../../components/ui';
import { CampaignMetadataFields, isCampaignMetadataDirty } from '../../components/CampaignMetadataFields';
import {
  capabilityStatusLabel,
  mechanicsForPackSlug,
  rulesetCapabilitiesForSelection,
  ruleSystemAdapterLabel,
} from '../../lib/rules';
import { scrollBehavior } from '../../lib/prefersReducedMotion';
import { formatDateTime } from '../../lib/format';
import AiDmCard from './AiDmCard';
import {
  SETTINGS_SECTIONS,
  settingsHashTarget,
  settingsSectionForHash,
  type SettingsSectionId,
} from './settingsNavigation';
import './CampaignSettingsPage.css';
import { GameIcon } from '../../components/GameIcon';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ConfirmDestructiveDialog } from '../../components/ConfirmDestructiveDialog';
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
import { PageTitle } from '../../components/PageTitle';
import { useSaveFeedback } from '../../components/SaveFeedback';

export default function CampaignSettingsPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const { roleIn, isAdmin } = useAuth();
  const role = roleIn(id);
  const isDm = role === 'dm';
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { refresh: refreshCampaigns } = useCampaigns();
  const pageRef = useRef<HTMLDivElement>(null);
  const compactNavigationRef = useRef<HTMLDetailsElement>(null);

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

  // Give the default section a canonical URL without adding a history entry. Section
  // links themselves push normal entries so Back/Forward traverses the settings IA.
  useEffect(() => {
    if (!campaign || location.hash) return;
    navigate(`${location.pathname}${location.search}#campaign`, { replace: true });
  }, [campaign, location.hash, location.pathname, location.search, navigate]);

  // Deep-link support (#343 / #751 / #866): onboarding and section nav link to specific
  // controls by hash. React Router doesn't focus or reliably scroll hash targets, and
  // AI subsections render after async seat load — observe the page until the target exists.
  useEffect(() => {
    if (!campaign?.id || !settingsSectionForHash(location.hash)) return;
    const targetId = settingsHashTarget(location.hash);
    if (!targetId) return;

    let observer: MutationObserver | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const settleTimeouts: ReturnType<typeof setTimeout>[] = [];
    let settleScrollsScheduled = false;
    const stopObserving = () => {
      observer?.disconnect();
      observer = undefined;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      while (settleTimeouts.length > 0) {
        // `handle`, not `id`: the outer `id` is the campaign id this effect is keyed on.
        const handle = settleTimeouts.pop();
        if (handle !== undefined) clearTimeout(handle);
      }
    };
    // The settle passes exist because AI subsections render after an async seat load and
    // shift the target, so the SCROLL offset genuinely needs re-applying. Focus does not:
    // re-calling focus() on each pass (and, before this, on every DOM mutation inside the
    // 1.2s window) yanked focus back out of whatever the user had begun interacting with
    // after the jump — stealing focus from someone who has started typing is an
    // accessibility defect, not a cosmetic one.
    //
    // So focus is applied once per target NODE. The FIRST focus is unconditional — that is
    // the deep link doing the job it was navigated for, and it must win over whatever the
    // page happened to focus while loading. A later focus only happens when a re-render has
    // REPLACED the element (the new node needs the focus the old one was carrying), and then
    // only if focus is not already parked somewhere the user put it. Scroll correction is
    // unconditional throughout: repositioning is never disruptive the way focus is.
    let focusedNode: HTMLElement | null = null;
    const scrollTarget = () => {
      const target = document.getElementById(targetId);
      if (!(target instanceof HTMLElement)) return false;
      if (focusedNode !== target) {
        const active = document.activeElement;
        const userHoldsFocus =
          !!focusedNode && !!active && active !== document.body && active !== target && !target.contains(active);
        if (!userHoldsFocus) {
          focusedNode = target;
          target.focus({ preventScroll: true });
        }
      }
      target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
      return true;
    };
    const scheduleSettledScrolls = () => {
      if (settleScrollsScheduled) return;
      settleScrollsScheduled = true;
      requestAnimationFrame(scrollTarget);
      [100, 500, 1_000].forEach((delay) => {
        settleTimeouts.push(setTimeout(scrollTarget, delay));
      });
    };
    const focusTarget = () => {
      if (!scrollTarget()) return false;
      // Settle on the FIRST hit: the target exists, so there is nothing left for the
      // observer to wait for. Leaving it connected meant every subsequent mutation in the
      // window re-ran this. The scheduled passes below own the remaining layout shifts.
      observer?.disconnect();
      observer = undefined;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      scheduleSettledScrolls();
      return true;
    };

    if (!focusTarget() && pageRef.current) {
      observer = new MutationObserver(focusTarget);
      observer.observe(pageRef.current, { childList: true, subtree: true });
      timeoutId = setTimeout(stopObserving, 10_000);
    }
    return stopObserving;
  }, [campaign?.id, location.hash, location.key]);

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (!isDm) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5 space-y-3">
        <PageTitle>{t('settings.title')}</PageTitle>
        <Card className="text-center space-y-1">
          <p className="flex justify-center text-[var(--color-neutral-400)]"><GameIcon slug="padlock" size={28} reserveSpace /></p>
          <p style={{ fontSize: 13, color: 'var(--color-neutral-300)', fontWeight: 600 }}>DM only</p>
          <p className="text-muted" style={{ fontSize: 12 }}>Only this campaign's DM can change its settings.</p>
        </Card>
      </div>
    );
  }

  const selectedSection = settingsSectionForHash(location.hash) ?? (!location.hash ? 'campaign' : null);
  const selectedDescriptor = SETTINGS_SECTIONS.find((section) => section.id === selectedSection);

  return (
    <div ref={pageRef} className="settings-page">
      <PageTitle>{t('settings.title')}</PageTitle>

      {campaign && settingsReady ? (
        <div className="settings-page__layout">
          <aside className="settings-side-nav">
            <SettingsNavigation
              selectedSection={selectedSection}
              currentUrl={`${location.pathname}${location.search}`}
            />
          </aside>

          <div className="settings-page__content">
            <details ref={compactNavigationRef} className="settings-compact-nav">
              <summary>
                {t('settings.jumpTo')}: {selectedDescriptor
                  ? t(`${selectedDescriptor.translationKey}.label`)
                  : t('settings.navigationHeading')}
              </summary>
              <SettingsNavigation
                selectedSection={selectedSection}
                currentUrl={`${location.pathname}${location.search}`}
                onNavigate={() => {
                  if (compactNavigationRef.current) compactNavigationRef.current.open = false;
                }}
              />
            </details>

            {error && <ErrorNote message={error} onRetry={load} />}

            <SettingsCategory
              id="campaign"
              selected={selectedSection === 'campaign'}
              title={t('settings.categories.campaign.label')}
              description={t('settings.categories.campaign.description')}
            >
              <GeneralCard
                key={`general-${campaign.id}`}
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
              <CatalogPrivacyCard key={`catalog-privacy-${campaign.id}`} campaign={campaign} />
              <ExportRequestsCard key={`export-requests-${campaign.id}`} campaign={campaign} />
              <CastSessionsCard key={`cast-${campaign.id}`} campaign={campaign} />
            </SettingsCategory>

            <SettingsCategory
              id="gameplay-rules"
              selected={selectedSection === 'gameplay-rules'}
              title={t('settings.categories.gameplayRules.label')}
              description={t('settings.categories.gameplayRules.description')}
            >
              <RuleSystemCard
                key={`rules-${campaign.id}`}
                campaignId={id}
                campaign={campaign}
                isAdmin={isAdmin}
                onSaved={(c) => setCampaign(c)}
              />
            </SettingsCategory>

            <SettingsCategory
              id="ai"
              selected={selectedSection === 'ai'}
              title={t('settings.categories.ai.label')}
              description={t('settings.categories.ai.description')}
            >
              <AiDmCard
                key={`aidm-${campaign.id}`}
                campaignId={id}
                campaign={campaign}
                onCampaignSaved={(c) => {
                  setCampaign(c);
                  void refreshCampaigns();
                }}
              />
            </SettingsCategory>

            <SettingsCategory
              id="data"
              selected={selectedSection === 'data'}
              title={t('settings.categories.data.label')}
              description={t('settings.categories.data.description')}
            >
              <ExportCard key={`export-${campaign.id}`} campaignId={id} />
              <CloneCard
                key={`clone-${campaign.id}`}
                campaign={campaign}
                onCloned={(c) => {
                  void refreshCampaigns();
                  navigate(`/c/${c.id}`);
                }}
              />
            </SettingsCategory>

            <SettingsCategory
              id="lifecycle"
              selected={selectedSection === 'lifecycle'}
              title={t('settings.categories.lifecycle.label')}
              description={t('settings.categories.lifecycle.description')}
            >
              <StatusCard
                key={`status-${campaign.id}`}
                campaignId={id}
                campaign={campaign}
                onSaved={(c) => {
                  setCampaign(c);
                  void refreshCampaigns();
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
            </SettingsCategory>
          </div>
        </div>
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

function SettingsNavigation({
  selectedSection,
  currentUrl,
  onNavigate,
}: {
  selectedSection: SettingsSectionId | null;
  currentUrl: string;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const headingId = onNavigate ? undefined : 'settings-navigation-heading';

  return (
    <>
      {headingId && <h2 id={headingId} className="sr-only">{t('settings.navigationHeading')}</h2>}
      <nav
        className="settings-nav"
        aria-label={headingId ? undefined : t('settings.navigationLabel')}
        aria-labelledby={headingId}
      >
        {SETTINGS_SECTIONS.map((section) => (
          <Link
            key={section.id}
            className="settings-nav__link"
            to={`${currentUrl}#${section.id}`}
            aria-current={selectedSection === section.id ? 'location' : undefined}
            onClick={onNavigate}
          >
            {t(`${section.translationKey}.label`)}
          </Link>
        ))}
      </nav>
    </>
  );
}

function SettingsCategory({
  id,
  selected,
  title,
  description,
  children,
}: {
  id: SettingsSectionId;
  selected: boolean;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const headingId = `settings-${id}-heading`;
  return (
    <section
      id={id}
      className="settings-category settings-anchor"
      data-selected={selected}
      aria-labelledby={headingId}
      tabIndex={-1}
    >
      <header className="settings-category__header">
        <h2 id={headingId} className="settings-category__title">{title}</h2>
        <p className="settings-category__description">{description}</p>
      </header>
      {children}
    </section>
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
    <Card
      id="public-recap-sharing"
      density="compact" elev="sm" className="settings-anchor"
      tabIndex={-1}
      data-testid="public-recap-sharing-settings"
      aria-labelledby="public-recap-sharing-heading"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span id="public-recap-sharing-heading" className="card-kicker" style={{ margin: 0 }}>Public recap sharing</span>
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
    </Card>
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
    <Card
      id="public-invites"
      density="compact" elev="sm" className="settings-anchor"
      tabIndex={-1}
      data-testid="public-invites-settings"
      aria-labelledby="public-invites-heading"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span id="public-invites-heading" className="card-kicker" style={{ margin: 0 }}>Public invites</span>
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
    </Card>
  );
}

/**
 * Catalog privacy (issue #587) — the campaign's own control over being listed to
 * server operators.
 *
 * Server admins now have a metadata catalog spanning every campaign, including ones
 * they are not members of. It shows no campaign content, but a NAME can itself be
 * sensitive — a support-adjacent table's name may disclose more than its description
 * ever would — so the DM gets to withhold it. Withholding replaces the name with
 * `Campaign #<id>`, derived from the id the operator can already see, so it discloses
 * nothing further while still letting them administer the row.
 *
 * Deliberately DM-only and unreachable from any admin route: an opt-out that the party
 * it protects against can clear is not an opt-out.
 */
function CatalogPrivacyCard({ campaign }: { campaign: Campaign }) {
  const [setting, setSetting] = useState<CampaignCatalogPrivacySetting | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSetting(await api.get<CampaignCatalogPrivacySetting>(`${API}/campaigns/${campaign.id}/catalog/privacy`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load catalog privacy.");
    }
  }, [campaign.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(next: 'inherit' | 'redacted') {
    setBusy(true);
    setError(null);
    try {
      setSetting(
        await api.put<CampaignCatalogPrivacySetting>(`${API}/campaigns/${campaign.id}/catalog/privacy`, {
          catalogPrivacy: next,
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update catalog privacy.");
    } finally {
      setBusy(false);
    }
  }

  const redacted = setting?.catalogPrivacy === 'redacted';
  const effective = setting?.effective;

  return (
    <Card
      id="catalog-privacy"
      density="compact" elev="sm" className="settings-anchor"
      tabIndex={-1}
      data-testid="catalog-privacy-settings"
      aria-labelledby="catalog-privacy-heading"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span id="catalog-privacy-heading" className="card-kicker" style={{ margin: 0 }}>
          Server catalog listing
        </span>
        <span className={`tag ${redacted ? 'tag-neutral' : 'tag-accent'}`}>
          {redacted ? 'name withheld' : 'follows server default'}
        </span>
      </div>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        Server admins can browse a catalog of every campaign on this server in order to find and administer
        it. That catalog shows operational details only — member counts, storage, next session, status — and
        never quests, notes, attachments, session zero, or DM secrets. You can additionally withhold this
        campaign&apos;s name and description; admins then see only &ldquo;Campaign #{campaign.id}&rdquo;.
      </p>
      {effective && (
        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
          Right now admins see: name <strong>{effective.names}</strong>, description{' '}
          <strong>{effective.descriptions}</strong>.
          {setting?.catalogPrivacy === 'inherit' && setting.serverDefault
            ? ` (Server default: names ${setting.serverDefault.names}, descriptions ${setting.serverDefault.descriptions}.)`
            : ''}
        </p>
      )}
      <div className="flex flex-col sm:flex-row gap-2">
        {redacted ? (
          <button className="btn" disabled={busy} aria-busy={busy || undefined} onClick={() => void save('inherit')}>
            Follow the server default
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void save('redacted')}
          >
            Withhold name &amp; description
          </button>
        )}
      </div>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        Withholding only ever tightens privacy. If the server default already withholds names, following the
        default will not reveal yours.
      </p>
      {error && <p className="text-sm text-red-400 m-0" role="alert">{error}</p>}
    </Card>
  );
}

/**
 * Export requests (issue #587) — the DM half of the catalog's `request_export`.
 *
 * A server operator can ASK for an export; they cannot take one. The ask lands here,
 * and until this card existed it landed nowhere a DM could see: the admin console
 * offered the operation, the server recorded a pending row, and this page rendered only
 * the privacy card — so requests sat pending forever unless somebody hand-rolled an API
 * call. An approval workflow in which nobody can approve is not a workflow.
 *
 * Approving records CONSENT and nothing else. No admin route returns an artifact; the
 * bundle is still produced by a DM through the existing DM-gated campaign export. That
 * separation is the whole reason the request is a durable row rather than a button that
 * hands over a file, and the card says so plainly so a DM knows what they are agreeing
 * to before they agree to it.
 */
/** Rows fetched per read of the DM's export inbox. */
const EXPORT_REQUEST_PAGE = 25;

function ExportRequestsCard({ campaign }: { campaign: Campaign }) {
  const [requests, setRequests] = useState<CampaignExportRequest[] | null>(null);
  const [total, setTotal] = useState(0);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pagesLoaded, setPagesLoaded] = useState(1);
  const [error, setError] = useState<string | null>(null);

  // PAGES BY OFFSET, NOT BY GROWING `limit`.
  //
  // The first version of this control kept `offset=0` and raised `limit` by 25 a click.
  // The server clamps `limit` to CAMPAIGN_CATALOG_MAX_LIMIT, so past 100 rows every click
  // re-fetched the same 100 while the button stayed visible (`requests.length < total`
  // was still true) — a control that visibly does nothing, which is worse than the cap it
  // was added to remove.
  //
  // Fetching whole pages by offset and re-reading ALL of them keeps two properties at
  // once: the list grows, and it never shows a request as pending that a decision in
  // another tab has already answered. The endpoint orders pending-first, so page one
  // always holds everything actually waiting on this DM however far back the history goes.
  const load = useCallback(
    async (pages = 1) => {
      try {
        const collected: CampaignExportRequest[] = [];
        let seenTotal = 0;
        let fetched = 0;
        for (let i = 0; i < pages; i += 1) {
          const page = await api.get<CampaignExportRequestPage>(
            `${API}/campaigns/${campaign.id}/catalog/export-requests` +
              `?limit=${EXPORT_REQUEST_PAGE}&offset=${i * EXPORT_REQUEST_PAGE}`,
          );
          collected.push(...page.items);
          seenTotal = page.total;
          fetched += 1;
          if (!page.hasMore) break;
        }
        setRequests(collected);
        setTotal(seenTotal);
        // What was actually fetched, so a shrinking inbox cannot leave this asking for
        // pages that no longer exist.
        setPagesLoaded(Math.max(1, fetched));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Couldn't load export requests.");
      }
    },
    [campaign.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function showMore() {
    setLoadingMore(true);
    try {
      await load(pagesLoaded + 1);
    } finally {
      setLoadingMore(false);
    }
  }

  async function decide(requestId: number, decision: 'approved' | 'denied') {
    setBusyId(requestId);
    setError(null);
    try {
      await api.post<CampaignExportRequest>(
        `${API}/campaigns/${campaign.id}/catalog/export-requests/${requestId}/decision`,
        { decision, note: (notes[requestId] ?? '').trim() },
      );
      // Reload the same window the DM is looking at, not just the first page.
      await load(pagesLoaded);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't record that decision.");
    } finally {
      setBusyId(null);
    }
  }

  const pending = (requests ?? []).filter((r) => r.status === 'pending');
  const decided = (requests ?? []).filter((r) => r.status !== 'pending');

  return (
    <Card
      id="export-requests"
      density="compact" elev="sm" className="settings-anchor"
      tabIndex={-1}
      data-testid="export-requests-settings"
      aria-labelledby="export-requests-heading"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span id="export-requests-heading" className="card-kicker" style={{ margin: 0 }}>
          Export requests
        </span>
        {pending.length > 0 && <span className="tag tag-accent">{pending.length} awaiting you</span>}
      </div>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        A server admin can ask you to produce an export of this campaign. They cannot take one — approving
        records your consent, and the bundle is still something you produce yourself from this campaign&apos;s
        export tools. Leaving a request alone keeps it pending; nothing is shared either way.
      </p>

      {requests !== null && requests.length === 0 && (
        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
          No server admin has requested an export of this campaign.
        </p>
      )}

      {pending.map((r) => (
        <div
          key={r.id}
          className="flex flex-col gap-2"
          style={{ borderTop: '1px solid var(--color-divider)', paddingTop: 8 }}
        >
          <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
            <strong>{r.requestedBy}</strong> asked for a <strong>{r.profile || 'backup'}</strong> export on{' '}
            {r.createdAt.slice(0, 10)}.
          </p>
          {r.justification && (
            <p style={{ margin: 0, fontSize: 12 }}>
              <span className="text-muted">Their reason: </span>
              {r.justification}
            </p>
          )}
          <label className="flex flex-col gap-1 text-muted" style={{ fontSize: 11.5 }}>
            Note back (optional, recorded with your decision)
            <input
              className="input"
              value={notes[r.id] ?? ''}
              onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
            />
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              className="btn btn-primary"
              disabled={busyId === r.id}
              aria-busy={busyId === r.id || undefined}
              onClick={() => void decide(r.id, 'approved')}
            >
              Approve
            </button>
            <button
              className="btn"
              disabled={busyId === r.id}
              aria-busy={busyId === r.id || undefined}
              onClick={() => void decide(r.id, 'denied')}
            >
              Deny
            </button>
          </div>
        </div>
      ))}

      {decided.length > 0 && (
        <div style={{ borderTop: '1px solid var(--color-divider)', paddingTop: 8 }}>
          <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
            Earlier requests
          </p>
          <ul style={{ margin: '4px 0 0', paddingInlineStart: 16 }}>
            {decided.map((r) => (
              <li key={r.id} className="text-muted" style={{ fontSize: 11.5 }}>
                {r.createdAt.slice(0, 10)} — {r.requestedBy} asked for {r.profile || 'backup'}:{' '}
                <strong>{r.status}</strong>
                {r.decisionNote ? ` (${r.decisionNote})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {requests !== null && requests.length < total && (
        <button
          className="btn"
          style={{ alignSelf: 'flex-start' }}
          disabled={loadingMore}
          aria-busy={loadingMore || undefined}
          data-testid="export-requests-show-more"
          onClick={() => void showMore()}
        >
          Show earlier requests ({requests.length} of {total})
        </button>
      )}

      {error && (
        <p className="text-sm text-red-400 m-0" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}

function CastSessionsCard({ campaign }: { campaign: Campaign }) {
  const [sessions, setSessions] = useState<CastSession[]>([]);
  const [label, setLabel] = useState('');
  const [durationHours, setDurationHours] = useState(8);
  const [created, setCreated] = useState<CastSessionCreated | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setSessions(await api.get<CastSession[]>(`${API}/campaigns/${campaign.id}/cast-sessions`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load cast sessions.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign.id]);

  async function create() {
    setBusy(true);
    setError(null);
    setMessage(null);
    setCreated(null);
    try {
      const expiresAt = new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();
      const result = await api.post<CastSessionCreated>(`${API}/campaigns/${campaign.id}/cast-sessions`, {
        label,
        expiresAt,
      });
      setCreated(result);
      setLabel('');
      setSessions((current) => [result.session, ...current]);
      setMessage('Cast session created. Copy the URL and PIN now; the PIN is shown only once.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create a cast session.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: number) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.delete(`${API}/campaigns/${campaign.id}/cast-sessions/${id}`);
      setSessions((current) => current.filter((session) => session.id !== id));
      setMessage('Cast session revoked.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't revoke the cast session.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeAll() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.delete<{ revoked: number }>(`${API}/campaigns/${campaign.id}/cast-sessions`);
      setSessions([]);
      setCreated(null);
      setConfirmRevokeAll(false);
      setMessage(`Revoked ${result.revoked} cast ${result.revoked === 1 ? 'session' : 'sessions'}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't revoke cast sessions.");
    } finally {
      setBusy(false);
    }
  }

  const castUrl = created ? new URL(created.url, window.location.origin).href : null;

  return (
    <Card
      id="cast-sessions"
      density="compact" elev="sm" className="settings-anchor"
      tabIndex={-1}
      data-testid="cast-sessions-settings"
      aria-labelledby="cast-sessions-heading"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span id="cast-sessions-heading" className="card-kicker" style={{ margin: 0 }}>Player Display cast sessions</span>
        <span className="tag tag-accent">server-redacted</span>
      </div>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        Create an expiring read-only URL for a shared TV. Cast links can read only the Player Display projection and
        need the exit PIN before the UI leaves kiosk mode.
      </p>
      <div className="grid md:grid-cols-[1fr_160px_auto] gap-2 items-end">
        <div className="field">
          <label htmlFor="cast-session-label">Label</label>
          <input
            id="cast-session-label"
            className="input"
            value={label}
            maxLength={120}
            placeholder="Table TV, OBS, living room"
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="cast-session-duration">Expires in</label>
          <select
            id="cast-session-duration"
            className="input"
            value={durationHours}
            onChange={(event) => setDurationHours(Number(event.target.value))}
          >
            <option value={4}>4 hours</option>
            <option value={8}>8 hours</option>
            <option value={24}>24 hours</option>
          </select>
        </div>
        <button className="btn btn-primary" disabled={busy || campaign.status !== 'active'} aria-busy={busy || undefined} onClick={() => void create()}>
          Create cast link
        </button>
      </div>
      {campaign.status !== 'active' && (
        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>Unarchive the campaign before creating cast sessions.</p>
      )}
      {created && castUrl && (
        <div className="rounded border border-[var(--color-divider)] p-3 space-y-2" role="status">
          <p className="m-0 text-sm font-semibold text-emerald-300">Copy these now — they are shown only once.</p>
          <div className="field">
            <label htmlFor="cast-created-url">Cast URL</label>
            <input id="cast-created-url" className="input" readOnly value={castUrl} onFocus={(event) => event.currentTarget.select()} />
          </div>
          <div className="field" style={{ maxWidth: 220 }}>
            <label htmlFor="cast-created-pin">Exit PIN</label>
            <input id="cast-created-pin" className="input" readOnly value={created.exitPin} onFocus={(event) => event.currentTarget.select()} />
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-sm text-muted">
          {loading ? 'Loading cast sessions…' : `${sessions.length} active cast ${sessions.length === 1 ? 'session' : 'sessions'}`}
        </span>
        <button className="btn btn-danger" disabled={busy || sessions.length === 0} onClick={() => setConfirmRevokeAll(true)}>
          Revoke all
        </button>
      </div>
      {sessions.length > 0 && (
        <ul className="space-y-2 m-0 p-0" style={{ listStyle: 'none' }}>
          {sessions.map((session) => (
            <li
              key={session.id}
              className="rounded border border-[var(--color-divider)] p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2"
            >
              <div>
                <p className="m-0 text-sm font-semibold">{session.label || 'Unlabelled cast session'}</p>
                <p className="m-0 text-xs text-muted">
                  {session.tokenPrefix} · expires {formatDateTime(session.expiresAt)} · {session.accessCount} reads
                </p>
              </div>
              <button className="btn btn-danger" disabled={busy} onClick={() => void revoke(session.id)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {message && <p className="text-sm text-emerald-300 m-0" role="status">{message}</p>}
      {error && <p className="text-sm text-red-400 m-0" role="alert">{error}</p>}
      {confirmRevokeAll && (
        <ConfirmDialog
          title="Revoke every cast session?"
          body="Every active Player Display cast URL for this campaign will stop working immediately."
          confirmLabel="Revoke all cast sessions"
          busy={busy}
          onCancel={() => setConfirmRevokeAll(false)}
          onConfirm={() => void revokeAll()}
        />
      )}
    </Card>
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
  const [aiExternalContentPolicy, setAiExternalContentPolicy] = useState<AiExternalContentPolicy>(
    campaign.aiExternalContentPolicy,
  );
  const feedback = useSaveFeedback('Campaign details');
  const saving = feedback.state === 'saving';

  const metadataDirty = isCampaignMetadataDirty(campaign, { name, description, dangerLevel });
  const dirty =
    metadataDirty ||
    dmControlsProgression !== campaign.dmControlsProgression ||
    aiExternalContentPolicy !== campaign.aiExternalContentPolicy;
  // Issue #760: campaign switcher confirms before discarding mid-edit settings.
  useUnsavedWork(`campaign-settings:${campaignId}`, dirty);

  async function save() {
    if (!name.trim()) {
      feedback.fail('Campaign name is required.');
      return;
    }
    // Issue #853: refuse to PATCH B with form state opened against A.
    if (!assertMutationTarget(campaign.id, campaignId).ok) return;
    if (saving) return;
    feedback.begin();
    try {
      const updated = await api.patch<Campaign>(`${API}/campaigns/${campaignId}`, {
        name: name.trim(),
        description,
        dangerLevel,
        dmControlsProgression,
        aiExternalContentPolicy,
      });
      setName(updated.name);
      setDescription(updated.description);
      setDangerLevel(updated.dangerLevel);
      setDmControlsProgression(updated.dmControlsProgression);
      setAiExternalContentPolicy(updated.aiExternalContentPolicy);
      onSaved(updated);
      feedback.succeed();
    } catch (err) {
      feedback.fail(err instanceof ApiError ? err.message : "Couldn't save changes.");
    }
  }

  return (
    <Card
      as="div"
      id="campaign-general"
      density="compact" elev="sm" className="settings-anchor"
      tabIndex={-1}
      aria-labelledby="campaign-general-heading"
    >
      <span id="campaign-general-heading" className="card-kicker">Campaign</span>
      <CampaignMetadataFields
        idPrefix="settings"
        name={name}
        description={description}
        dangerLevel={dangerLevel}
        onNameChange={(value) => { setName(value); feedback.syncDirty(isCampaignMetadataDirty(campaign, { name: value, description, dangerLevel }) || dmControlsProgression !== campaign.dmControlsProgression || aiExternalContentPolicy !== campaign.aiExternalContentPolicy); }}
        onDescriptionChange={(value) => { setDescription(value); feedback.syncDirty(isCampaignMetadataDirty(campaign, { name, description: value, dangerLevel }) || dmControlsProgression !== campaign.dmControlsProgression || aiExternalContentPolicy !== campaign.aiExternalContentPolicy); }}
        onDangerLevelChange={(value) => { setDangerLevel(value); feedback.syncDirty(isCampaignMetadataDirty(campaign, { name, description, dangerLevel: value }) || dmControlsProgression !== campaign.dmControlsProgression || aiExternalContentPolicy !== campaign.aiExternalContentPolicy); }}
        describedBy={feedback.statusId}
        disabled={saving}
      />
      <div className="field">
        <label className="flex gap-2 items-center" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={dmControlsProgression}
            disabled={saving}
            aria-describedby={feedback.statusId}
            onChange={(e) => { const value = e.target.checked; setDmControlsProgression(value); feedback.syncDirty(metadataDirty || value !== campaign.dmControlsProgression || aiExternalContentPolicy !== campaign.aiExternalContentPolicy); }}
          />
          <span>DM controls progression</span>
        </label>
        <p className="text-muted" style={{ fontSize: 12 }}>
          When on, only the DM can award XP or level up characters. When off, players may
          award XP and level up their own characters.
        </p>
      </div>
      <div className="field">
        <label htmlFor="settings-ai-external-policy">External AI source policy</label>
        <select
          id="settings-ai-external-policy"
          className="cf-select"
          value={aiExternalContentPolicy}
          aria-describedby={feedback.statusId}
          onChange={(e) => { const value = e.target.value as AiExternalContentPolicy; setAiExternalContentPolicy(value); feedback.syncDirty(metadataDirty || dmControlsProgression !== campaign.dmControlsProgression || value !== campaign.aiExternalContentPolicy); }}
          disabled={saving}
        >
          <option value="member_consent">Allow member-consented source notes</option>
          <option value="disabled">Do not send member-authored source notes</option>
        </select>
        <p className="text-muted" style={{ fontSize: 12 }}>
          Applies to external AI scribe generation. Even when allowed, each member must opt in before their resolved
          inbox notes can be included; private and opted-out notes are excluded.
        </p>
      </div>
      <div className="flex gap-2 items-center">
        <button className="btn btn-primary" disabled={saving || !dirty} onClick={save}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {feedback.announcement}
      </div>
    </Card>
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
  // Issue #846: optional DM-only reason captured at archive time and PATCHed as
  // statusChangeReason; shown back in the transition history below. Reset on
  // cancel/apply so it never leaks into the next change.
  const [reason, setReason] = useState('');
  const [transitions, setTransitions] = useState<CampaignStatusTransition[] | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Issue #846: load the status-transition history (DM sees the reason; the
  // server redacts it for non-DMs). Re-fetch whenever the persisted status
  // changes so a fresh transition appears without a manual reload.
  useEffect(() => {
    let cancelled = false;
    void api
      .get<CampaignStatusTransition[]>(`${API}/campaigns/${campaignId}/status-transitions`)
      .then((list) => {
        if (!cancelled) setTransitions(list);
      })
      .catch(() => {
        if (!cancelled) setTransitions(null);
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, campaign.status]);

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
    setReason('');
    setSnapshot((cur) => reduceStatusConfirm(cur, { type: 'cancelConfirm' }));
  }

  function cancelPreview() {
    setReason('');
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
        // Issue #846: DM-only reason recorded with the transition (server-side provenance).
        ...(reason.trim() ? { statusChangeReason: reason.trim() } : {}),
      });
      setReason('');
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
    <Card
      id="status"
      density="compact" elev="sm" className="settings-anchor"
      tabIndex={-1}
      data-testid="campaign-status-settings"
      aria-labelledby="status-heading"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span id="status-heading" className="card-kicker" style={{ margin: 0 }}>Status &amp; archive</span>
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
              {/* Issue #846: optional DM-only reason recorded with the transition. */}
              <label className="flex flex-col gap-1" style={{ margin: 0 }}>
                <span className="text-muted" style={{ fontSize: 11.5 }}>
                  Reason (optional, DM-only — not shown to players)
                </span>
                <textarea
                  className="input"
                  rows={2}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Pausing for the holidays; resuming in January."
                  data-testid="archive-reason"
                />
              </label>
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
            className="btn btn-secondary cf-density-xs"
            disabled={undoBusy}
            aria-busy={undoBusy || undefined}
            onClick={() => void undoApply()}
          >
            {undoBusy ? 'Restoring…' : 'Undo'}
          </button>
          <button
            className="btn btn-ghost cf-density-xs"
            disabled={undoBusy}
            onClick={dismissUndo}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Issue #846: status-transition history (newest first). DMs see the reason;
          the server redacts it for non-DMs. Append-only, so reactivation keeps
          the full archive→reactivate trail. */}
      {transitions && transitions.length > 0 && (
        <div
          data-testid="status-transition-history"
          className="flex flex-col gap-1.5"
          style={{ fontSize: 11.5 }}
        >
          <p className="card-kicker" style={{ margin: 0 }}>Status history</p>
          {transitions.slice(0, 6).map((t) => (
            <div key={t.id} className="text-muted" style={{ margin: 0 }}>
              <strong style={{ color: 'var(--color-text)' }}>{t.actorName || 'Someone'}</strong>{' '}
              changed {STATUS_LABEL[t.fromStatus] ?? t.fromStatus} →{' '}
              {STATUS_LABEL[t.toStatus] ?? t.toStatus} on {formatDateTime(t.createdAt)}
              {t.reason ? <> — <span style={{ color: 'var(--color-text)' }}>{t.reason}</span></> : null}
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-sm" style={{ color: '#f87171' }} role="alert">{error}</p>}
    </Card>
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
  const [enabledPackSlugs, setEnabledPackSlugs] = useState<string[]>(campaign.enabledPackSlugs ?? []);
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
        enabledPackSlugs: enabledPackSlugs.filter((slug) => slug !== selected),
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
  const currentProfile = packs ? rulesetCapabilitiesForSelection(currentSlug, packs) : null;

  // The pending switch — what mechanically changes if the admin applies `selected` (#348).
  const currentEnabled = campaign.enabledPackSlugs ?? [];
  const normalizedEnabled = enabledPackSlugs.filter((slug) => slug !== selected);
  const primaryDirty = selected !== currentSlug;
  const dirty = primaryDirty ||
    [...normalizedEnabled].sort().join('\n') !== [...currentEnabled].sort().join('\n');
  const targetPack = packs?.find((p) => p.slug === selected);
  const targetLabel = selected ? targetPack?.name ?? selected : 'None / homebrew';
  const targetProfile = packs ? rulesetCapabilitiesForSelection(selected, packs) : null;
  const targetMechanics = targetProfile?.mechanicsSummary ??
    (selected
      ? mechanicsForPackSlug(selected) ?? `Falls back to ${ruleSystemAdapterLabel(selected, selected === currentSlug ? campaign.customMechanicsProfile : null)} combat math.`
      : 'No installed rules text. Combat math falls back to D&D 5e defaults; this does not select a 5e rules pack.');

  return (
    <Card
      id="rule-system"
      density="compact" elev="sm" className="settings-anchor"
      tabIndex={-1}
      aria-labelledby="rule-system-heading"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span id="rule-system-heading" className="card-kicker" style={{ margin: 0 }}>Rule system</span>
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
        The primary system powers character math, statblocks, encounter generation and difficulty.
        None / homebrew is allowed; without additional content it has no rules compendium and uses disclosed fallback combat behavior.
        Switching keeps existing sheets and combatant stats and only re-interprets them.
      </p>
      {currentPack && currentMechanics && (
        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
          <strong>Current rules:</strong> {currentMechanics}
        </p>
      )}
      {!currentSlug && currentProfile && (
        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
          <strong>Current rules:</strong> {currentProfile.mechanicsSummary}
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
            onChange={(e) => {
              const nextPrimary = e.target.value;
              setSelected(nextPrimary);
              setEnabledPackSlugs((current) => {
                const nextEnabled = current.filter((slug) => slug !== nextPrimary);
                for (const enabledSlug of nextEnabled) {
                  const enabledPack = packs.find((pack) => pack.slug === enabledSlug);
                  if (
                    enabledPack?.kind === 'extension' &&
                    enabledPack.extendsPackSlug &&
                    enabledPack.extendsPackSlug !== nextPrimary &&
                    !nextEnabled.includes(enabledPack.extendsPackSlug)
                  ) {
                    nextEnabled.push(enabledPack.extendsPackSlug);
                  }
                }
                return nextEnabled;
              });
            }}
          >
            <option value="">None / homebrew</option>
            {packs.filter((pack) => pack.kind === 'base').map((pack) => (
              <option key={pack.id} value={pack.slug}>
                {pack.name} (v{pack.version})
              </option>
            ))}
          </select>
        </div>
      )}
      {packs && packs.length > 0 && (
        <fieldset className="field" style={{ margin: 0 }} disabled={saving}>
          <legend style={{ fontSize: 12.5, fontWeight: 600 }}>Additional content packs</legend>
          <p className="text-muted" style={{ margin: '2px 0 8px', fontSize: 11.5 }}>
            These packs add searchable compendium, encounter-picker, and AI lookup content. They never change combat math.
          </p>
          <div className="flex flex-col gap-2">
            {packs.filter((pack) => pack.slug !== selected).map((pack) => {
              const checked = normalizedEnabled.includes(pack.slug);
              return (
                <label key={pack.id} className="flex gap-2 items-start" style={{ fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => setEnabledPackSlugs((current) =>
                      event.target.checked
                        ? [...new Set([
                            ...current,
                            ...(pack.kind === 'extension' && pack.extendsPackSlug && pack.extendsPackSlug !== selected
                              ? [pack.extendsPackSlug]
                              : []),
                            pack.slug,
                          ])]
                        : current.filter(
                            (slug) =>
                              slug !== pack.slug &&
                              !packs.some(
                                (candidate) =>
                                  candidate.slug === slug &&
                                  candidate.kind === 'extension' &&
                                  candidate.extendsPackSlug === pack.slug,
                              ),
                          )
                    )}
                  />
                  <span>
                    <strong>{pack.name}</strong>{' '}
                    <span className="tag tag-neutral" style={{ fontSize: 9 }}>{pack.kind}</span>
                    {pack.extendsPackSlug ? (
                      <span className="text-muted">
                        {' · '}{pack.kind === 'extension' ? 'requires' : 'compatible with'} {pack.extendsPackSlug}
                      </span>
                    ) : null}
                    <span className="text-muted" style={{ display: 'block' }}>
                      {pack.license || 'License not specified'}{pack.sourceUrl ? ' · attribution/source link available in entries' : ''}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
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
            {primaryDirty ? <>Switch to <strong>{targetLabel}</strong>?</> : 'Update additional content packs?'}
          </p>
          {primaryDirty && <p className="text-muted" style={{ margin: 0 }}>{targetMechanics}</p>}
          {primaryDirty && (
            <p className="text-muted" style={{ margin: 0 }}>
              Existing encounters and combatants keep their stored numbers — only the interpretation (initiative,
              DC model, condition list, degrees of success) changes at read time. Nothing is recalculated or lost.
            </p>
          )}
          {primaryDirty && targetProfile && (
            <>
              <ul className="text-muted" style={{ margin: 0, paddingLeft: '1rem' }}>
                {targetProfile.migrationPreview.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <ul className="flex flex-col gap-1" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {targetProfile.capabilities.map((capability) => (
                  <li key={capability.key} className="flex gap-2">
                    <span
                      className="tag tag-neutral"
                      style={{ fontSize: 10, height: 'fit-content', minWidth: 72, justifyContent: 'center' }}
                    >
                      {capabilityStatusLabel(capability.status)}
                    </span>
                    <span className="text-muted">
                      <strong style={{ color: 'var(--color-text)' }}>{capability.label}:</strong>{' '}
                      {capability.summary}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="flex gap-2 items-center" style={{ marginTop: 4 }}>
            <button className="btn btn-primary" style={{ fontSize: 12.5 }} disabled={saving} onClick={applyRuleSystem}>
              {saving ? 'Applying…' : 'Save pack settings'}
            </button>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12.5 }}
              disabled={saving}
              onClick={() => {
                setSelected(currentSlug);
                setEnabledPackSlugs(currentEnabled);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {packs && packs.length === 0 && (
        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
          No rule packs are installed on this server yet. This campaign can stay None / homebrew.
          {isAdmin ? (
            <>
              {' '}Install one from{' '}
              <Link to={adminRulesHref(`/c/${campaignId}/settings`)} style={{ color: 'var(--color-text)', textDecoration: 'underline' }}>
                Server admin → Rule systems
              </Link>
              .
            </>
          ) : (
            ' Ask a server admin to install one from Server admin → Rule systems.'
          )}
        </p>
      )}
      {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
    </Card>
  );
}

/**
 * Export card (issue #586). The export used to be one button whose copy promised
 * "take everything with you" — which was accurate, and exactly the problem: the only
 * artifact on offer was a full DM backup carrying every member's identity, the audit
 * trail, private notes and DM secrets, with nothing to hand a stranger.
 *
 * Three profiles now, with a pre-export inventory the DM reads BEFORE downloading.
 * Publish deliberately starts with everything optional turned off.
 */
const EXPORT_PROFILE_LABELS: Record<ExportProfile, { title: string; blurb: string }> = {
  backup: {
    title: 'Backup',
    blurb: 'Everything, unredacted — member identities, audit history, proposals, private notes and DM secrets. Treat the file like the database.',
  },
  handoff: {
    title: 'Handoff',
    blurb: 'For a new DM taking over. Keeps the world, DM secrets and play state; drops member identities and operational history. Retained authors are pseudonymized.',
  },
  publish: {
    title: 'Publishable module',
    blurb: 'For sharing with strangers. Identities, audit, proposals, private notes, RSVPs, attendance and credentials are excluded. Choose what else to include below.',
  },
};

function ExportCard({ campaignId }: { campaignId: number }) {
  const [profile, setProfile] = useState<ExportProfile>('backup');
  const [dmSecrets, setDmSecrets] = useState(false);
  const [playedState, setPlayedState] = useState(false);
  const [playerContent, setPlayerContent] = useState(false);
  const [preview, setPreview] = useState<ExportInventory | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const optionQuery =
    profile === 'publish'
      ? `&dmSecrets=${dmSecrets}&playedState=${playedState}&playerContent=${playerContent}`
      : '';

  useEffect(() => {
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    void api
      .get<ExportInventory>(`${API}/campaigns/${campaignId}/export/preview?profile=${profile}&format=mdzip${optionQuery}`)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(err instanceof ApiError ? err.message : "Couldn't load the export preview.");
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, profile, optionQuery]);

  const redactedRows = preview?.rows.filter((r) => r.redacted > 0) ?? [];
  const includedRows = preview?.rows.filter((r) => r.included > 0) ?? [];

  return (
    <Card
      id="export"
      density="compact" elev="sm" className="settings-anchor"
      tabIndex={-1}
      aria-labelledby="export-heading"
      data-testid="export-settings"
    >
      <span id="export-heading" className="card-kicker">Export campaign</span>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        No lock-in — but a backup and a publishable module are not the same file. Pick what this export is for.
      </p>

      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="text-muted" style={{ fontSize: 11.5, padding: 0 }}>Export profile</legend>
        <div className="flex flex-col gap-2" style={{ marginTop: 6 }}>
          {(Object.keys(EXPORT_PROFILE_LABELS) as ExportProfile[]).map((key) => (
            <label key={key} className="flex gap-2" style={{ alignItems: 'flex-start', fontSize: 12.5 }}>
              <input
                type="radio"
                name="export-profile"
                value={key}
                checked={profile === key}
                onChange={() => setProfile(key)}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>{EXPORT_PROFILE_LABELS[key].title}</strong>
                <span className="text-muted" style={{ display: 'block', fontSize: 11.5 }}>
                  {EXPORT_PROFILE_LABELS[key].blurb}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {profile === 'publish' && (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} data-testid="export-publish-options">
          <legend className="text-muted" style={{ fontSize: 11.5, padding: 0 }}>Include in the published module</legend>
          <div className="flex flex-col gap-1" style={{ marginTop: 6 }}>
            <label className="flex gap-2" style={{ alignItems: 'center', fontSize: 12.5 }}>
              <input type="checkbox" checked={dmSecrets} onChange={(e) => setDmSecrets(e.target.checked)} />
              DM secrets (secret prose and unrevealed staging flags)
            </label>
            <label className="flex gap-2" style={{ alignItems: 'center', fontSize: 12.5 }}>
              <input type="checkbox" checked={playedState} onChange={(e) => setPlayedState(e.target.checked)} />
              Played state (session recaps, played dates, live combat state)
            </label>
            <label className="flex gap-2" style={{ alignItems: 'center', fontSize: 12.5 }}>
              <input type="checkbox" checked={playerContent} onChange={(e) => setPlayerContent(e.target.checked)} />
              Player-authored content (characters, comments, party notes, inventory, safety charter)
            </label>
          </div>
        </fieldset>
      )}

      <div data-testid="export-preview" aria-live="polite">
        {previewLoading && <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>Checking what would be included…</p>}
        {previewError && <p className="text-sm" style={{ color: '#f87171', margin: 0 }}>{previewError}</p>}
        {preview && !previewLoading && (
          <>
            <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>{preview.summary}</p>
            <p style={{ margin: '6px 0 0', fontSize: 12.5 }}>
              <strong>Included:</strong>{' '}
              {includedRows.length
                ? includedRows.map((r) => `${r.module} (${r.included})`).join(', ')
                : 'nothing'}
            </p>
            {redactedRows.length > 0 && (
              <p style={{ margin: '4px 0 0', fontSize: 12.5 }}>
                <strong>Redacted:</strong>{' '}
                {redactedRows.map((r) => `${r.module} (${r.redacted})`).join(', ')}
              </p>
            )}
            <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 11.5 }}>
              Attachments: {preview.attachments.included} listed, {preview.attachments.bytesWithheld} with bytes withheld,{' '}
              {preview.attachments.metadataStripped} with embedded metadata stripped
              {preview.attachments.filenamesNeutralized > 0 ? ', filenames replaced' : ''}.
            </p>
            {preview.identifiers.scanned > 0 && (
              <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 11.5 }}>
                Scanned for {preview.identifiers.scanned} known private identifier(s); redacted{' '}
                {preview.identifiers.occurrencesRedacted} occurrence(s). {preview.pseudonyms.contributors} contributor(s)
                pseudonymized.
              </p>
            )}
            {preview.limitations.length > 0 && (
              <details style={{ marginTop: 6 }}>
                <summary style={{ fontSize: 11.5, cursor: 'pointer' }}>What this redaction does not do</summary>
                <ul className="text-muted" style={{ fontSize: 11.5, margin: '4px 0 0', paddingLeft: 18 }}>
                  {preview.limitations.map((l) => <li key={l}>{l}</li>)}
                </ul>
              </details>
            )}
          </>
        )}
      </div>

      <div className="flex gap-2 flex-wrap">
        <a
          className="btn btn-secondary"
          style={{ fontSize: 12.5 }}
          href={`${API}/campaigns/${campaignId}/export?format=json&profile=${profile}${optionQuery}`}
        >
          ⬇ JSON export
        </a>
        <a
          className="btn btn-secondary"
          style={{ fontSize: 12.5 }}
          href={`${API}/campaigns/${campaignId}/export?format=mdzip&profile=${profile}${optionQuery}`}
        >
          ⬇ Markdown zip
        </a>
      </div>
    </Card>
  );
}

function CloneCard({ campaign, onCloned }: { campaign: Campaign; onCloned: (c: Campaign) => void }) {
  const [name, setName] = useState(`${campaign.name} (copy)`);
  const [mode, setMode] = useState<CampaignCloneMode>('full');
  const [preview, setPreview] = useState<CampaignClonePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    void api
      .get<CampaignClonePreview>(`${API}/campaigns/${campaign.id}/clone/preview?mode=${mode}`)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(err instanceof ApiError ? err.message : "Couldn't load clone preview.");
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [campaign.id, mode]);

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

  const previewLines = preview
    ? Object.entries(preview.inclusions)
        .filter(([, v]) => v.included && v.count > 0)
        .map(([key, v]) => {
          const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
          return `${label}: ${v.count}`;
        })
    : [];

  return (
    <Card
      id="duplicate"
      density="compact" elev="sm" className="settings-anchor"
      tabIndex={-1}
      aria-labelledby="duplicate-heading"
    >
      <span id="duplicate-heading" className="card-kicker">Duplicate campaign</span>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
        Reuse your prep. A full copy duplicates world-building and play state — quests, NPCs, locations,
        factions, characters, sessions, notes, encounters, storylines, timeline, session-zero charter,
        inventory, treasury, prose revisions, and map/portrait attachments (encounter combat resets to
        preparing with full HP). A template copies prep only and resets progress. Members are not copied —
        you become the new campaign&apos;s DM.
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
      {(previewLoading || preview || previewError) && (
        <div
          className="text-muted"
          style={{ margin: '0.5rem 0', fontSize: 11.5, lineHeight: 1.45 }}
          data-testid="clone-preview"
        >
          {previewLoading && <p style={{ margin: 0 }}>Loading preview…</p>}
          {previewError && <p style={{ margin: 0, color: '#f87171' }}>{previewError}</p>}
          {preview && !previewLoading && (
            <>
              {previewLines.length > 0 && (
                <p style={{ margin: '0 0 0.35rem' }}>
                  <strong style={{ fontWeight: 600 }}>Will copy:</strong> {previewLines.join(' · ')}
                </p>
              )}
              {preview.warnings.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                  {preview.warnings.map((w) => (
                    <li key={w.code}>{w.message}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
      {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
      <div className="flex gap-2 items-center">
        <button className="btn btn-secondary" style={{ fontSize: 12.5 }} disabled={cloning || previewLoading} onClick={clone}>
          {cloning ? 'Duplicating…' : mode === 'template' ? 'Create from template' : 'Duplicate campaign'}
        </button>
      </div>
    </Card>
  );
}

function DangerZoneCard({ campaign, onDeleted }: { campaign: Campaign; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [liveInviteCount, setLiveInviteCount] = useState(0);
  const [revokeInvitesOnTrash, setRevokeInvitesOnTrash] = useState(false);

  function openConfirm() {
    setOpen(true);
    setError(null);
    setRevokeInvitesOnTrash(false);
    void api
      .get<CampaignInvite[]>(`${API}/campaigns/${campaign.id}/invites`)
      .then((list) => setLiveInviteCount(list.length))
      .catch(() => setLiveInviteCount(0));
  }

  async function remove() {
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
    <Card
      id="danger-zone"
      density="compact" elev="sm" className="settings-anchor"
      tabIndex={-1}
      style={{ borderLeft: '2px solid #f87171' }}
      data-testid="danger-zone-card"
      aria-labelledby="danger-zone-heading"
    >
      <span id="danger-zone-heading" className="card-kicker" style={{ color: '#f87171' }}>Danger zone</span>
      <div className="flex items-center gap-2">
        <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
          Deleting a campaign moves it to the Trash — it's hidden and restorable. Nothing is
          permanently removed until you purge it from the Trash on your campaigns page.
          Outstanding invite links are suspended automatically.
        </p>
        <div className="flex-1" />
        <button
          className="btn btn-ghost btn-danger"
          style={{ fontSize: 12.5 }}
          onClick={openConfirm}
          data-testid="delete-campaign-trigger"
        >
          Delete campaign…
        </button>
      </div>
      {open && (
        <ConfirmDestructiveDialog
          title="Delete campaign"
          consequence={
            <p style={{ margin: 0, fontSize: 12.5 }}>
              Typing <strong>{campaign.name}</strong> will move this campaign to the Trash.
              Invite links are suspended so old join URLs stop working; restore does not revive them.
            </p>
          }
          extraBody={
            liveInviteCount > 0 ? (
              <div
                data-testid="trash-outstanding-invites"
                className="flex flex-col gap-1.5"
                style={{
                  marginTop: 8,
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
            ) : null
          }
          confirmValue={campaign.name}
          hintMismatch={`You must type "${campaign.name}" to enable the button.`}
          confirmLabel="Move to Trash"
          pendingLabel="Moving…"
          busy={deleting}
          error={error}
          onConfirm={() => void remove()}
          onCancel={() => {
            setOpen(false);
            setError(null);
            setRevokeInvitesOnTrash(false);
          }}
        />
      )}
    </Card>
  );
}
