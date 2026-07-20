/**
 * NPC roster — mirrors design/claude-design/Campfire.dc.html "World" NPC tab (~1239-1258):
 * a compact card grid, avatar + name/role, disposition badge + last-seen location.
 * DM can inline-create (name + role); everyone can browse & open a detail page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Location, Npc } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextInput, Skeleton, ErrorNote, EmptyState, statusVariant } from '../../components/ui';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function dispositionVariant(disposition: string) {
  const d = disposition.toLowerCase();
  if (d.includes('friend') || d.includes('ally') || d.includes('trust')) return 'completed' as const;
  if (d.includes('hostile') || d.includes('enemy') || d.includes('wary')) return 'failed' as const;
  if (d.includes('warm') || d.includes('active')) return 'active' as const;
  return statusVariant(disposition);
}

export default function NpcListPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const navigate = useNavigate();
  const { roleIn } = useAuth();
  const role = roleIn(id);
  const isDm = role === 'dm';

  const [npcs, setNpcs] = useState<Npc[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [npcData, locationData] = await Promise.all([
        api.get<Npc[]>(`${API}/campaigns/${id}/npcs`),
        api.get<Location[]>(`${API}/campaigns/${id}/locations`),
      ]);
      setNpcs(npcData);
      setLocations(locationData);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load NPCs.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  const locationName = useMemo(() => {
    const byId = new Map(locations.map((l) => [l.id, l.name]));
    return (locationId: number | null) => (locationId ? byId.get(locationId) : undefined);
  }, [locations]);

  useEffect(() => {
    if (Number.isFinite(id)) void load();
  }, [id, load]);

  async function createNpc() {
    if (!newName.trim()) return;
    setSaving(true);
    setCreateError(null);
    try {
      const npc = await api.post<Npc>(`${API}/campaigns/${id}/npcs`, { name: newName.trim(), role: newRole.trim() });
      setNewName('');
      setNewRole('');
      setCreating(false);
      await load();
      navigate(`/c/${id}/npcs/${npc.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Couldn't create the NPC.");
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

  if (loading && npcs.length === 0 && !error) {
    return (
      <div className="max-w-7xl mx-auto px-4 mt-5">
        <Card>
          <Skeleton lines={5} />
        </Card>
      </div>
    );
  }

  if (error && npcs.length === 0) {
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
          <h1 className="font-bold text-white text-lg flex items-center gap-2">🤝 NPCs</h1>
          {isDm && !creating && (
            <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setCreating(true)}>
              + New NPC
            </Btn>
          )}
        </div>

        {isDm && creating && (
          <div className="cf-inset p-3.5 space-y-2">
            {createError && <ErrorNote message={createError} />}
            <TextInput aria-label="NPC name" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} autoFocus />
            <TextInput aria-label="NPC role" placeholder="Role (e.g. Townmaster)" value={newRole} onChange={(e) => setNewRole(e.target.value)} />
            <div className="flex items-center justify-end gap-2">
              <Btn
                ghost
                className="!min-h-0 !py-1.5 text-xs"
                onClick={() => {
                  setCreating(false);
                  setNewName('');
                  setNewRole('');
                  setCreateError(null);
                }}
              >
                Cancel
              </Btn>
              <Btn className="!min-h-0 !py-1.5 text-xs" disabled={saving || !newName.trim()} onClick={createNpc}>
                {saving ? 'Creating…' : 'Create'}
              </Btn>
            </div>
          </div>
        )}

        {npcs.length === 0 ? (
          <EmptyState icon="🤝" title="No NPCs yet" hint={isDm ? 'Add the first one above.' : 'The DM has not added any NPCs yet.'} />
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }}>
            {npcs.map((npc) => (
              <a
                key={npc.id}
                href={`/c/${id}/npcs/${npc.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/c/${id}/npcs/${npc.id}`);
                }}
                className="cf-card p-3.5 space-y-2 hover:border-amber-500/50"
              >
                <div className="flex items-center gap-2.5">
                  <span className="h-9 w-9 shrink-0 rounded-full bg-[var(--color-neutral-900)] border border-[var(--color-divider)] flex items-center justify-center text-[13px] text-[var(--color-neutral-400)]">
                    {initials(npc.name)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-slate-200 text-sm truncate">{npc.name}</p>
                    {npc.role && <p className="text-[11.5px] text-slate-500 truncate">{npc.role}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Chip variant={dispositionVariant(npc.disposition)}>{npc.disposition || 'Neutral'}</Chip>
                  {isDm && npc.hidden && <Chip variant="failed">🙈 Hidden</Chip>}
                  {isDm && npc.dmSecret && <Chip variant="proposal">DM secret</Chip>}
                  {locationName(npc.locationId) && (
                    <span className="text-[11px] text-slate-500 ml-auto">{locationName(npc.locationId)}</span>
                  )}
                </div>
              </a>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
