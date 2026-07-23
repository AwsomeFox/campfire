/**
 * Faction/organization detail (issue #221) — mirrors NpcPage. Header (name/kind +
 * party-standing badge), a two-column body (description + goals + DM-secret panel on
 * the left, Facts + reputation control + member NPCs + Notes on the right). DM: edit
 * everything, bump reputation, reveal/hide, delete. Everyone: read the visible parts.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import type { FactionStanding, FactionWithMembers, Npc } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, Skeleton, ErrorNote, DmPanel, EmptyState } from '../../components/ui';
import { NotFoundState } from '../../components/NotFoundState';
import { Markdown } from '../../components/Markdown';
import { NotesRail } from '../../components/NotesRail';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { GameIcon } from '../../components/GameIcon';
import {
  DmPrivacyGroup,
  FACTION_EDITOR_ID_PREFIX,
  FACTION_FIELD_NAMES,
  LabeledField,
  labeledFieldIds,
} from '../../components/LabeledField';
import { entityTargetProps } from '../../lib/entityLinks';
import { initials } from '../../lib/avatarText';
import {
  factionStandingLabel,
  factionStandingOptions,
  formatStandingChip,
  standingVariant,
} from './standing';

export default function FactionPage() {
  const { t } = useTranslation();
  const { campaignId, factionId } = useParams<{ campaignId: string; factionId: string }>();
  const cid = Number(campaignId);
  const id = Number(factionId);
  const navigate = useNavigate();
  const { roleIn } = useAuth();
  const role = roleIn(cid);
  const isDm = role === 'dm';
  const standingOptions = factionStandingOptions(t);

  const [faction, setFaction] = useState<FactionWithMembers | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', kind: '', body: '', goals: '', dmSecret: '', hidden: false, standing: 'neutral' as FactionStanding, reputation: 0 });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [togglingHidden, setTogglingHidden] = useState(false);
  const [bumping, setBumping] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const data = await api.get<FactionWithMembers>(`${API}/factions/${id}`);
      setFaction(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't load this faction.");
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (Number.isFinite(cid) && Number.isFinite(id)) void load();
  }, [cid, id, load]);

  function startEdit() {
    if (!faction) return;
    setForm({
      name: faction.name,
      kind: faction.kind,
      body: faction.body,
      goals: faction.goals,
      dmSecret: faction.dmSecret,
      hidden: faction.hidden,
      standing: faction.standing,
      reputation: faction.reputation,
    });
    setSaveError(null);
    setFieldErrors({});
    setEditing(true);
  }

  // Entity-level secrecy (issue #42): reveal/hide the whole faction from players.
  async function toggleHidden() {
    if (!faction) return;
    setTogglingHidden(true);
    try {
      await api.patch(`${API}/factions/${id}`, { hidden: !faction.hidden });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change visibility.");
    } finally {
      setTogglingHidden(false);
    }
  }

  // Reputation control (issue #221): bump the numeric score and/or set the standing label.
  async function adjustReputation(patch: { delta?: number; standing?: FactionStanding }) {
    if (!faction) return;
    setBumping(true);
    try {
      const updated = await api.patch<FactionWithMembers>(`${API}/factions/${id}/reputation`, patch);
      setFaction((prev) => (prev ? { ...updated, members: prev.members } : prev));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change reputation.");
    } finally {
      setBumping(false);
    }
  }

  async function save() {
    if (!form.name.trim()) {
      setFieldErrors({ name: 'Name is required.' });
      document.getElementById(labeledFieldIds(FACTION_EDITOR_ID_PREFIX, FACTION_FIELD_NAMES.name).controlId)?.focus();
      return;
    }
    setSaving(true);
    setSaveError(null);
    setFieldErrors({});
    try {
      await api.patch(`${API}/factions/${id}`, {
        name: form.name.trim(),
        kind: form.kind.trim(),
        body: form.body,
        goals: form.goals,
        dmSecret: form.dmSecret,
        hidden: form.hidden,
        standing: form.standing,
        reputation: form.reputation,
      });
      await load();
      setEditing(false);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldMessages());
        setSaveError(err.message);
      } else {
        setSaveError("Couldn't save changes.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await api.delete(`${API}/factions/${id}`);
      navigate(`/c/${cid}/factions`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete this faction.");
      setDeleting(false);
    }
  }

  if (!Number.isFinite(cid) || !Number.isFinite(id)) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message="No faction selected." />
      </div>
    );
  }

  if (loading && !faction) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <Card>
          <Skeleton lines={6} />
        </Card>
      </div>
    );
  }

  if (notFound && !faction) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <NotFoundState title="Faction not found" backTo={`/c/${cid}/factions`} backLabel="← Back to factions" />
      </div>
    );
  }

  if (error && !faction) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message={error} onRetry={load} />
      </div>
    );
  }

  if (!faction) return null;

  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10" {...entityTargetProps('faction', faction.id)}>
      <div>
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => navigate(`/c/${cid}/factions`)}>
          ← Back
        </Btn>
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      {!editing && (
        <>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="rounded-full bg-[var(--color-neutral-900)] border border-[var(--color-divider)] flex items-center justify-center text-base text-[var(--color-neutral-400)] shrink-0" style={{ height: 52, width: 52 }}>
              {initials(faction.name)}
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-extrabold text-white leading-tight break-words">{faction.name}</h1>
              {faction.kind && <p className="text-sm text-slate-400 break-words">{faction.kind}</p>}
            </div>
            <Chip variant={standingVariant(faction.standing)}>
              {formatStandingChip(faction.standing, faction.reputation, t)}
            </Chip>
            {isDm && faction.hidden && <Chip variant="failed"><span className="inline-flex items-center gap-1"><GameIcon slug="sight-disabled" size={12} /> Hidden from players</span></Chip>}
            {isDm && (
              <div className="flex gap-2 ml-auto">
                <Btn
                  ghost
                  className="!min-h-0 !py-1.5 text-xs"
                  disabled={togglingHidden}
                  onClick={toggleHidden}
                  title={faction.hidden ? 'Make this faction visible to players' : 'Hide this faction from players'}
                >
                  {togglingHidden ? '…' : faction.hidden ? <><GameIcon slug="eyeball" size={12} className="inline align-text-bottom" /> Reveal</> : <><GameIcon slug="sight-disabled" size={12} className="inline align-text-bottom" /> Hide</>}
                </Btn>
                <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={startEdit}>
                  ✎ Edit
                </Btn>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[1fr_320px] gap-4 items-start">
            <div className="space-y-4 min-w-0">
              <Card>
                {faction.body ? <Markdown>{faction.body}</Markdown> : <p className="text-sm text-slate-500 italic">No description yet.</p>}
              </Card>

              {faction.goals && (
                <Card className="space-y-2">
                  <h2 className="flex items-center gap-2 font-bold text-white text-sm"><GameIcon slug="target-arrows" size={16} /> Goals</h2>
                  <Markdown>{faction.goals}</Markdown>
                </Card>
              )}

              {isDm && faction.dmSecret && <DmPanel>{faction.dmSecret}</DmPanel>}

              <Card className="space-y-3">
                <h2 className="font-bold text-white text-sm">Members</h2>
                {faction.members.length === 0 ? (
                  <EmptyState icon="shaking-hands" title="No members" hint={isDm ? 'Set an NPC\'s faction on its page.' : undefined} />
                ) : (
                  <div className="grid sm:grid-cols-2 gap-3">
                    {faction.members.map((npc: Npc) => (
                      <a
                        key={npc.id}
                        href={`/c/${cid}/npcs/${npc.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(`/c/${cid}/npcs/${npc.id}`);
                        }}
                        className="cf-inset cf-card-hover p-3"
                      >
                        <p className="flex items-center gap-1.5 text-sm font-bold text-amber-400"><GameIcon slug="hooded-figure" size={13} /> {npc.name}</p>
                        {npc.role && <p className="text-[11.5px] text-slate-500 truncate">{npc.role}</p>}
                      </a>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            <div className="space-y-4 min-w-0">
              <Card className="space-y-2">
                <p className="card-kicker">Party standing</p>
                <div className="flex justify-between gap-2 text-[13px]">
                  <span className="text-muted">Standing</span>
                  <span>{factionStandingLabel(faction.standing, t)}</span>
                </div>
                <div className="flex justify-between gap-2 text-[13px]">
                  <span className="text-muted">Reputation</span>
                  <span>{faction.reputation > 0 ? `+${faction.reputation}` : faction.reputation}</span>
                </div>
                {isDm && (
                  <div className="space-y-2 pt-1">
                    <div className="flex items-center gap-2">
                      <Btn ghost className="!min-h-0 !py-1 text-xs flex-1" disabled={bumping} onClick={() => adjustReputation({ delta: -10 })}>
                        −10
                      </Btn>
                      <Btn ghost className="!min-h-0 !py-1 text-xs flex-1" disabled={bumping} onClick={() => adjustReputation({ delta: 10 })}>
                        +10
                      </Btn>
                    </div>
                    <label className="block space-y-1" htmlFor="faction-party-standing">
                      <span className="text-muted">Party standing</span>
                      <select
                        id="faction-party-standing"
                        className="cf-select"
                        value={faction.standing}
                        disabled={bumping}
                        onChange={(e) => adjustReputation({ standing: e.target.value as FactionStanding })}
                      >
                        {standingOptions.map(({ value, label }) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </Card>

              <NotesRail campaignId={cid} entityType="faction" entityId={id} />
            </div>
          </div>
        </>
      )}

      {editing && (
        <Card
          className="space-y-3"
          role="region"
          aria-label="Edit faction"
          aria-describedby={saveError ? `${FACTION_EDITOR_ID_PREFIX}-form-error` : undefined}
        >
          {saveError && (
            <div id={`${FACTION_EDITOR_ID_PREFIX}-form-error`}>
              <ErrorNote message={saveError} />
            </div>
          )}
          <div className="grid sm:grid-cols-2 gap-3">
            <LabeledField
              idPrefix={FACTION_EDITOR_ID_PREFIX}
              name={FACTION_FIELD_NAMES.name}
              label="Name"
              value={form.name}
              onChange={(e) => {
                setForm({ ...form, name: e.target.value });
                setFieldErrors((current) => {
                  if (!current.name) return current;
                  const next = { ...current };
                  delete next.name;
                  return next;
                });
              }}
              error={fieldErrors.name}
              disabled={saving}
              describedBy={saveError ? `${FACTION_EDITOR_ID_PREFIX}-form-error` : undefined}
            />
            <LabeledField
              idPrefix={FACTION_EDITOR_ID_PREFIX}
              name={FACTION_FIELD_NAMES.kind}
              label="Kind"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
              placeholder="guild, cult, government…"
              error={fieldErrors.kind}
              disabled={saving}
            />
            <LabeledField
              idPrefix={FACTION_EDITOR_ID_PREFIX}
              name={FACTION_FIELD_NAMES.standing}
              as="select"
              label="Standing"
              value={form.standing}
              onChange={(e) => setForm({ ...form, standing: e.target.value as FactionStanding })}
              error={fieldErrors.standing}
              disabled={saving}
            >
              {standingOptions().map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </LabeledField>
            <LabeledField
              idPrefix={FACTION_EDITOR_ID_PREFIX}
              name={FACTION_FIELD_NAMES.reputation}
              type="number"
              label="Reputation (−100…100)"
              value={String(form.reputation)}
              onChange={(e) =>
                setForm({ ...form, reputation: Math.max(-100, Math.min(100, Number(e.target.value) || 0)) })
              }
              min={-100}
              max={100}
              help="Numeric standing score from −100 to 100."
              error={fieldErrors.reputation}
              disabled={saving}
            />
          </div>
          <LabeledField
            idPrefix={FACTION_EDITOR_ID_PREFIX}
            name={FACTION_FIELD_NAMES.body}
            as="textarea"
            label="Description (markdown)"
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            error={fieldErrors.body}
            disabled={saving}
            minHeight={140}
          />
          <LabeledField
            idPrefix={FACTION_EDITOR_ID_PREFIX}
            name={FACTION_FIELD_NAMES.goals}
            as="textarea"
            label={
              <span className="inline-flex items-center gap-1">
                <GameIcon slug="target-arrows" size={11} /> Goals (markdown)
              </span>
            }
            value={form.goals}
            onChange={(e) => setForm({ ...form, goals: e.target.value })}
            error={fieldErrors.goals}
            disabled={saving}
            minHeight={90}
          />
          <DmPrivacyGroup
            idPrefix={FACTION_EDITOR_ID_PREFIX}
            entityLabel="faction"
            dmSecret={form.dmSecret}
            onDmSecretChange={(e) => setForm({ ...form, dmSecret: e.target.value })}
            hidden={form.hidden}
            onHiddenChange={(e) => setForm({ ...form, hidden: e.target.checked })}
            dmSecretError={fieldErrors.dmSecret}
            hiddenError={fieldErrors.hidden}
            disabled={saving}
            describedBy={saveError ? `${FACTION_EDITOR_ID_PREFIX}-form-error` : undefined}
          />
          <div className="flex items-center justify-between gap-2">
            <Btn danger className="!min-h-0 !py-1.5 text-xs" busy={deleting} onClick={() => setConfirmingDelete(true)}>
              {deleting ? 'Deleting…' : 'Delete faction'}
            </Btn>
            <div className="flex gap-2">
              <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setEditing(false)}>
                Cancel
              </Btn>
              <Btn className="!min-h-0 !py-1.5 text-xs" disabled={saving || !form.name.trim()} onClick={save}>
                {saving ? 'Saving…' : 'Save'}
              </Btn>
            </div>
          </div>
        </Card>
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete ${faction.name}?`}
          body="This cannot be undone. Member NPCs are unlinked, not deleted."
          confirmLabel="Delete faction"
          busy={deleting}
          onConfirm={remove}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}
