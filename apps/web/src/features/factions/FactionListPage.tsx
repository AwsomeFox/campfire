/**
 * Faction/organization roster (issue #221) — mirrors NpcListPage: a compact card
 * grid with name/kind, a party-standing badge (hostile→allied + numeric reputation),
 * and DM-only hidden/secret chips. DM can inline-create (name + kind); everyone can
 * browse & open a detail page.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Faction, FactionStanding } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextInput, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function standingVariant(standing: FactionStanding) {
  switch (standing) {
    case 'allied':
    case 'friendly':
      return 'completed' as const;
    case 'hostile':
    case 'unfriendly':
      return 'failed' as const;
    default:
      return 'active' as const;
  }
}

export default function FactionListPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const navigate = useNavigate();
  const { roleIn } = useAuth();
  const role = roleIn(id);
  const isDm = role === 'dm';

  const [factions, setFactions] = useState<Faction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('');
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
      const faction = await api.post<Faction>(`${API}/campaigns/${id}/factions`, { name: newName.trim(), kind: newKind.trim() });
      setNewName('');
      setNewKind('');
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
        <div className="flex items-center justify-between border-b border-slate-700 pb-3">
          <h1 className="font-bold text-white text-lg flex items-center gap-2"><GameIcon slug="black-flag" size={18} /> Factions</h1>
          {isDm && !creating && (
            <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setCreating(true)}>
              + New faction
            </Btn>
          )}
        </div>

        {isDm && creating && (
          <div className="cf-inset p-3.5 space-y-2">
            {createError && <ErrorNote message={createError} />}
            <TextInput aria-label="Faction name" placeholder="Name (e.g. Thieves' Guild)" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} autoFocus />
            <TextInput aria-label="Faction kind" placeholder="Kind (e.g. guild, cult, government)" value={newKind} onChange={(e) => setNewKind(e.target.value)} maxLength={60} />
            <div className="flex items-center justify-end gap-2">
              <Btn
                ghost
                className="!min-h-0 !py-1.5 text-xs"
                onClick={() => {
                  setCreating(false);
                  setNewName('');
                  setNewKind('');
                  setCreateError(null);
                }}
              >
                Cancel
              </Btn>
              <Btn className="!min-h-0 !py-1.5 text-xs" disabled={saving || !newName.trim()} onClick={createFaction}>
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
              <a
                key={faction.id}
                href={`/c/${id}/factions/${faction.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/c/${id}/factions/${faction.id}`);
                }}
                className="cf-card p-3.5 space-y-2 hover:border-amber-500/50"
              >
                <div className="flex items-center gap-2.5">
                  <span className="h-9 w-9 shrink-0 rounded-full bg-[var(--color-neutral-900)] border border-[var(--color-divider)] flex items-center justify-center text-[13px] text-[var(--color-neutral-400)]">
                    {initials(faction.name)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-slate-200 text-sm truncate">{faction.name}</p>
                    {faction.kind && <p className="text-[11.5px] text-slate-500 truncate">{faction.kind}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Chip variant={standingVariant(faction.standing)}>
                    {faction.standing} · {faction.reputation > 0 ? `+${faction.reputation}` : faction.reputation}
                  </Chip>
                  {isDm && faction.hidden && <Chip variant="failed"><span className="inline-flex items-center gap-1"><GameIcon slug="sight-disabled" size={12} /> Hidden</span></Chip>}
                  {isDm && faction.dmSecret && <Chip variant="proposal">DM secret</Chip>}
                </div>
              </a>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
