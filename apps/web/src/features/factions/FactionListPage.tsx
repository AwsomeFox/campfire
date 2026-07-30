/**
 * Faction/organization roster (issue #221) — mirrors NpcListPage: a compact card
 * grid with name/kind, a party-standing badge (hostile→allied + numeric reputation),
 * and DM-only hidden/secret chips. DM can inline-create (name + kind); everyone can
 * browse & open a detail page.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { ListDetailLink } from '../../components/ListDetailLink';
import { useRestoreListOriginScroll } from '../../hooks/useRestoreListOriginScroll';
import type { Faction } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { Card, Chip, Btn, TextInput, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { AudienceField, audienceToHidden, type AudienceValue } from '../../components/AudienceField';
import { PageHeader } from '../../components/PageHeader';
import { GameIcon } from '../../components/GameIcon';
import { initials } from '../../lib/avatarText';
import { formatStandingChip, standingVariant } from './standing';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

export default function FactionListPage() {
  const { t } = useTranslation();
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const navigate = useNavigate();
  const { isDm, canDmWrite } = useCampaignAccess();
  useRestoreListOriginScroll();

  const [factions, setFactions] = useState<Faction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('');
  // #754: quick-create defaults to DM-only.
  const [audience, setAudience] = useState<AudienceValue>('dm');
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<Faction[]>(`${API}/campaigns/${id}/factions`);
      setFactions(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load factions.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (Number.isFinite(id)) void load();
  }, [id, load]);

  async function createFaction() {
    if (!newName.trim()) return;
    setSaving(true);
    setCreateError(null);
    try {
      const hidden = audienceToHidden(audience);
      const faction = await api.post<Faction>(`${API}/campaigns/${id}/factions`, {
        name: newName.trim(),
        kind: newKind.trim(),
        hidden,
      });
      setNewName('');
      setNewKind('');
      setAudience('dm');
      setCreating(false);
      await load();
      navigate(`/c/${id}/factions/${faction.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Couldn't create the faction.");
    } finally {
      setSaving(false);
    }
  }

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-7xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (loading && factions.length === 0 && !error) {
    return (
      <div className="max-w-7xl mx-auto px-4 mt-5">
        <Card>
          <Skeleton lines={5} />
        </Card>
      </div>
    );
  }

  if (error && factions.length === 0) {
    return (
      <div className="max-w-7xl mx-auto px-4 mt-5">
        <ErrorNote message={error} onRetry={load} />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
      <Card className="space-y-4">
        <PageHeader
          variant="card"
          icon={<GameIcon slug="black-flag" size={UI_ICON_SIZE.md} />}
          title={t('nav.factions')}
          primaryAction={
            canDmWrite && !creating ? (
              <Btn ghost type="button" className="cf-page-header__action" onClick={() => setCreating(true)}>
                + New faction
              </Btn>
            ) : undefined
          }
        />

        {canDmWrite && creating && (
          <div className="cf-inset p-3.5 space-y-2">
            {createError && <ErrorNote message={createError} />}
            <TextInput aria-label="Faction name" placeholder="Name (e.g. Thieves' Guild)" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} autoFocus />
            <TextInput aria-label="Faction kind" placeholder="Kind (e.g. guild, cult, government)" value={newKind} onChange={(e) => setNewKind(e.target.value)} maxLength={60} />
            <AudienceField value={audience} onChange={setAudience} entityLabel="faction" name="faction-audience" />
            <div className="flex items-center justify-end gap-2">
              <Btn density="xs"
                ghost
                className="text-xs"
                onClick={() => {
                  setCreating(false);
                  setNewName('');
                  setNewKind('');
                  setAudience('dm');
                  setCreateError(null);
                }}
              >
                Cancel
              </Btn>
              <Btn density="xs" className="text-xs" disabled={saving || !newName.trim()} onClick={createFaction}>
                {saving ? 'Creating…' : 'Create'}
              </Btn>
            </div>
          </div>
        )}

        {factions.length === 0 ? (
          <EmptyState icon="black-flag" title="No factions yet" hint={isDm ? 'Add the first one above.' : 'The DM has not added any factions yet.'} />
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }}>
            {factions.map((faction) => (
              <ListDetailLink
                key={faction.id}
                to={`/c/${id}/factions/${faction.id}`}
                className="cf-card cf-card-hover cf-density-compact space-y-2"
              >
                <div className="flex items-center gap-2.5">
                  {faction.portraitUrl ? (
                    <img
                      src={faction.portraitUrl}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded-full object-cover border border-[var(--color-divider)]"
                    />
                  ) : (
                    <span className="h-9 w-9 shrink-0 rounded-full bg-[var(--color-neutral-900)] border border-[var(--color-divider)] flex items-center justify-center text-[13px] text-[var(--color-neutral-400)]">
                      {initials(faction.name)}
                    </span>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-slate-200 text-sm truncate cf-name-reveal" title={faction.name} aria-label={`Faction: ${faction.name}`}>{faction.name}</p>
                    {faction.kind && <p className="text-[11.5px] text-secondary truncate cf-name-reveal" title={faction.kind}>{faction.kind}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Chip variant={standingVariant(faction.standing)}>
                    {formatStandingChip(faction.standing, faction.reputation, t)}
                  </Chip>
                  {isDm && faction.hidden && <Chip variant="failed"><span className="inline-flex items-center gap-1"><GameIcon slug="sight-disabled" size={UI_ICON_SIZE.xs} /> Hidden</span></Chip>}
                  {isDm && faction.dmSecret && <Chip variant="proposal">DM secret</Chip>}
                </div>
              </ListDetailLink>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
