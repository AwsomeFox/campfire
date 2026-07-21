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
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Campaign, CampaignCloneMode, DangerLevel, RulePack } from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useCampaigns } from '../../app/CampaignContext';
import { Card, ErrorNote, Skeleton } from '../../components/ui';
import { mechanicsForPackSlug, ruleSystemAdapterLabel } from '../../lib/rules';
import AiDmCard from './AiDmCard';

const DANGER_LEVELS: DangerLevel[] = ['low', 'moderate', 'high', 'deadly'];

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

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<Campaign>(`${API}/campaigns/${id}`);
      setCampaign(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load campaign settings.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (Number.isFinite(id) && role) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, role]);

  // Deep-link support (#343): the AI-DM onboarding checklist links to specific controls
  // by hash (e.g. #ai-dm-provider). React Router doesn't auto-scroll to a hash, and the
  // target only exists once the (lazy) page has loaded the campaign, so scroll it into
  // view here once the anchor is present.
  useEffect(() => {
    if (!campaign || !location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [campaign, location.hash]);

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
          <p className="text-2xl">🔒</p>
          <p style={{ fontSize: 13, color: 'var(--color-neutral-300)', fontWeight: 600 }}>DM only</p>
          <p className="text-muted" style={{ fontSize: 12 }}>Only this campaign's DM can change its settings.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full mx-auto px-5 pt-7 pb-12 flex flex-col gap-3.5" style={{ maxWidth: 640 }}>
      <h3 style={{ margin: '4px 0 0' }}>Campaign settings</h3>

      {loading && !campaign ? (
        <Card>
          <Skeleton lines={6} />
        </Card>
      ) : error && !campaign ? (
        <ErrorNote message={error} onRetry={load} />
      ) : campaign ? (
        <>
          {error && <ErrorNote message={error} onRetry={load} />}
          <GeneralCard
            campaignId={id}
            campaign={campaign}
            onSaved={(c) => {
              setCampaign(c);
              void refreshCampaigns();
            }}
          />
          <StatusCard
            campaignId={id}
            campaign={campaign}
            onSaved={(c) => {
              setCampaign(c);
              void refreshCampaigns();
            }}
          />
          <RuleSystemCard
            campaignId={id}
            campaign={campaign}
            isAdmin={isAdmin}
            onSaved={(c) => setCampaign(c)}
          />
          <AiDmCard campaignId={id} />
          <ExportCard campaignId={id} />
          <CloneCard
            campaign={campaign}
            onCloned={(c) => {
              void refreshCampaigns();
              navigate(`/c/${c.id}`);
            }}
          />
          <DangerZoneCard
            campaign={campaign}
            onDeleted={() => {
              void refreshCampaigns();
              navigate('/');
            }}
          />
        </>
      ) : null}
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

  const dirty =
    name !== campaign.name ||
    description !== campaign.description ||
    dangerLevel !== campaign.dangerLevel ||
    dmControlsProgression !== campaign.dmControlsProgression;

  async function save() {
    if (!name.trim()) {
      setError('Campaign name is required.');
      return;
    }
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
      <div className="field">
        <label htmlFor="settings-name">Name</label>
        <input id="settings-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="settings-desc">Description</label>
        <textarea
          id="settings-desc"
          className="input"
          style={{ minHeight: 64 }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="field" style={{ maxWidth: 200 }}>
        <label htmlFor="settings-danger">Danger level</label>
        <select
          id="settings-danger"
          className="input"
          value={dangerLevel}
          onChange={(e) => setDangerLevel(e.target.value as DangerLevel)}
        >
          {DANGER_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level.charAt(0).toUpperCase() + level.slice(1)}
            </option>
          ))}
        </select>
      </div>
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
      {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
      <div className="flex gap-2 items-center">
        <button className="btn btn-primary" disabled={saving || !dirty} onClick={save}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {saved && <span className="text-muted" style={{ fontSize: 12 }}>Saved.</span>}
      </div>
    </div>
  );
}

const STATUSES: Campaign['status'][] = ['active', 'paused', 'completed'];

/**
 * Archive control (issue #16). Status is PATCHed on its own — the server
 * rejects any other field on an archived (paused/completed) campaign, so this
 * card is the one switch that always works, both ways.
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changeStatus(value: Campaign['status']) {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.patch<Campaign>(`${API}/campaigns/${campaignId}`, { status: value });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change the campaign status.");
    } finally {
      setSaving(false);
    }
  }

  const archived = campaign.status !== 'active';

  return (
    <div className="card elev-sm">
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
          value={campaign.status}
          disabled={saving}
          onChange={(e) => void changeStatus(e.target.value as Campaign['status'])}
        >
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
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
          <a href="/admin" className="btn btn-secondary" style={{ fontSize: 12.5 }}>
            Manage packs
          </a>
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
        encounters. A template copies the world only and resets progress: quests back to available, objectives
        unchecked, no sessions or play state. Members aren't copied — you become the new campaign's DM.
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

  const canDelete = confirmText.trim() === campaign.name;

  async function remove() {
    if (!canDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await api.delete(`${API}/campaigns/${campaign.id}`);
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
          </p>
          <div className="flex-1" />
          <button className="btn btn-ghost" style={{ fontSize: 12.5, color: '#f87171' }} onClick={() => setOpen(true)}>
            Delete campaign…
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--color-neutral-200)' }}>
            Type <strong>{campaign.name}</strong> to move it to the Trash (you can restore it later).
          </p>
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
              }}
              disabled={deleting}
            >
              Cancel
            </button>
            <div className="flex-1" />
            <button
              className="btn btn-secondary"
              style={{ fontSize: 12.5, color: '#f87171', borderColor: '#f87171' }}
              disabled={!canDelete || deleting}
              onClick={remove}
            >
              {deleting ? 'Moving…' : 'Move to Trash'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
