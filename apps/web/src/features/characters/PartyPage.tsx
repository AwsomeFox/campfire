/**
 * Party roster — mirrors design/claude-design/Campfire.dc.html "Party roster" (~701-717):
 * a card grid, avatar + name/class/level/owner, HP bar, condition tags. Links to the sheet.
 * "+ New character" is offered to every player and the DM. Players may own more than one
 * character (backup PC, familiar, companion) — the API allows it, so the UI no longer
 * silently caps a player at a single owned character (issue #129).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import type { Character, CampaignMember } from '@campfire/schema';
import { levelForXp, ddbImportSupported } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { usePollWhileVisible } from '../../lib/usePollWhileVisible';
import { useAuth } from '../../app/auth';
import { useCampaign } from '../../app/CampaignContext';
import { Card, Btn, TextInput, Skeleton, ErrorNote, EmptyState, HpBar } from '../../components/ui';
import { UndoSnackbar } from '../../components/UndoSnackbar';
import { avatarTone, initials } from './avatar';
import { CharacterTrashMenu } from './CharacterTrashMenu';
import { STATUS_LABEL, StatusTag } from './status';

export default function PartyPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const [searchParams, setSearchParams] = useSearchParams();
  const { me, roleIn } = useAuth();
  const role = roleIn(id);
  const isDm = role === 'dm';
  // The campaign record drives the D&D Beyond import affordance (issue #714): the importer
  // produces a 5e-shaped character, so it is only offered for an explicitly-D&D-5e campaign.
  // A homebrew campaign (no pack selected) resolves to 5e for combat math but is NOT treated
  // as explicitly 5e here, matching the server's compatibility gate.
  const campaign = useCampaign(id);
  const ddbAllowed = ddbImportSupported(campaign?.ruleSystem);

  const [characters, setCharacters] = useState<Character[]>([]);
  const [members, setMembers] = useState<CampaignMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Move-to-Trash from the roster (issue #716): a trashed card is removed from the
  // list immediately and an Undo snackbar offers a same-page restore. Delayed restore
  // remains available from the campaign Trash. Only one undo is outstanding at a time.
  const [pendingUndo, setPendingUndo] = useState<Character | null>(null);
  const awardXpRequested = searchParams.get('action') === 'award-xp';
  // Keep the URL authoritative so Back/Forward closes and reopens the deep-linked
  // form instead of leaving local state out of sync with browser history.
  const awarding = isDm && awardXpRequested;

  function setAwardingOpen(open: boolean) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (open) next.set('action', 'award-xp');
        else if (next.get('action') === 'award-xp') next.delete('action');
        return next;
      },
      { replace: !open },
    );
  }

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

  // Keep party HP live at the table (issue #113): poll ~5s while the tab is visible.
  // Paused while an undo is pending so a restore in flight isn't clobbered by a
  // fresh list fetch that hasn't yet observed the restored row.
  usePollWhileVisible(() => void load(), 5000, Number.isFinite(id) && !pendingUndo);

  // Roster trash (issue #716) — soft-delete the character, drop the card locally, and
  // surface an Undo. The card's own menu runs the DELETE; this handler is the page-level
  // seam that updates the list and owns the snackbar.
  function onCharacterTrashed(character: Character) {
    setCharacters((prev) => prev.filter((c) => c.id !== character.id));
    setPendingUndo(character);
  }

  async function undoTrash() {
    const trashed = pendingUndo;
    if (!trashed) return;
    await api.post(`${API}/characters/${trashed.id}/restore`);
    setPendingUndo(null);
    await load();
  }

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
  // A player may own multiple characters (backup PC, familiar, companion) — the API
  // allows it, so don't cap the button at one owned character (issue #129).
  const canCreate = isDm || role === 'player';

  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-extrabold text-white">Party</h1>
        <div className="flex-1" />
        {isDm && !awarding && characters.length > 0 && (
          <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setAwardingOpen(true)}>
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

      {isDm && awarding && (
        <AwardXpForm
          campaignId={id}
          characters={characters}
          onCancel={() => setAwardingOpen(false)}
          onAwarded={() => {
            setAwardingOpen(false);
            void load();
          }}
        />
      )}

      {loading ? (
        <Card>
          <Skeleton lines={4} />
        </Card>
      ) : characters.length === 0 && !canCreate ? (
        <EmptyState icon="shield" title="No characters yet" hint="Ask the DM to add the party." />
      ) : (
        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {characters.map((c, i) => (
            <CharacterCard
              key={c.id}
              campaignId={id}
              character={c}
              index={i}
              ownerLabel={ownerLabel(c.ownerUserId)}
              // Quick HP is offered on a card the viewer can edit: the DM (any card)
              // or a player on their own character (issue #68).
              canEditHp={isDm || (c.ownerUserId != null && myUserId != null && c.ownerUserId === String(myUserId))}
              // Move-to-Trash (issue #716): owner or DM only — the menu is not rendered
              // for an unrelated player, matching PATCH /characters/:id role gating.
              canTrash={isDm || (c.ownerUserId != null && myUserId != null && c.ownerUserId === String(myUserId))}
              onTrashed={onCharacterTrashed}
              onError={setError}
              onChange={load}
            />
          ))}
        </div>
      )}

      {canCreate && (creating || characters.length === 0) && (
        <NewCharacterForm campaignId={id} ddbAllowed={ddbAllowed} onCancel={characters.length > 0 ? () => setCreating(false) : undefined} onCreated={load} />
      )}

      {pendingUndo && (
        <UndoSnackbar
          message={`${pendingUndo.name} moved to the Trash.`}
          onUndo={undoTrash}
          onExpire={() => setPendingUndo(null)}
        />
      )}
    </div>
  );
}

function CharacterCard({
  campaignId,
  character,
  index,
  ownerLabel,
  canEditHp,
  canTrash,
  onTrashed,
  onError,
  onChange,
}: {
  campaignId: number;
  character: Character;
  index: number;
  ownerLabel: string | null;
  canEditHp: boolean;
  canTrash: boolean;
  onTrashed: (character: Character) => void;
  onError: (message: string | null) => void;
  onChange: () => void;
}) {
  const tone = avatarTone(index);
  // Dead/retired/inactive PCs (issue #115) are muted so a fallen or shelved character
  // is visually distinct from the live party, while staying fully viewable.
  const isActive = character.status === 'active';
  // Move-to-Trash (issue #716): the card owns its DELETE so the kebab can show a
  // busy state; on success it hands the trashed character up for the page-level
  // Undo snackbar + list removal.
  const [trashing, setTrashing] = useState(false);

  async function trash() {
    setTrashing(true);
    try {
      await api.delete(`${API}/characters/${character.id}`);
      onTrashed(character);
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't move this character to the Trash.");
    } finally {
      setTrashing(false);
    }
  }

  // The card stays a single click target to the sheet, but the quick-HP steppers
  // and the kebab menu are siblings of the Link (not nested inside it) — nesting
  // <button> inside an <a> is invalid and would hijack the navigation click (#68).
  return (
    <div className={`cf-card p-3.5 space-y-2.5 hover:border-amber-500/50 transition-colors ${isActive ? '' : 'opacity-60'}`}>
      <div className="relative">
        <Link to={`/c/${campaignId}/characters/${character.id}`} className="block space-y-2.5">
          <div className="flex items-center gap-2.5">
            <div
              className={`h-10 w-10 shrink-0 rounded-full ${tone.bg} border ${tone.border} ${tone.text} text-[13px] font-semibold flex items-center justify-center`}
            >
              {initials(character.name)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="font-bold text-white text-[15px] truncate">{character.name}</p>
                {!isActive && <StatusTag status={character.status} className="shrink-0" />}
              </div>
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
        <HpBar current={character.hpCurrent} max={character.hpMax} />
        {character.conditions.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            <span className="tag tag-outline" style={{ fontSize: 10 }}>
              {character.conditions.join(', ')}
            </span>
          </div>
        )}
        </Link>
        {canTrash && (
          <div className="absolute top-0 right-0">
            <CharacterTrashMenu
              characterName={character.name}
              busy={trashing}
              onTrash={trash}
              triggerLabel="roster card"
            />
          </div>
        )}
      </div>
      {canEditHp && <QuickHp character={character} onChange={onChange} />}
    </div>
  );
}

/**
 * Inline HP steppers on a Party card — ±5 / ±1 with shift-click ×5, mirroring the
 * sheet's HpEditor so quick out-of-combat tracking doesn't need a navigation to the
 * full sheet (issue #68). Posts to the existing POST /characters/:id/hp {delta}.
 */
function QuickHp({ character, onChange }: { character: Character; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function applyDelta(delta: number) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`${API}/characters/${character.id}/hp`, { delta });
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update HP.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        {([-5, -1, 1, 5] as const).map((step) => (
          <button
            key={step}
            type="button"
            className="btn btn-secondary !min-h-0"
            style={{ flex: 1, minHeight: 38, fontSize: 13, fontFamily: 'var(--font-heading)' }}
            disabled={busy}
            aria-label={`${step < 0 ? 'Reduce' : 'Increase'} ${character.name}'s HP by ${Math.abs(step)} (hold Shift for ${Math.abs(step) * 5}; currently ${character.hpCurrent} of ${character.hpMax})`}
            onClick={(e) => void applyDelta(e.shiftKey ? step * 5 : step)}
          >
            {step > 0 ? `+${step}` : `−${Math.abs(step)}`}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-[11px] text-rose-400">{error}</p>}
    </div>
  );
}

/**
 * DM-only party XP award (#14/#814). Active characters are selected by default;
 * every recipient is named with lifecycle status and before/after XP. Archived
 * careers stay disabled until the DM explicitly opts in, then must still be
 * individually selected.
 */
function AwardXpForm({
  campaignId,
  characters,
  onCancel,
  onAwarded,
}: {
  campaignId: number;
  characters: Character[];
  onCancel: () => void;
  onAwarded: () => void;
}) {
  const amountInputRef = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState('');
  const [includeNonActive, setIncludeNonActive] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(
    () => new Set(characters.filter((character) => character.status === 'active').map((character) => character.id)),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Route-driven hand-offs should land keyboard users directly in the task.
  // A frame delay wins over route/layout focus restoration after navigation.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => amountInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // Polling can refresh XP/status while this form is open. Keep the preview live,
  // drop removed characters, and never retain a newly non-active recipient unless
  // the explicit opt-in is still enabled. Do not auto-add new roster entries: the
  // visible selection is the exact request scope the DM will commit.
  useEffect(() => {
    const selectable = new Set(
      characters
        .filter((character) => includeNonActive || character.status === 'active')
        .map((character) => character.id),
    );
    setSelectedIds((current) => new Set([...current].filter((id) => selectable.has(id))));
  }, [characters, includeNonActive]);

  const amountNum = Number(amount);
  const validAmount = Number.isInteger(amountNum) && amountNum >= 1 && amountNum <= 1_000_000;
  const recipients = characters.filter((character) => selectedIds.has(character.id));

  function selectRecipient(character: Character, selected: boolean) {
    if (character.status !== 'active' && !includeNonActive) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(character.id);
      else next.delete(character.id);
      return next;
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!validAmount || recipients.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/characters/xp`, {
        amount: amountNum,
        characterIds: recipients.map((character) => character.id),
        ...(includeNonActive ? { includeNonActive: true } : {}),
      });
      onAwarded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't award XP.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="party-xp-card space-y-3">
      <div className="space-y-1">
        <h2 className="font-bold text-white text-sm">Award party XP</h2>
        <p className="text-xs text-slate-400">Active characters are selected by default. Review the exact recipients and resulting XP before awarding.</p>
      </div>
      {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
      <form id="party-xp-form" onSubmit={submit} className="space-y-4">
        <div className="w-40">
          <TextInput
            ref={amountInputRef}
            type="number"
            min={1}
            max={1_000_000}
            aria-label="XP to award each character"
            placeholder="XP each"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoFocus
          />
        </div>

        <fieldset className="space-y-3">
          <legend className="text-xs font-bold uppercase tracking-wide text-slate-400">Recipients</legend>
          <label className="flex items-start gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={includeNonActive}
              onChange={(event) => setIncludeNonActive(event.target.checked)}
              disabled={saving}
            />
            <span>
              Include inactive, retired, or dead characters
              <span className="block text-xs text-slate-400">Required for deliberate historical corrections; each must still be selected below.</span>
            </span>
          </label>

          <div className="overflow-x-auto rounded-md border border-slate-700/60">
            <table className="w-full text-sm">
              <thead className="bg-slate-900/40 text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th scope="col" className="px-3 py-2">Recipient</th>
                  <th scope="col" className="px-3 py-2">Status</th>
                  <th scope="col" className="px-3 py-2 text-right">Current XP</th>
                  <th scope="col" className="px-3 py-2 text-right">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {characters.map((character) => {
                  const selected = selectedIds.has(character.id);
                  const nonActiveLocked = character.status !== 'active' && !includeNonActive;
                  return (
                    <tr key={character.id} className={!selected ? 'text-slate-400' : 'text-slate-200'}>
                      <td className="px-3 py-2">
                        <label className="flex items-center gap-2 font-semibold">
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={saving || nonActiveLocked}
                            onChange={(event) => selectRecipient(character, event.target.checked)}
                            aria-label={`Select ${character.name} (${STATUS_LABEL[character.status]}) for XP award`}
                          />
                          <span>{character.name}</span>
                        </label>
                      </td>
                      <td className="px-3 py-2">{STATUS_LABEL[character.status]}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{character.xp.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">
                        {selected && validAmount ? (character.xp + amountNum).toLocaleString() : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </fieldset>

        <div className="flex gap-2 items-center flex-wrap">
          <p aria-live="polite" className="text-xs text-slate-400">
            {recipients.length === 0
              ? 'Select at least one recipient.'
              : `${recipients.length} recipient${recipients.length === 1 ? '' : 's'} selected.`}
          </p>
          <div className="flex-1" />
          <Btn ghost type="button" onClick={onCancel} disabled={saving}>Cancel</Btn>
          <Btn type="submit" disabled={saving || !validAmount || recipients.length === 0}>
            {saving ? 'Awarding…' : `Award XP to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`}
          </Btn>
        </div>
      </form>
    </Card>
  );
}

function NewCharacterForm({
  campaignId,
  ddbAllowed,
  onCancel,
  onCreated,
}: {
  campaignId: number;
  /**
   * Whether the campaign's rule system is field-compatible with the D&D Beyond importer
   * (issue #714). False hides the import affordance entirely; the server re-checks this on
   * the request, so a stale/hidden UI can't sneak an incompatible import through.
   */
  ddbAllowed: boolean;
  onCancel?: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [species, setSpecies] = useState('');
  const [className, setClassName] = useState('');
  const [level, setLevel] = useState('1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ddbRef, setDdbRef] = useState('');
  const [importing, setImporting] = useState(false);

  // Import a PUBLIC D&D Beyond sheet (issue #18): POST the id or character URL and let the
  // server fetch + map it into a character. The sheet must be set to Public on D&D Beyond;
  // private/not-found sheets come back as a clean 400/404 the ApiError message surfaces.
  async function importFromDdb() {
    const ref = ddbRef.trim();
    if (!ref) return;
    setImporting(true);
    setError(null);
    try {
      // Send `url` when it looks like a link, else the bare id — the server accepts either.
      const body = /^\d+$/.test(ref) ? { ddbId: ref } : { url: ref };
      await api.post(`${API}/campaigns/${campaignId}/characters/import-ddb`, body);
      setDdbRef('');
      onCancel?.();
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't import from D&D Beyond.");
    } finally {
      setImporting(false);
    }
  }

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

      {/* Import from D&D Beyond (issue #18) — read-only, public sheets only.
          Offered only for explicitly-D&D-5e campaigns (issue #714): a DDB sheet is a 5e
          character, so importing into another system would silently produce a character
          whose numbers belong to a different game. The server re-checks compatibility, so
          a stale UI can't bypass it. */}
      {ddbAllowed && (
        <div className="space-y-2 rounded-md border border-slate-700/60 p-3">
          <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">Import from D&amp;D Beyond</span>
          <div className="flex gap-2">
            <TextInput
              aria-label="D&D Beyond character id or URL"
              placeholder="D&D Beyond id or character URL"
              value={ddbRef}
              onChange={(e) => setDdbRef(e.target.value)}
              maxLength={500}
            />
            <Btn type="button" onClick={importFromDdb} disabled={importing || !ddbRef.trim()}>
              {importing ? 'Importing…' : 'Import'}
            </Btn>
          </div>
          <p className="text-xs text-slate-500">The sheet must be set to Public on D&amp;D Beyond.</p>
        </div>
      )}

      {ddbAllowed && (
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <span className="h-px flex-1 bg-slate-700/60" />
          or create manually
          <span className="h-px flex-1 bg-slate-700/60" />
        </div>
      )}

      <form onSubmit={submit} className="space-y-3">
        <TextInput aria-label="Character name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <TextInput aria-label="Species" placeholder="Species" value={species} onChange={(e) => setSpecies(e.target.value)} />
          <TextInput aria-label="Class" placeholder="Class" value={className} onChange={(e) => setClassName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">Level</span>
            <TextInput
              type="number"
              min={1}
              max={20}
              aria-label="Level"
              placeholder="Level"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
            />
          </label>
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
