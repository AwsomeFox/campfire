/**
 * NPC roster — card grid, mirrors the dashboard's "🤝 NPCs" section styling.
 * DM can inline-create (name + role); everyone can browse & open a detail page.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Npc } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextInput, Skeleton, ErrorNote, EmptyState, statusVariant } from '../../components/ui';

function firstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 0);
  return line?.trim() ?? '';
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
      setNpcs(await api.get<Npc[]>(`${API}/campaigns/${id}/npcs`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load NPCs.");
    } finally {
      setLoading(false);
    }
  }, [id]);

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
            <TextInput placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
            <TextInput placeholder="Role (e.g. Townmaster)" value={newRole} onChange={(e) => setNewRole(e.target.value)} />
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
          <div className="grid sm:grid-cols-2 gap-3">
            {npcs.map((npc) => (
              <a
                key={npc.id}
                href={`/c/${id}/npcs/${npc.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/c/${id}/npcs/${npc.id}`);
                }}
                className="cf-inset p-3.5 space-y-1 hover:border-amber-500/50"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="font-bold text-slate-200 text-sm truncate">{npc.name}</p>
                  <Chip variant={dispositionVariant(npc.disposition)}>{npc.disposition || 'Neutral'}</Chip>
                </div>
                {npc.role && <p className="text-[11px] text-slate-500">{npc.role}</p>}
                {firstLine(npc.body) && <p className="text-xs text-slate-400 line-clamp-2">{firstLine(npc.body)}</p>}
              </a>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
