/**
 * Party roster — one card per character in the campaign, linking to the character sheet.
 * "+ New character" is offered to players without a character yet, and always to the DM.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { Character } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextInput, HpBar, Skeleton, ErrorNote, EmptyState, statusVariant } from '../../components/ui';
import { avatarTone, initials } from './avatar';

export default function PartyPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const { me, roleIn } = useAuth();
  const role = roleIn(id);
  const isDm = role === 'dm';

  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<Character[]>(`${API}/campaigns/${id}/characters`);
      setCharacters(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load the party.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (Number.isFinite(id)) void load();
  }, [id, load]);

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  const myUserId = me?.user.id;
  const hasOwnCharacter = characters.some((c) => c.ownerUserId != null && myUserId != null && c.ownerUserId === String(myUserId));
  const canCreate = isDm || (role === 'player' && !hasOwnCharacter);

  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-extrabold text-white">Party</h1>
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      {loading ? (
        <Card>
          <Skeleton lines={4} />
        </Card>
      ) : characters.length === 0 && !canCreate ? (
        <EmptyState icon="🛡️" title="No characters yet" hint="Ask the DM to add the party." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {characters.map((c, i) => (
            <CharacterCard key={c.id} campaignId={id} character={c} index={i} />
          ))}
        </div>
      )}

      {canCreate && <NewCharacterForm campaignId={id} creating={creating} setCreating={setCreating} onCreated={load} />}
    </div>
  );
}

function CharacterCard({ campaignId, character, index }: { campaignId: number; character: Character; index: number }) {
  const tone = avatarTone(index);
  return (
    <Link
      to={`/c/${campaignId}/characters/${character.id}`}
      className="cf-card p-4 flex gap-4 items-start hover:border-amber-500/50 transition-colors"
    >
      <div
        className={`h-14 w-14 rounded-2xl ${tone.bg} border ${tone.border} ${tone.text} text-sm font-bold flex items-center justify-center shrink-0`}
      >
        {initials(character.name)}
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <p className="font-bold text-white truncate">{character.name}</p>
        </div>
        <p className="text-xs text-slate-400 truncate">
          {character.species || 'Unknown species'} ·{' '}
          <span className="font-semibold text-slate-300">
            {character.className || 'Unknown class'} {character.level}
          </span>
        </p>
        {character.ownerUserId && <p className="text-[10px] text-slate-600">Owner: {character.ownerUserId}</p>}
        {character.conditions.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {character.conditions.map((cond) => (
              <Chip key={cond} variant={statusVariant('failed')}>
                {cond}
              </Chip>
            ))}
          </div>
        )}
        <div className="space-y-1 pt-1">
          <HpBar current={character.hpCurrent} max={character.hpMax} />
          <p className="text-[11px] text-slate-500">
            {character.hpCurrent} <span className="text-slate-600">/ {character.hpMax}</span>
          </p>
        </div>
      </div>
    </Link>
  );
}

function NewCharacterForm({
  campaignId,
  creating,
  setCreating,
  onCreated,
}: {
  campaignId: number;
  creating: boolean;
  setCreating: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [species, setSpecies] = useState('');
  const [className, setClassName] = useState('');
  const [level, setLevel] = useState('1');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/characters`, {
        name: name.trim(),
        species: species.trim(),
        className: className.trim(),
        level: Math.max(1, Math.min(20, Number(level) || 1)),
      });
      setName('');
      setSpecies('');
      setClassName('');
      setLevel('1');
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the character.");
    } finally {
      setCreating(false);
    }
  }

  if (!open) {
    return (
      <Btn onClick={() => setOpen(true)} className="w-full sm:w-auto">
        + New character
      </Btn>
    );
  }

  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm">New character</h2>
      {error && <p className="text-sm text-rose-400">{error}</p>}
      <form onSubmit={submit} className="space-y-3">
        <TextInput placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <TextInput placeholder="Species" value={species} onChange={(e) => setSpecies(e.target.value)} />
          <TextInput placeholder="Class" value={className} onChange={(e) => setClassName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            type="number"
            min={1}
            max={20}
            placeholder="Level"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          />
          <div />
        </div>
        <div className="flex gap-2 justify-end">
          <Btn ghost type="button" onClick={() => setOpen(false)} disabled={creating}>
            Cancel
          </Btn>
          <Btn type="submit" disabled={creating || !name.trim()}>
            {creating ? 'Creating…' : 'Create'}
          </Btn>
        </div>
      </form>
    </Card>
  );
}
