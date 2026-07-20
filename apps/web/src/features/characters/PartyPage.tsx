/**
 * Party roster — mirrors design/claude-design/Campfire.dc.html "Party roster" (~701-717):
 * a card grid, avatar + name/class/level/owner, HP bar, condition tags. Links to the sheet.
 * "+ New character" is offered to players without a character yet, and always to the DM.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { Character, CampaignMember } from '@campfire/schema';
import { levelForXp } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Btn, TextInput, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { avatarTone, initials } from './avatar';

export default function PartyPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const { me, roleIn } = useAuth();
  const role = roleIn(id);
  const isDm = role === 'dm';

  const [characters, setCharacters] = useState<Character[]>([]);
  const [members, setMembers] = useState<CampaignMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [awarding, setAwarding] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [chars, memberList] = await Promise.all([
        api.get<Character[]>(`${API}/campaigns/${id}/characters`),
        // Members list is available to every campaign role (not DM-only) — used
        // only to resolve a character's ownerUserId to a human-readable name below.
        api.get<CampaignMember[]>(`${API}/campaigns/${id}/members`).catch(() => [] as CampaignMember[]),
      ]);
      setCharacters(chars);
      setMembers(memberList);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load the party.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (Number.isFinite(id)) void load();
  }, [id, load]);

  function ownerLabel(ownerUserId: string | null): string | null {
    if (!ownerUserId) return null;
    const member = members.find((m) => String(m.userId) === ownerUserId);
    return member?.displayName || member?.username || null;
  }

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
    <div className="max-w-5xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-extrabold text-white">Party</h1>
        <div className="flex-1" />
        {isDm && !awarding && characters.length > 0 && (
          <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setAwarding(true)}>
            ✦ Award XP
          </Btn>
        )}
        {canCreate && !creating && characters.length > 0 && (
          <Btn className="!min-h-0 !py-1.5 text-xs" onClick={() => setCreating(true)}>
            + New character
          </Btn>
        )}
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      {isDm && awarding && <AwardXpForm campaignId={id} onCancel={() => setAwarding(false)} onAwarded={() => { setAwarding(false); void load(); }} />}

      {loading ? (
        <Card>
          <Skeleton lines={4} />
        </Card>
      ) : characters.length === 0 && !canCreate ? (
        <EmptyState icon="🛡️" title="No characters yet" hint="Ask the DM to add the party." />
      ) : (
        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {characters.map((c, i) => (
            <CharacterCard key={c.id} campaignId={id} character={c} index={i} ownerLabel={ownerLabel(c.ownerUserId)} />
          ))}
        </div>
      )}

      {canCreate && (creating || characters.length === 0) && (
        <NewCharacterForm campaignId={id} onCancel={characters.length > 0 ? () => setCreating(false) : undefined} onCreated={load} />
      )}
    </div>
  );
}

function CharacterCard({
  campaignId,
  character,
  index,
  ownerLabel,
}: {
  campaignId: number;
  character: Character;
  index: number;
  ownerLabel: string | null;
}) {
  const tone = avatarTone(index);
  const hpPct = character.hpMax > 0 ? Math.max(0, Math.min(100, (character.hpCurrent / character.hpMax) * 100)) : 0;
  return (
    <Link
      to={`/c/${campaignId}/characters/${character.id}`}
      className="cf-card p-3.5 space-y-2.5 hover:border-amber-500/50 transition-colors"
    >
      <div className="flex items-center gap-2.5">
        <div
          className={`h-10 w-10 shrink-0 rounded-full ${tone.bg} border ${tone.border} ${tone.text} text-[13px] font-semibold flex items-center justify-center`}
        >
          {initials(character.name)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-white text-[15px] truncate">{character.name}</p>
          <p className="text-[11.5px] text-slate-500 truncate">
            {character.className || 'Unknown class'} · Lv {character.level}
            {ownerLabel && ` · ${ownerLabel}`}
          </p>
        </div>
        {levelForXp(character.xp) > character.level && (
          <span className="tag tag-accent shrink-0" style={{ fontSize: 9.5 }} title={`${character.xp.toLocaleString()} XP — enough for level ${levelForXp(character.xp)}`}>
            ⬆ Level up
          </span>
        )}
      </div>
      <div className="flex justify-between text-[11.5px] text-slate-500">
        <span>HP</span>
        <span>
          {character.hpCurrent} / {character.hpMax}
        </span>
      </div>
      <div className="h-[5px] rounded-full bg-[var(--color-neutral-800)] overflow-hidden">
        <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${hpPct}%` }} />
      </div>
      {character.conditions.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          <span className="tag tag-outline" style={{ fontSize: 10 }}>
            {character.conditions.join(', ')}
          </span>
        </div>
      )}
    </Link>
  );
}

/** DM-only party XP award (issue #14) — one amount, everyone gets it. Per-character awards live on the sheet. */
function AwardXpForm({
  campaignId,
  onCancel,
  onAwarded,
}: {
  campaignId: number;
  onCancel: () => void;
  onAwarded: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const amountNum = Number(amount);
    if (!Number.isInteger(amountNum) || amountNum < 1) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/characters/xp`, { amount: amountNum });
      onAwarded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't award XP.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm">Award XP to the whole party</h2>
      {error && <p className="text-sm text-rose-400">{error}</p>}
      <form onSubmit={submit} className="flex gap-2 items-center flex-wrap">
        <div className="w-32">
          <TextInput
            type="number"
            min={1}
            aria-label="XP to award each character"
            placeholder="XP each"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoFocus
          />
        </div>
        <span className="text-xs text-slate-500">Every character gets this amount. Award individuals from their sheet.</span>
        <div className="flex-1" />
        <Btn ghost type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </Btn>
        <Btn type="submit" disabled={saving || !Number.isInteger(Number(amount)) || Number(amount) < 1}>
          {saving ? 'Awarding…' : 'Award'}
        </Btn>
      </form>
    </Card>
  );
}

function NewCharacterForm({
  campaignId,
  onCancel,
  onCreated,
}: {
  campaignId: number;
  onCancel?: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [species, setSpecies] = useState('');
  const [className, setClassName] = useState('');
  const [level, setLevel] = useState('1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
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
      onCancel?.();
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the character.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm">New character</h2>
      {error && <p className="text-sm text-rose-400">{error}</p>}
      <form onSubmit={submit} className="space-y-3">
        <TextInput aria-label="Character name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <TextInput aria-label="Species" placeholder="Species" value={species} onChange={(e) => setSpecies(e.target.value)} />
          <TextInput aria-label="Class" placeholder="Class" value={className} onChange={(e) => setClassName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            type="number"
            min={1}
            max={20}
            aria-label="Level"
            placeholder="Level"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          />
          <div />
        </div>
        <div className="flex gap-2 justify-end">
          {onCancel && (
            <Btn ghost type="button" onClick={onCancel} disabled={saving}>
              Cancel
            </Btn>
          )}
          <Btn type="submit" disabled={saving || !name.trim()}>
            {saving ? 'Creating…' : 'Create'}
          </Btn>
        </div>
      </form>
    </Card>
  );
}
