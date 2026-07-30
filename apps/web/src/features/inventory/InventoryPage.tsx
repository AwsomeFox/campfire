/**
 * Inventory & loot — party treasury (coin totals) plus items grouped into the
 * party stash and per-character packs. Members can read everything; the dm and
 * players may adjust the treasury and manage the stash; character items are
 * writable only by the dm or the character's owning player (server-enforced,
 * mirrored here so read-only rows don't render controls).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router-dom';
import type { Character, InventoryItem, PartyCharacter, Treasury } from '@campfire/schema';
import { api, API, ApiError, translateApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { useCampaignEvents } from '../../lib/useCampaignEvents';
import { Card, Btn, TextInput, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { PageHeader } from '../../components/PageHeader';
import { GameIcon } from '../../components/GameIcon';
import { itemIconSlug, COIN_ICON, COIN_COLORS } from '../../lib/inventoryIcons';
import { parseLocalizedInteger } from '../../lib/i18nNumbers';
import { useFormattingLocale } from '../../lib/format';
import { AddItemForm, CompendiumItemPickerModal, ItemSection } from './inventoryShared';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

const COIN_KEYS = [
  { key: 'pp', labelKey: 'inventory.coins.pp' },
  { key: 'gp', labelKey: 'inventory.coins.gp' },
  { key: 'ep', labelKey: 'inventory.coins.ep' },
  { key: 'sp', labelKey: 'inventory.coins.sp' },
  { key: 'cp', labelKey: 'inventory.coins.cp' },
] as const;
type CoinKey = (typeof COIN_KEYS)[number]['key'];

export default function InventoryPage() {
  const { t } = useTranslation();
  const { campaignId } = useParams<{ campaignId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const id = Number(campaignId);
  const { me } = useAuth();
  const { isDm, canPlayerWrite } = useCampaignAccess();
  const canEdit = canPlayerWrite;
  const myUserId = me?.user.id != null ? String(me.user.id) : null;

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [trashItems, setTrashItems] = useState<InventoryItem[] | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [treasury, setTreasury] = useState<Treasury | null>(null);
  // Keep full sheets only for ownership/write decisions. Display groups use the
  // table-safe roster so a player's view still names every character's pack.
  const [fullCharacters, setFullCharacters] = useState<Character[]>([]);
  const [party, setParty] = useState<PartyCharacter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(() => searchParams.get('action') === 'add-item');
  const [showCompendiumPicker, setShowCompendiumPicker] = useState(false);

  const closeAdding = useCallback(() => {
    setAdding(false);
    if (searchParams.get('action') === 'add-item') {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('action');
          next.delete('fromEncounter');
          return next;
        },
        { replace: true },
      );
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (searchParams.get('action') === 'add-item') setAdding(true);
  }, [searchParams]);
  // Bumped whenever a `treasury.updated` SSE tick arrives from ANOTHER user. The
  // TreasuryCard watches this to mark its open editor stale (issue #582) instead of
  // silently overwriting a concurrent change on save. Echoes of our own writes are
  // ignored (same userId) so a save never flags its own editor.
  const [treasuryRemoteEpoch, setTreasuryRemoteEpoch] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [itemList, coins, chars, roster] = await Promise.all([
        api.get<InventoryItem[]>(`${API}/campaigns/${id}/inventory`),
        api.get<Treasury>(`${API}/campaigns/${id}/treasury`),
        api.get<Character[]>(`${API}/campaigns/${id}/characters`),
        api.get<PartyCharacter[]>(`${API}/campaigns/${id}/characters/roster`),
      ]);
      setItems(itemList);
      setTreasury(coins);
      setFullCharacters(chars);
      setParty(roster);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'inventory.errors.load' }));
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadTrash = useCallback(async () => {
    try {
      const trashed = await api.get<InventoryItem[]>(`${API}/campaigns/${id}/inventory/trash`);
      setTrashItems(trashed);
    } catch (err) {
      // Reset to an empty list and close the trash section so the user isn't
      // left staring at a perpetual loading skeleton with no retry path.
      setTrashItems([]);
      setShowTrash(false);
      setError(translateApiError(err, t, { fallbackKey: 'inventory.errors.load' }));
    }
  }, [id]);

  useEffect(() => {
    if (Number.isFinite(id)) void load();
  }, [id, load]);

  // Live invalidation for the treasury (issue #582). A `treasury.updated` tick from
  // another player refreshes the displayed totals and — if the editor is open — bumps
  // the remote epoch so the card can surface a "changed by another player" state
  // rather than letting a stale form clobber the concurrent write on save. We keep
  // myUserId in a ref so the handler identity is stable (the SSE hook re-subscribes
  // only on campaignId, not on every render).
  const myUserIdRef = useRef(myUserId);
  myUserIdRef.current = myUserId;
  const refreshTreasury = useCallback(async () => {
    try {
      const coins = await api.get<Treasury>(`${API}/campaigns/${id}/treasury`);
      setTreasury(coins);
    } catch {
      /* the page-level load/error path will surface a persistent failure */
    }
  }, [id]);
  useCampaignEvents(Number.isFinite(id) ? id : undefined, {
    onEvent: useCallback(
      (event) => {
        if (event.type !== 'treasury.updated') return;
        // Ignore our own write echoing back through the stream.
        if (event.userId === myUserIdRef.current) return;
        void refreshTreasury();
        setTreasuryRemoteEpoch((n) => n + 1);
      },
      [refreshTreasury],
    ),
    onReconnect: useCallback(() => void refreshTreasury(), [refreshTreasury]),
    onStreamRecovery: useCallback(() => void refreshTreasury(), [refreshTreasury]),
  });

  const ownsCharacter = useCallback(
    (characterId: number | null) => {
      if (characterId == null || myUserId == null) return false;
      const c = fullCharacters.find((ch) => ch.id === characterId);
      return c?.ownerUserId === myUserId;
    },
    [fullCharacters, myUserId],
  );

  const canEditItem = useCallback(
    (item: InventoryItem) => {
      if (!canEdit) return false;
      if (isDm || item.ownerType === 'party') return true;
      return ownsCharacter(item.characterId);
    },
    [canEdit, isDm, ownsCharacter],
  );

  // Move/add destinations this user may write to: the party stash, plus every
  // character for the dm, or only the player's own character(s).
  const writableOwners = useMemo(() => {
    const chars = isDm ? fullCharacters : fullCharacters.filter((c) => myUserId != null && c.ownerUserId === myUserId);
    return chars;
  }, [fullCharacters, isDm, myUserId]);

  const partyItems = items.filter((i) => i.ownerType === 'party');
  const characterGroups = useMemo(() => {
    const groups: { character: PartyCharacter | null; label: string; items: InventoryItem[] }[] = [];
    for (const c of party) {
      const owned = items.filter((i) => i.ownerType === 'character' && i.characterId === c.id);
      if (owned.length > 0) groups.push({ character: c, label: c.name, items: owned });
    }
    const knownIds = new Set(party.map((c) => c.id));
    const orphans = items.filter((i) => i.ownerType === 'character' && (i.characterId == null || !knownIds.has(i.characterId)));
    if (orphans.length > 0) groups.push({ character: null, label: t('inventory.unassigned'), items: orphans });
    return groups;
  }, [items, party, t]);

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message={t('common.noCampaign')} />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      <PageHeader
        title={t('inventory.title')}
        primaryAction={
          canEdit && !adding ? (
            <div className="flex items-center gap-2">
              <Btn type="button" className="cf-page-header__action" onClick={() => setAdding(true)}>
                {t('inventory.addItem')}
              </Btn>
              <Btn type="button" ghost className="cf-page-header__action" onClick={() => setShowCompendiumPicker(true)} aria-label={t('inventory.fromCompendium')}>
                {t('inventory.fromCompendium')}
              </Btn>
            </div>
          ) : undefined
        }
      />

      {error && <ErrorNote message={error} onRetry={load} />}

      {loading ? (
        <Card>
          <Skeleton lines={4} />
        </Card>
      ) : (
        <>
          {treasury && (
            <TreasuryCard
              campaignId={id}
              treasury={treasury}
              canEdit={canEdit}
              onChanged={setTreasury}
              remoteEpoch={treasuryRemoteEpoch}
            />
          )}

          {adding && canEdit && (
            <AddItemForm
              campaignId={id}
              owners={writableOwners}
              onCancel={closeAdding}
              onCreated={() => {
                closeAdding();
                void load();
              }}
            />
          )}

          {showCompendiumPicker && canEdit && (
            <CompendiumItemPickerModal
              campaignId={id}
              owners={writableOwners}
              onClose={() => setShowCompendiumPicker(false)}
              onCreated={() => {
                setShowCompendiumPicker(false);
                void load();
              }}
            />
          )}

          {items.length === 0 && !adding ? (
            <EmptyState
              icon="backpack"
              title={t('inventory.noLootTitle')}
              hint={canEdit ? t('inventory.noLootHintDm') : t('inventory.noLootHintPlayer')}
            />
          ) : (
            <>
              <ItemSection
                key="party-stash"
                title={t('inventory.partyStash')}
                icon="backpack"
                items={partyItems}
                characters={party}
                writableOwners={writableOwners}
                canEditItem={canEditItem}
                onChanged={load}
                partyStashTitle={t('inventory.partyStash')}
              />
              {characterGroups.map((group) => (
                <ItemSection
                  key={group.character?.id ?? 'orphans'}
                  title={group.label}
                  icon="elf-helmet"
                  items={group.items}
                  characters={party}
                  writableOwners={writableOwners}
                  canEditItem={canEditItem}
                  onChanged={load}
                  partyStashTitle={t('inventory.partyStash')}
                />
              ))}
            </>
          )}

          {canEdit && (
            <div className="pt-2">
              <Btn
                ghost
                className="text-xs"
                onClick={() => {
                  if (!showTrash) void loadTrash();
                  setShowTrash((s) => !s);
                }}
              >
                {showTrash ? t('inventory.hideTrash') : t('inventory.showTrash')}
              </Btn>
            </div>
          )}

          {showTrash && (
            <TrashSection
              items={trashItems}
              characters={party}
              onChanged={() => {
                void load();
                void loadTrash();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Party treasury editor (issue #582).
 *
 * Two write shapes, each mapped to the safest server semantics:
 *
 *  - Quick add/spend (the −/+ buttons on each coin) sends a pure { delta } patch.
 *    Deltas never conflict — two players spending coin at the same time compose
 *    atomically on the server (one `UPDATE col = col + ?` per denomination), so
 *    this is the preferred path for at-the-table coin flow.
 *
 *  - The Edit form is a full reconciliation: the DM sets exact totals. Absolute
 *    writes are inherently racy, so the form sends only the CHANGED denominations
 *    as { set, expectedUpdatedAt }, where expectedUpdatedAt is the row version the
 *    DM snapshotted. If another player wrote in between, the server returns 409
 *    with the fresh values and the editor offers to reapply against them rather
 *    than silently clobbering the concurrent change.
 *
 * While the editor is open, a `treasury.updated` SSE tick from another player
 * (signalled by `remoteEpoch` bumping) marks it stale — "Another player changed
 * the treasury" — so the DM reloads fresh values before saving. Echoes of the
 * DM's own writes are filtered upstream (InventoryPage) and never bump the epoch.
 */
function TreasuryCard({
  campaignId,
  treasury,
  canEdit,
  onChanged,
  remoteEpoch,
}: {
  campaignId: number;
  treasury: Treasury;
  canEdit: boolean;
  onChanged: (t: Treasury) => void;
  remoteEpoch: number;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<CoinKey, string>>({ pp: '', gp: '', ep: '', sp: '', cp: '' });
  // The row version the edit form snapshotted from — sent as the CAS token on save.
  const [editBaseUpdatedAt, setEditBaseUpdatedAt] = useState<string | null>(null);
  // The coin BALANCES the editor snapshotted at open (issue #582 review). The DM's
  // "changed denominations" must be computed against THIS snapshot — NOT the live
  // `treasury` prop, which SSE refreshes on every other-player write. Diffing against
  // the live prop would include coins another player changed (and the DM never
  // touched), reintroducing the exact overwrite risk this PR closes. After a 409,
  // editBase is advanced to the server's fresh values so a reapply diffs against THOSE.
  const [editBase, setEditBase] = useState<Record<CoinKey, number>>({ pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-field parse errors (issue #633): when a coin value can't be parsed in
  // the viewer's locale (e.g. "1,2,3" or stray letters), the OLD value is
  // preserved and the offending field shows an inline message instead of the
  // value being silently coerced to 0.
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<CoinKey, string>>>({});
  const formatLocale = useFormattingLocale();
  // A 409 conflict: the server's current values. While present, the form shows the
  // diff against the DM's intent and offers "Reapply" (which re-sends only the
  // changed denominations, pinned to the fresh row version). Cleared on reload/reapply.
  const [conflict, setConflict] = useState<Treasury | null>(null);
  // The remoteEpoch the editor was opened against. If it changes while open,
  // another player updated the treasury — flag the editor stale.
  const [openedAtEpoch, setOpenedAtEpoch] = useState(remoteEpoch);
  const stale = editing && remoteEpoch !== openedAtEpoch && !conflict;

  function startEdit() {
    const base: Record<CoinKey, number> = { pp: treasury.pp, gp: treasury.gp, ep: treasury.ep, sp: treasury.sp, cp: treasury.cp };
    setEditBase(base);
    setValues({
      pp: String(treasury.pp),
      gp: String(treasury.gp),
      ep: String(treasury.ep),
      sp: String(treasury.sp),
      cp: String(treasury.cp),
    });
    setEditBaseUpdatedAt(treasury.updatedAt);
    setOpenedAtEpoch(remoteEpoch);
    setError(null);
    setFieldErrors({});
    setConflict(null);
    setEditing(true);
  }

  // Parse the form into the DM's intended absolute values. Issue #633: never
  // silently coerce an unparseable field to 0 — return { ok: false, errors }
  // mapping each offending coin to a short message; the caller keeps the field's
  // current value and shows the error. parseLocalizedInteger honors the viewer's
  // locale (de/fr grouping, Arabic-Indic digits) so a correct international value
  // is no longer misread as 0. Coins are non-negative per the server schema, so
  // min:0 is enforced here; the bound is reported in the error message rather
  // than silently clamped.
  function parseIntended():
    | { ok: true; values: Record<CoinKey, number> }
    | { ok: false; errors: Partial<Record<CoinKey, string>> } {
    const out = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 } as Record<CoinKey, number>;
    const errors: Partial<Record<CoinKey, string>> = {};
    for (const { key } of COIN_KEYS) {
      const parsed = parseLocalizedInteger(values[key], formatLocale, { min: 0 });
      if (parsed.ok) {
        out[key] = parsed.value;
      } else {
        errors[key] = parsed.error;
      }
    }
    if (Object.keys(errors).length > 0) return { ok: false, errors };
    return { ok: true, values: out };
  }

  // Build the CHANGED-only set against the snapshot the DM is diffing from, so we
  // don't resubmit untouched denominations (a stale form restoring gp another
  // player just spent was the original bug). The base is `editBase` — the balances
  // the editor opened against (or, after a 409, the server's fresh values) — NEVER
  // the live `treasury` prop, which SSE refreshes on other-player writes and would
  // contaminate the changed-coin set with coins the DM never touched.
  function buildSet(base: Record<CoinKey, number>, intended: Record<CoinKey, number>): Partial<Record<CoinKey, number>> {
    const set: Partial<Record<CoinKey, number>> = {};
    for (const { key } of COIN_KEYS) {
      if (intended[key] !== base[key]) set[key] = intended[key];
    }
    return set;
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    // Issue #633: parse BEFORE entering the saving state so a validation
    // failure never flashes the "Saving…" affordance for a no-op round-trip.
    // On parse failure, surface the per-field errors and keep the current field
    // values — do NOT submit a patch that silently wrote 0 for the unparseable
    // coins.
    const parsed = parseIntended();
    if (!parsed.ok) {
      setFieldErrors(parsed.errors);
      return;
    }
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const intended = parsed.values;
      // Diff against the stable snapshot the DM opened against (editBase) — not the
      // live treasury prop, which may have moved under them via SSE. Only the coins
      // the DM ACTUALLY edited go in the { set } patch; on a 409-reapply, editBase
      // was advanced to the server's fresh values so only genuinely-edited coins are
      // re-sent, pinned to the fresh row version.
      const set = buildSet(editBase, intended);
      if (Object.keys(set).length === 0) {
        // Nothing changed — close the editor without a round-trip.
        setConflict(null);
        setEditing(false);
        return;
      }
      const updated = await api.patch<Treasury>(`${API}/campaigns/${campaignId}/treasury`, {
        set,
        expectedUpdatedAt: editBaseUpdatedAt ?? undefined,
      });
      onChanged(updated);
      setConflict(null);
      setEditing(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Stale base: ApiError does NOT carry the server's fresh values (only
        // status/message/code/fieldErrors), so fetch them, then show the diff and
        // offer reapply. editBase advances to the fresh values so a reapply diffs
        // against THOSE (and only the DM's truly-edited coins are re-sent).
        try {
          const fresh = await api.get<Treasury>(`${API}/campaigns/${campaignId}/treasury`);
          setConflict(fresh);
          setEditBase({ pp: fresh.pp, gp: fresh.gp, ep: fresh.ep, sp: fresh.sp, cp: fresh.cp });
          setEditBaseUpdatedAt(fresh.updatedAt);
          setOpenedAtEpoch(remoteEpoch); // fresh values are current as of now
          return;
        } catch {
          // The follow-up GET itself failed — fall through to the generic error.
        }
      }
      setError(translateApiError(err, t, { fallbackKey: 'inventory.errors.updateTreasury' }));
    } finally {
      setSaving(false);
    }
  }

  // Quick add/spend: a pure { delta } patch. Never conflicts. Disabled to 0 floor
  // on spend (a spend past 0 is a server 400 and would just bounce), unlimited add.
  async function quickDelta(coin: CoinKey, by: number) {
    // Clear any prior error (e.g. a 400 "cannot go negative" from a previous failed
    // spend) so a stale message doesn't linger after a successful +/- click. A new
    // failure below re-sets it.
    setError(null);
    try {
      const updated = await api.patch<Treasury>(`${API}/campaigns/${campaignId}/treasury`, { delta: { [coin]: by } });
      onChanged(updated);
    } catch (err) {
      // A negative-going spend surfaces the server's plain message ("Treasury cannot
      // go negative…"); other errors fall back to the generic string.
      setError(translateApiError(err, t, { fallbackKey: 'inventory.errors.adjustTreasury' }));
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="flex items-center gap-2 font-bold text-white text-sm"><GameIcon slug="coins" size={UI_ICON_SIZE.sm} /> {t('inventory.partyTreasury')}</h2>
        <div className="flex-1" />
        {canEdit && !editing && (
          <Btn density="xs" ghost className="text-xs" onClick={startEdit}>
            {t('common.edit')}
          </Btn>
        )}
      </div>
      {error && <p className="text-sm text-rose-400">{error}</p>}
      {editing ? (
        <form onSubmit={save} className="space-y-3">
          {stale && (
            <p className="text-sm rounded-md p-2" style={{ background: 'var(--color-neutral-800)', color: 'var(--color-amber, #f59e0b)' }}>
              {t('inventory.staleTreasury')}
              <Btn density="xs"
                ghost
                type="button"
                className="!px-2 text-xs ml-2"
                onClick={() => {
                  setError(null);
                  setConflict(null);
                  setEditing(false);
                  startEdit();
                }}
              >
                {t('inventory.reload')}
              </Btn>
            </p>
          )}
          {conflict && (() => {
            // The conflict panel is reached only after a 409 on a PATCH that
            // already passed parse, so every field is parseable here; but guard
            // anyway — an unparseable field falls back to its base value, so its
            // "dmEdited" diff is false and no misleading arrow is shown.
            const parsed = parseIntended();
            const intentFor = (key: CoinKey): number =>
              parsed.ok ? parsed.values[key] : editBase[key];
            return (
            <div className="text-sm rounded-md p-2 space-y-1" style={{ background: 'var(--color-neutral-800)' }}>
              <p className="text-amber-400 font-semibold">{t('inventory.conflictTitle')}</p>
              <p className="text-slate-400">{t('inventory.conflictHint')}</p>
              <div className="grid grid-cols-5 gap-2 pt-1">
                {COIN_KEYS.map(({ key, labelKey }) => {
                  const label = t(labelKey);
                  const fresh = conflict[key];
                  const intent = intentFor(key);
                  // Only show the reapply arrow for a coin the DM ACTUALLY edited
                  // (intent differs from the snapshot they opened against). Arrows
                  // for every fresh !== intent would falsely suggest the DM meant
                  // to overwrite other players' changes on coins they never touched.
                  const dmEdited = intent !== editBase[key];
                  return (
                    <div key={key} className="text-center">
                      <p className="text-[10px] text-secondary uppercase">{label}</p>
                      <p className="text-white font-bold">{fresh}</p>
                      {dmEdited && intent !== fresh && <p className="text-[11px] text-amber-400">→ {intent}</p>}
                    </div>
                  );
                })}
              </div>
            </div>
            );
          })()}
          <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
            {COIN_KEYS.map(({ key, labelKey }) => {
              const label = t(labelKey);
              return (
              <label key={key} className="space-y-1">
                <span className="block text-[11px] text-secondary uppercase tracking-wide">{label}</span>
                <TextInput
                  type="text"
                  inputMode="numeric"
                  value={values[key]}
                  aria-invalid={fieldErrors[key] != null}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [key]: e.target.value }));
                    setFieldErrors((fe) => (fe[key] ? { ...fe, [key]: undefined } : fe));
                  }}
                />
                {fieldErrors[key] && (
                  <span className="block text-[11px] text-rose-400">{fieldErrors[key]}</span>
                )}
              </label>
              );
            })}
          </div>
          <div className="flex gap-2 justify-end">
            <Btn ghost type="button" onClick={() => setEditing(false)} disabled={saving}>
              {t('common.cancel')}
            </Btn>
            <Btn type="submit" disabled={saving}>
              {conflict ? t('inventory.reapply') : saving ? t('common.saving') : t('common.save')}
            </Btn>
          </div>
        </form>
      ) : (
        <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
          {COIN_KEYS.map(({ key, labelKey }) => {
            const label = t(labelKey);
            return (
            <div key={key} className="text-center rounded-md py-2" style={{ background: 'var(--color-neutral-800)' }}>
              <div className="flex items-center justify-center gap-1.5">
                <span className="inline-flex shrink-0" style={{ color: COIN_COLORS[key] }}>
                  <GameIcon slug={COIN_ICON} size={UI_ICON_SIZE.sm} title={t('inventory.coinCoinsAria', { label })} />
                </span>
                <p className="text-lg font-extrabold text-white leading-none">{treasury[key]}</p>
              </div>
              <p className="text-[11px] text-secondary uppercase tracking-wide mt-1">
                {label} ({key})
              </p>
              {canEdit && (
                <div className="flex items-center justify-center gap-1 mt-1">
                  <Btn density="xs"
                    ghost
                    className="!px-2 text-xs"
                    onClick={() => void quickDelta(key, -1)}
                    disabled={treasury[key] <= 0}
                    aria-label={t('inventory.spendOne', { label })}
                  >
                    −
                  </Btn>
                  <Btn density="xs"
                    ghost
                    className="!px-2 text-xs"
                    onClick={() => void quickDelta(key, +1)}
                    aria-label={t('inventory.addOne', { label })}
                  >
                    +
                  </Btn>
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function TrashSection({
  items,
  characters,
  onChanged,
}: {
  items: InventoryItem[] | null;
  characters: Pick<PartyCharacter, 'id' | 'name'>[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();

  if (items === null) {
    return (
      <Card className="py-6">
        <Skeleton lines={2} />
      </Card>
    );
  }

  if (items.length === 0) {
    return (
      <Card className="py-4 text-sm text-slate-500">
        {t('inventory.trashEmpty', { defaultValue: 'Trash is empty.' })}
      </Card>
    );
  }

  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm">{t('inventory.trashTitle', { defaultValue: 'Trash' })}</h2>
      <ul className="space-y-2">
        {items.map((item) => (
          <TrashedItemRow key={item.id} item={item} characters={characters} onChanged={onChanged} />
        ))}
      </ul>
    </Card>
  );
}

function TrashedItemRow({
  item,
  characters,
  onChanged,
}: {
  item: InventoryItem;
  characters: Pick<PartyCharacter, 'id' | 'name'>[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setBusy(true);
    setError(null);
    try {
      await api.post<InventoryItem>(`${API}/inventory/${item.id}/restore`);
      onChanged();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'inventory.errors.restoreItem' }));
    } finally {
      setBusy(false);
    }
  }

  const ownerName =
    item.ownerType === 'party'
      ? t('inventory.partyStash')
      : characters.find((c) => c.id === item.characterId)?.name ?? t('inventory.currentOwner');
  const iconSlug = itemIconSlug(item);

  return (
    <li className="py-2 flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="shrink-0 mt-0.5 text-[var(--color-accent)]">
        <GameIcon slug={iconSlug} size={UI_ICON_SIZE.lg} title={item.name} />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-white truncate">
          {item.name}
          {item.qty !== 1 && <span className="text-slate-500 font-normal"> ×{item.qty}</span>}
        </p>
        <p className="text-[12px] text-slate-500">
          {t('inventory.trashedOwner', { defaultValue: 'Owner: {{owner}}', owner: ownerName })}
        </p>
        {error && <p className="text-[12px] text-rose-400">{error}</p>}
      </div>
      <Btn density="xs"
        ghost
        className="!px-2 text-xs"
        disabled={busy}
        onClick={() => void restore()}
        aria-label={t('inventory.restoreAria', { defaultValue: 'Restore {{name}}', name: item.name })}
      >
        {t('inventory.restore', { defaultValue: 'Restore' })}
      </Btn>
    </li>
  );
}
