/**
 * Location roster — mirrors design/claude-design/Campfire.dc.html "World" Locations tab
 * (~1259-1271): a stacked row list, name + status chip + DM-secret tag, body preview.
 * DM can inline-create (name + kind); everyone can browse & open a detail page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ListDetailLink } from '../../components/ListDetailLink';
import { useRestoreListOriginScroll } from '../../hooks/useRestoreListOriginScroll';
import type { Location } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { Card, Chip, Btn, TextInput, Skeleton, ErrorNote, EmptyState, statusVariant } from '../../components/ui';
import { LocationStatusLabel } from '../../components/LocationStatusLabel';
import { PageHeader, type PageHeaderSecondaryAction } from '../../components/PageHeader';
import { usePageHeaderDraftWithAi } from '../ai-dm/usePageHeaderDraftWithAi';
import { GameIcon } from '../../components/GameIcon';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

function firstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 0);
  return line?.trim() ?? '';
}


/**
 * Flatten the location hierarchy (#99) into render order: each root followed by its
 * descendants depth-first, carrying a `depth` for indentation. Locations whose parent
 * isn't in the visible set (e.g. an unexplored parent hidden from a player) surface as
 * roots so nothing silently disappears. A `seen` guard keeps a cyclic legacy row from
 * looping forever.
 */
function toTree(locations: Location[]): Array<{ loc: Location; depth: number }> {
  const byParent = new Map<number | null, Location[]>();
  const ids = new Set(locations.map((l) => l.id));
  for (const loc of locations) {
    const parent = loc.parentId != null && ids.has(loc.parentId) ? loc.parentId : null;
    const bucket = byParent.get(parent) ?? [];
    bucket.push(loc);
    byParent.set(parent, bucket);
  }
  const out: Array<{ loc: Location; depth: number }> = [];
  const seen = new Set<number>();
  const walk = (parentId: number | null, depth: number) => {
    for (const loc of byParent.get(parentId) ?? []) {
      if (seen.has(loc.id)) continue;
      seen.add(loc.id);
      out.push({ loc, depth });
      walk(loc.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export default function LocationListPage() {
  const { t } = useTranslation();
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { isDm, canDmWrite } = useCampaignAccess();
  useRestoreListOriginScroll();

  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(() => searchParams.get('action') === 'new');

  const closeCreating = useCallback(() => {
    setCreating(false);
    if (searchParams.get('action') === 'new') {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('action');
          return next;
        },
        { replace: true },
      );
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (searchParams.get('action') === 'new') {
      setCreating(true);
    }
  }, [searchParams]);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('');
  const [newParentId, setNewParentId] = useState('');
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const { secondaryAction: draftAction, draftDialog } = usePageHeaderDraftWithAi({
    campaignId: id,
    target: 'location',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLocations(await api.get<Location[]>(`${API}/campaigns/${id}/locations`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load locations.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (Number.isFinite(id)) void load();
  }, [id, load]);

  const secondaryActions: PageHeaderSecondaryAction[] = useMemo(() => {
    const actions: PageHeaderSecondaryAction[] = [
      { key: 'npcs', label: t('locations.npcsLink'), href: `/c/${id}/npcs` },
    ];
    if (draftAction) {
      actions.push(draftAction);
    }
    return actions;
  }, [draftAction, id, t]);

  async function createLocation() {
    if (!newName.trim()) return;
    setSaving(true);
    setCreateError(null);
    try {
      const loc = await api.post<Location>(`${API}/campaigns/${id}/locations`, {
        name: newName.trim(),
        kind: newKind.trim(),
        parentId: newParentId ? Number(newParentId) : null,
      });
      setNewName('');
      setNewKind('');
      setNewParentId('');
      closeCreating();
      await load();
      navigate(`/c/${id}/locations/${loc.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Couldn't create the location.");
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

  if (loading && locations.length === 0 && !error) {
    return (
      <div className="max-w-7xl mx-auto px-4 mt-5">
        <Card>
          <Skeleton lines={5} />
        </Card>
      </div>
    );
  }

  if (error && locations.length === 0) {
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
          icon={<GameIcon slug="world" size={UI_ICON_SIZE.md} />}
          title={t('nav.world')}
          subtitle={t('locations.locationsSub')}
          secondaryActions={secondaryActions}
          primaryAction={
            canDmWrite && !creating ? (
              <Btn ghost type="button" className="cf-page-header__action" onClick={() => setCreating(true)}>
                + New location
              </Btn>
            ) : undefined
          }
        />
        {draftDialog}

        {canDmWrite && creating && (
          <div className="cf-inset p-3.5 space-y-2">
            {createError && <ErrorNote message={createError} />}
            <TextInput aria-label="Location name" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} autoFocus />
            <TextInput aria-label="Location kind" placeholder="Kind (e.g. town, dungeon, region)" value={newKind} onChange={(e) => setNewKind(e.target.value)} />
            <select
              aria-label="Parent location"
              className="cf-input text-sm"
              value={newParentId}
              onChange={(e) => setNewParentId(e.target.value)}
            >
              <option value="">No parent (top level)</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  Inside: {loc.name}
                </option>
              ))}
            </select>
            <div className="flex items-center justify-end gap-2">
              <Btn density="xs"
                ghost
                className="text-xs"
                onClick={() => {
                  closeCreating();
                  setNewName('');
                  setNewKind('');
                  setNewParentId('');
                  setCreateError(null);
                }}
              >
                Cancel
              </Btn>
              <Btn density="xs" className="text-xs" disabled={saving || !newName.trim()} onClick={createLocation}>
                {saving ? 'Creating…' : 'Create'}
              </Btn>
            </div>
          </div>
        )}

        {locations.length === 0 ? (
          <EmptyState icon="treasure-map" title="No locations yet" hint={isDm ? 'Add the first one above.' : 'The DM has not added any locations yet.'} />
        ) : (
          <div className="flex flex-col gap-2.5" style={{ maxWidth: 720 }}>
            {toTree(locations).map(({ loc, depth }) => (
              <ListDetailLink
                key={loc.id}
                to={`/c/${id}/locations/${loc.id}`}
                className="cf-card cf-card-hover cf-density-compact flex items-center gap-3"
                style={depth > 0 ? { marginLeft: depth * 20 } : undefined}
              >
                {depth > 0 && <span className="text-secondary shrink-0" aria-hidden>↳</span>}
                {loc.portraitUrl ? (
                  <img
                    src={loc.portraitUrl}
                    alt=""
                    className="h-9 w-9 shrink-0 rounded-md object-cover border border-[var(--color-divider)]"
                  />
                ) : (
                  <div className="h-9 w-9 shrink-0 rounded-md bg-[var(--color-neutral-900)] border border-[var(--color-divider)] flex items-center justify-center" aria-hidden>
                    <GameIcon slug="position-marker" size={UI_ICON_SIZE.sm} className="text-[var(--color-accent)]" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-bold text-slate-200 text-sm truncate cf-name-reveal" title={loc.name} aria-label={`Location: ${loc.name}`}>{loc.name}</p>
                    <Chip variant={statusVariant(loc.status)}><LocationStatusLabel status={loc.status} /></Chip>
                    {isDm && loc.status === 'unexplored' && (
                      <Chip variant="failed"><span className="inline-flex items-center gap-1"><GameIcon slug="sight-disabled" size={UI_ICON_SIZE.xs} /> Hidden from players</span></Chip>
                    )}
                    {isDm && loc.dmSecret && <Chip variant="proposal">DM secret</Chip>}
                  </div>
                  <p className="text-xs text-slate-400 truncate cf-name-reveal mt-0.5" title={loc.kind || firstLine(loc.body) || undefined} aria-label={loc.kind || firstLine(loc.body) || undefined}>{loc.kind || firstLine(loc.body) || ' '}</p>
                </div>
                {loc.mapX != null && loc.mapY != null && (
                  <span className="text-[11px] text-secondary shrink-0">
                    <GameIcon slug="position-marker" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />{Math.round(loc.mapX)},{Math.round(loc.mapY)}
                  </span>
                )}
              </ListDetailLink>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
