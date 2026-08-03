/**
 * Party roster — mirrors design/claude-design/Campfire.dc.html "Party roster" (~701-717):
 * a card grid, avatar + name/class/level/owner, HP bar, condition tags. Links to the sheet.
 * "+ New character" is offered to every player and the DM. Players may own more than one
 * character (backup PC, familiar, companion) — the API allows it, so the UI no longer
 * silently caps a player at a single owned character (issue #129).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router-dom';
import { ListDetailLink } from '../../components/ListDetailLink';
import { useRestoreListOriginScroll } from '../../hooks/useRestoreListOriginScroll';
import type { Character, CampaignMember, PartyCharacter, RuleSystemAdapter } from '@campfire/schema';
import { levelForXpForAdapter, ddbImportSupported, ruleSystemAdapter, xpProgressionSupported } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { usePollWhileVisible } from '../../lib/usePollWhileVisible';
import { useCampaignEvents } from '../../lib/useCampaignEvents';
import { useAuth } from '../../app/auth';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { useCampaign } from '../../app/CampaignContext';
import { Card, Btn, TextInput, Skeleton, ErrorNote, EmptyState, HpBar } from '../../components/ui';
import { formatNumber } from '../../lib/format';
import { PageHeader, type PageHeaderSecondaryAction } from '../../components/PageHeader';
import { CampaignCover } from '../../components/CampaignCover';
import { UndoSnackbar } from '../../components/UndoSnackbar';
import { avatarTone, initials } from './avatar';
import { CharacterTrashMenu } from './CharacterTrashMenu';
import { NewCharacterForm } from './NewCharacterForm';
import { STATUS_LABEL, StatusTag } from './status';
import { PartyRestPanel } from './PartyRestPanel';

export default function PartyPage() {
  const { t } = useTranslation();
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const [searchParams, setSearchParams] = useSearchParams();
  const { me } = useAuth();
  const { canDmWrite, canPlayerWrite } = useCampaignAccess();
  useRestoreListOriginScroll();
  // The campaign record drives the D&D Beyond import affordance (issue #714): the importer
  // produces a 5e-shaped character, so it is only offered for an explicitly-D&D-5e campaign.
  // A homebrew campaign (no pack selected) resolves to 5e for combat math but is NOT treated
  // as explicitly 5e here, matching the server's compatibility gate.
  const campaign = useCampaign(id);
  const ddbAllowed = ddbImportSupported(campaign?.ruleSystem);
  const adapter = ruleSystemAdapter(campaign?.ruleSystem);

  // Full sheets are caller-scoped. The separate roster lets every member see the
  // party without widening those sheets (and stays light enough for the 5s poll).
  const [fullCharacters, setFullCharacters] = useState<Character[]>([]);
  const [party, setParty] = useState<PartyCharacter[]>([]);
  const [members, setMembers] = useState<CampaignMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(() => searchParams.get('action') === 'new');
  const [resting, setResting] = useState(false);

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
  // Move-to-Trash from the roster (issue #716): a trashed card is removed from the
  // list immediately and an Undo snackbar offers a same-page restore. Delayed restore
  // remains available from the campaign Trash. Only one undo is outstanding at a time.
  const [pendingUndo, setPendingUndo] = useState<Character | null>(null);
  const awardXpRequested = searchParams.get('action') === 'award-xp';
  const suggestedXpAmount = searchParams.get('amount');
  // Keep the URL authoritative so Back/Forward closes and reopens the deep-linked
  // form instead of leaving local state out of sync with browser history.
  const awarding = canDmWrite && awardXpRequested;

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
      const [chars, roster, memberList] = await Promise.all([
        api.get<Character[]>(`${API}/campaigns/${id}/characters`),
        api.get<PartyCharacter[]>(`${API}/campaigns/${id}/characters/roster`),
        // Members list is available to every campaign role (not DM-only) — used
        // only to resolve a character's ownerUserId to a human-readable name below.
        api.get<CampaignMember[]>(`${API}/campaigns/${id}/members`).catch(() => [] as CampaignMember[]),
      ]);
      setFullCharacters(chars);
      setParty(roster);
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
  useCampaignEvents(Number.isFinite(id) ? id : undefined, {
    onEvent: useCallback((event) => {
      if (event.type === 'party.rest.updated' || event.type === 'character.updated') void load();
    }, [load]),
  });

  // Roster trash (issue #716) — soft-delete the character, drop the card locally, and
  // surface an Undo. The card's own menu runs the DELETE; this handler is the page-level
  // seam that updates the list and owns the snackbar.
  function onCharacterTrashed(character: Character) {
    setFullCharacters((prev) => prev.filter((c) => c.id !== character.id));
    setParty((prev) => prev.filter((c) => c.id !== character.id));
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
  const canCreate = canPlayerWrite;

  const secondaryActions: PageHeaderSecondaryAction[] =
    canDmWrite && !awarding && party.length > 0
      ? [{ key: 'award-xp', label: '✦ Award XP', onClick: () => setAwardingOpen(true) }, { key: 'rest-party', label: 'Rest party', onClick: () => setResting(true) }]
      : [];

  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      <CampaignCover campaignId={id} name={campaign?.name ?? 'Campaign'} variant="strip" showMonogram={false} />
      <PageHeader
        title={t('nav.party')}
        secondaryActions={secondaryActions}
        primaryAction={
          canCreate && !creating && party.length > 0 ? (
            <Btn type="button" className="cf-page-header__action" onClick={() => setCreating(true)}>
              + New character
            </Btn>
          ) : undefined
        }
      />

      {error && <ErrorNote message={error} onRetry={load} />}

      {canDmWrite && awarding && (
        <AwardXpForm
          campaignId={id}
          characters={fullCharacters}
          initialAmount={suggestedXpAmount}
          onCancel={() => setAwardingOpen(false)}
          onAwarded={() => {
            setAwardingOpen(false);
            void load();
          }}
        />
      )}
      {canDmWrite && resting && <PartyRestPanel campaignId={id} characters={fullCharacters} onClose={() => setResting(false)} onApplied={() => { void load(); }} />}

      {loading ? (
        <Card>
          <Skeleton lines={4} />
        </Card>
      ) : party.length === 0 && !canCreate ? (
        <EmptyState icon="shield" title="No characters yet" hint="Ask the DM to add the party." />
      ) : (
        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {party.map((rosterCharacter, i) => {
            const fullCharacter = fullCharacters.find((character) => character.id === rosterCharacter.id);
            return fullCharacter ? (
              <CharacterCard
                key={fullCharacter.id}
                campaignId={id}
                character={fullCharacter}
                adapter={adapter}
                index={i}
                ownerLabel={ownerLabel(fullCharacter.ownerUserId)}
                // Quick HP is offered on a card the viewer can edit: the DM (any card)
                // or a player on their own character (issue #68).
                canEditHp={canDmWrite || (canPlayerWrite && fullCharacter.ownerUserId != null && myUserId != null && fullCharacter.ownerUserId === String(myUserId))}
                // Move-to-Trash (issue #716): owner or DM only — the menu is not rendered
                // for an unrelated player, matching PATCH /characters/:id role gating.
                canTrash={canDmWrite || (canPlayerWrite && fullCharacter.ownerUserId != null && myUserId != null && fullCharacter.ownerUserId === String(myUserId))}
                onTrashed={onCharacterTrashed}
                onError={setError}
                onChange={load}
              />
            ) : (
              <RosterCharacterCard key={rosterCharacter.id} character={rosterCharacter} index={i} adapter={adapter} />
            );
          })}
        </div>
      )}

      {/* Wait for the roster load so an empty-state create form (autoFocus) does not
          flash during loading and steal route-change focus from the page h1 (#591). */}
      {canCreate && !loading && (creating || party.length === 0) && (
        <NewCharacterForm
          campaignId={id}
          adapter={adapter}
          ddbAllowed={ddbAllowed}
          onCancel={party.length > 0 ? closeCreating : undefined}
          onCreated={() => {
            closeCreating();
            void load();
          }}
          // Issue #1903 review: pin the form open via `creating` the instant a DDB import
          // succeeds, independent of `party.length`. Without this, importing into an
          // initially-EMPTY party (form open only because party.length === 0, not via
          // `creating`) unmounts the form the moment the reload's `character.updated`
          // brings party.length to 1 — discarding the import summary before it's read.
          onImportSucceeded={() => setCreating(true)}
        />
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

/** A teammate's roster entry is deliberately read-only and not a sheet link. */
function RosterCharacterCard({
  character,
  adapter,
  index,
}: {
  character: PartyCharacter;
  adapter: RuleSystemAdapter;
  index: number;
}) {
  const tone = avatarTone(index);
  const isActive = character.status === 'active';
  const classField = adapter.characterSheet?.classField ?? { label: 'Class', placeholder: 'Class', required: true, visible: true };
  const classSummary = classField.visible && character.className.trim()
    ? `${character.className} · `
    : classField.visible
      ? `${classField.label} not set · `
      : '';

  return (
    <Card density="compact" className={`space-y-2.5 ${isActive ? '' : 'opacity-60'}`} aria-label={`${character.name}, roster entry`}>
      <div className="flex items-center gap-2.5">
        {character.portraitUrl ? (
          <img src={character.portraitUrl} alt="" className={`h-10 w-10 shrink-0 rounded-full object-cover border ${tone.border}`} />
        ) : (
          <div className={`h-10 w-10 shrink-0 rounded-full ${tone.bg} border ${tone.border} ${tone.text} text-[13px] font-semibold flex items-center justify-center`}>
            {initials(character.name)}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="font-bold text-white text-[15px] truncate cf-name-reveal" title={character.name} aria-label={character.name}>{character.name}</p>
            {!isActive && <StatusTag status={character.status} className="shrink-0" />}
          </div>
          <p className="text-[11.5px] text-secondary truncate cf-name-reveal" title={`${classSummary}Lv ${character.level}`}>
            {classSummary}Lv {character.level}
          </p>
        </div>
      </div>
      <div className="flex justify-between text-[11.5px] text-secondary">
        <span>HP</span>
        <span>{character.hpMax > 0 ? `${character.hpCurrent} / ${character.hpMax}` : 'Not set'}</span>
      </div>
      {character.hpMax > 0 ? <HpBar current={character.hpCurrent} max={character.hpMax} /> : <p className="text-[10px] text-secondary">Complete HP on the sheet</p>}
      {character.conditions.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          <span className="tag tag-outline" style={{ fontSize: 10 }}>{character.conditions.join(', ')}</span>
        </div>
      )}
    </Card>
  );
}

function CharacterCard({
  campaignId,
  character,
  adapter,
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
  adapter: RuleSystemAdapter;
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

  const xpQualifiedLevel = xpProgressionSupported(adapter) ? levelForXpForAdapter(adapter, character.xp) : character.level;
  const classField = adapter.characterSheet?.classField ?? { label: 'Class', placeholder: 'Class', required: true, visible: true };
  const classSummary = classField.visible && character.className.trim()
    ? `${character.className} · `
    : classField.visible
      ? `${classField.label} not set · `
      : '';
  const summary = `${classSummary}Lv ${character.level}${ownerLabel ? ` · ${ownerLabel}` : ''}`;

  // The card stays a single click target to the sheet, but the quick-HP steppers
  // and the kebab menu are siblings of the Link (not nested inside it) — nesting
  // <button> inside an <a> is invalid and would hijack the navigation click (#68).
  return (
    <Card density="compact" hover className={`space-y-2.5 ${isActive ? '' : 'opacity-60'}`}>
      <div className="relative">
        <ListDetailLink to={`/c/${campaignId}/characters/${character.id}`} className="block space-y-2.5">
          <div className="flex items-center gap-2.5">
            {character.portraitUrl ? (
              <img
                src={character.portraitUrl}
                alt=""
                className={`h-10 w-10 shrink-0 rounded-full object-cover border ${tone.border}`}
              />
            ) : (
              <div
                className={`h-10 w-10 shrink-0 rounded-full ${tone.bg} border ${tone.border} ${tone.text} text-[13px] font-semibold flex items-center justify-center`}
              >
                {initials(character.name)}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="font-bold text-white text-[15px] truncate cf-name-reveal" title={character.name} aria-label={character.name}>{character.name}</p>
                {!isActive && <StatusTag status={character.status} className="shrink-0" />}
              </div>
              <p className="text-[11.5px] text-secondary truncate cf-name-reveal" title={summary} aria-label={summary}>
                {classSummary}Lv {character.level}
                {ownerLabel && ` · ${ownerLabel}`}
              </p>
            </div>
            {xpProgressionSupported(adapter) && xpQualifiedLevel > character.level && (
              <span className="tag tag-accent shrink-0" style={{ fontSize: 9.5 }} title={`${formatNumber(character.xp)} XP — enough for level ${xpQualifiedLevel}`}>
                ⬆ Level up
              </span>
            )}
          </div>
        <div className="flex justify-between text-[11.5px] text-secondary">
          <span>HP</span>
          <span>
            {character.hpMax > 0 ? `${character.hpCurrent} / ${character.hpMax}` : 'Not set'}
          </span>
        </div>
        {character.hpMax > 0 ? (
          <HpBar current={character.hpCurrent} max={character.hpMax} />
        ) : (
          <p className="text-[10px] text-secondary">Complete HP on the sheet</p>
        )}
        {character.conditions.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            <span className="tag tag-outline" style={{ fontSize: 10 }}>
              {character.conditions.join(', ')}
            </span>
          </div>
        )}
        </ListDetailLink>
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
      {canEditHp && character.hpMax > 0 && <QuickHp character={character} onChange={onChange} />}
    </Card>
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
            className="btn btn-secondary cf-density-xs"
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
  initialAmount,
  onCancel,
  onAwarded,
}: {
  campaignId: number;
  characters: Character[];
  initialAmount?: string | null;
  onCancel: () => void;
  onAwarded: () => void;
}) {
  const amountInputRef = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState(() => {
    if (!initialAmount) return '';
    const n = Number(initialAmount);
    return Number.isInteger(n) && n >= 1 ? String(n) : '';
  });
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
                          <span className="cf-name-reveal inline-block max-w-full" title={character.name} aria-label={character.name}>{character.name}</span>
                        </label>
                      </td>
                      <td className="px-3 py-2">{STATUS_LABEL[character.status]}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(character.xp)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">
                        {selected && validAmount ? formatNumber(character.xp + amountNum) : '—'}
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
