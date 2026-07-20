/**
 * Location roster — mirrors design/claude-design/Campfire.dc.html "World" Locations tab
 * (~1259-1271): a stacked row list, name + status chip + DM-secret tag, body preview.
 * DM can inline-create (name + kind); everyone can browse & open a detail page.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Location } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextInput, Skeleton, ErrorNote, EmptyState, statusVariant } from '../../components/ui';

function firstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 0);
  return line?.trim() ?? '';
}

const statusLabel: Record<Location['status'], string> = {
  unexplored: 'Unexplored',
  explored: 'Explored',
  current: '📍 Current',
};

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
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const navigate = useNavigate();
  const { roleIn } = useAuth();
  const role = roleIn(id);
  const isDm = role === 'dm';

  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('');
  const [newParentId, setNewParentId] = useState('');
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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
      setCreating(false);
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
        <div className="flex items-center justify-between border-b border-slate-700 pb-3">
          <h1 className="font-bold text-white text-lg flex items-center gap-2">
            🗺 World <span className="text-slate-500 font-normal text-sm">· Locations</span>
          </h1>
          <Link to={`/c/${id}/npcs`} className="btn btn-ghost" style={{ fontSize: 12 }}>
            NPCs →
          </Link>
          {isDm && !creating && (
            <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setCreating(true)}>
              + New location
            </Btn>
          )}
        </div>

        {isDm && creating && (
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
              <Btn
                ghost
                className="!min-h-0 !py-1.5 text-xs"
                onClick={() => {
                  setCreating(false);
                  setNewName('');
                  setNewKind('');
                  setNewParentId('');
                  setCreateError(null);
                }}
              >
                Cancel
              </Btn>
              <Btn className="!min-h-0 !py-1.5 text-xs" disabled={saving || !newName.trim()} onClick={createLocation}>
                {saving ? 'Creating…' : 'Create'}
              </Btn>
            </div>
          </div>
        )}

        {locations.length === 0 ? (
          <EmptyState icon="🗺" title="No locations yet" hint={isDm ? 'Add the first one above.' : 'The DM has not added any locations yet.'} />
        ) : (
          <div className="flex flex-col gap-2.5" style={{ maxWidth: 720 }}>
            {toTree(locations).map(({ loc, depth }) => (
              <a
                key={loc.id}
                href={`/c/${id}/locations/${loc.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/c/${id}/locations/${loc.id}`);
                }}
                className="cf-card flex items-center gap-3 p-3.5 hover:border-amber-500/50"
                style={depth > 0 ? { marginLeft: depth * 20 } : undefined}
              >
                {depth > 0 && <span className="text-slate-600 shrink-0" aria-hidden>↳</span>}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-bold text-slate-200 text-sm truncate">{loc.name}</p>
                    <Chip variant={statusVariant(loc.status)}>{statusLabel[loc.status]}</Chip>
                    {isDm && loc.status === 'unexplored' && (
                      <Chip variant="failed">🙈 Hidden from players</Chip>
                    )}
                    {isDm && loc.dmSecret && <Chip variant="proposal">DM secret</Chip>}
                  </div>
                  <p className="text-xs text-slate-400 truncate mt-0.5">{loc.kind || firstLine(loc.body) || ' '}</p>
                </div>
                {loc.mapX != null && loc.mapY != null && (
                  <span className="text-[11px] text-slate-500 shrink-0">
                    📍 {Math.round(loc.mapX)},{Math.round(loc.mapY)}
                  </span>
                )}
              </a>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
