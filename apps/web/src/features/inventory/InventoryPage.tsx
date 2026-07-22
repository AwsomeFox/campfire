/**
 * Inventory & loot — party treasury (coin totals) plus items grouped into the
 * party stash and per-character packs. Members can read everything; the dm and
 * players may adjust the treasury and manage the stash; character items are
 * writable only by the dm or the character's owning player (server-enforced,
 * mirrored here so read-only rows don't render controls).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import type { Character, InventoryItem, Treasury } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useCampaignEvents } from '../../lib/useCampaignEvents';
import { Card, Btn, TextInput, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { entityTargetProps } from '../../lib/entityLinks';
import { IconPicker } from '../../components/IconPicker';
import { Markdown } from '../../components/Markdown';
import { getIcon } from '../../lib/icons';
import { itemIconSlug, COIN_ICON, COIN_COLORS } from '../../lib/inventoryIcons';
import { parseLocalizedInteger } from '../../lib/i18nNumbers';
import { useFormattingLocale } from '../../lib/format';

const COINS = [
  { key: 'pp', label: 'Platinum' },
  { key: 'gp', label: 'Gold' },
  { key: 'ep', label: 'Electrum' },
  { key: 'sp', label: 'Silver' },
  { key: 'cp', label: 'Copper' },
] as const;
type CoinKey = (typeof COINS)[number]['key'];

export default function InventoryPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const { me, roleIn } = useAuth();
  const role = roleIn(id);
  const isDm = role === 'dm';
  const canEdit = isDm || role === 'player';
  const myUserId = me?.user.id != null ? String(me.user.id) : null;

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [treasury, setTreasury] = useState<Treasury | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Bumped whenever a `treasury.updated` SSE tick arrives from ANOTHER user. The
  // TreasuryCard watches this to mark its open editor stale (issue #582) instead of
  // silently overwriting a concurrent change on save. Echoes of our own writes are
  // ignored (same userId) so a save never flags its own editor.
  const [treasuryRemoteEpoch, setTreasuryRemoteEpoch] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [itemList, coins, chars] = await Promise.all([
        api.get<InventoryItem[]>(`${API}/campaigns/${id}/inventory`),
        api.get<Treasury>(`${API}/campaigns/${id}/treasury`),
        api.get<Character[]>(`${API}/campaigns/${id}/characters`),
      ]);
      setItems(itemList);
      setTreasury(coins);
      setCharacters(chars);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load the inventory.");
    } finally {
      setLoading(false);
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
  });

  const ownsCharacter = useCallback(
    (characterId: number | null) => {
      if (characterId == null || myUserId == null) return false;
      const c = characters.find((ch) => ch.id === characterId);
      return c?.ownerUserId === myUserId;
    },
    [characters, myUserId],
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
    const chars = isDm ? characters : characters.filter((c) => myUserId != null && c.ownerUserId === myUserId);
    return chars;
  }, [characters, isDm, myUserId]);

  const partyItems = items.filter((i) => i.ownerType === 'party');
  const characterGroups = useMemo(() => {
    const groups: { character: Character | null; label: string; items: InventoryItem[] }[] = [];
    for (const c of characters) {
      const owned = items.filter((i) => i.ownerType === 'character' && i.characterId === c.id);
      if (owned.length > 0) groups.push({ character: c, label: c.name, items: owned });
    }
    const knownIds = new Set(characters.map((c) => c.id));
    const orphans = items.filter((i) => i.ownerType === 'character' && (i.characterId == null || !knownIds.has(i.characterId)));
    if (orphans.length > 0) groups.push({ character: null, label: 'Unassigned', items: orphans });
    return groups;
  }, [items, characters]);

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-extrabold text-white">Inventory</h1>
        <div className="flex-1" />
        {canEdit && !adding && (
          <Btn className="!min-h-0 !py-1.5 text-xs" onClick={() => setAdding(true)}>
            + Add item
          </Btn>
        )}
      </div>

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
              onCancel={() => setAdding(false)}
              onCreated={() => {
                setAdding(false);
                void load();
              }}
            />
          )}

          {items.length === 0 && !adding ? (
            <EmptyState
              icon="backpack"
              title="No loot yet"
              hint={canEdit ? 'Add the party\'s first item with "+ Add item".' : 'Nothing has been logged by the party yet.'}
            />
          ) : (
            <>
              <ItemSection
                title="Party stash"
                icon="backpack"
                items={partyItems}
                characters={characters}
                writableOwners={writableOwners}
                canEditItem={canEditItem}
                onChanged={load}
              />
              {characterGroups.map((group) => (
                <ItemSection
                  key={group.character?.id ?? 'orphans'}
                  title={group.label}
                  icon="elf-helmet"
                  items={group.items}
                  characters={characters}
                  writableOwners={writableOwners}
                  canEditItem={canEditItem}
                  onChanged={load}
                />
              ))}
            </>
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
    for (const { key } of COINS) {
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
    for (const { key } of COINS) {
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
      setError(err instanceof ApiError ? err.message : "Couldn't update the treasury.");
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
      setError(err instanceof ApiError ? err.message : "Couldn't adjust the treasury.");
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="flex items-center gap-2 font-bold text-white text-sm"><GameIcon slug="coins" size={16} /> Party treasury</h2>
        <div className="flex-1" />
        {canEdit && !editing && (
          <Btn ghost className="!min-h-0 !py-1 text-xs" onClick={startEdit}>
            Edit
          </Btn>
        )}
      </div>
      {error && <p className="text-sm text-rose-400">{error}</p>}
      {editing ? (
        <form onSubmit={save} className="space-y-3">
          {stale && (
            <p className="text-sm rounded-md p-2" style={{ background: 'var(--color-neutral-800)', color: 'var(--color-amber, #f59e0b)' }}>
              Another player changed the treasury since you opened this editor. Reload fresh values before saving to avoid overwriting their change.
              <Btn
                ghost
                type="button"
                className="!min-h-0 !py-0.5 !px-2 text-xs ml-2"
                onClick={() => {
                  // Drop the editor and re-open against the latest snapshot the
                  // page already refetched on the SSE tick.
                  setError(null);
                  setConflict(null);
                  setEditing(false);
                  startEdit();
                }}
              >
                Reload
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
              <p className="text-amber-400 font-semibold">Another player changed the treasury since you loaded.</p>
              <p className="text-slate-400">Fresh values shown below — reapply your change against them?</p>
              <div className="grid grid-cols-5 gap-2 pt-1">
                {COINS.map(({ key, label }) => {
                  const fresh = conflict[key];
                  const intent = intentFor(key);
                  // Only show the reapply arrow for a coin the DM ACTUALLY edited
                  // (intent differs from the snapshot they opened against). Arrows
                  // for every fresh !== intent would falsely suggest the DM meant
                  // to overwrite other players' changes on coins they never touched.
                  const dmEdited = intent !== editBase[key];
                  return (
                    <div key={key} className="text-center">
                      <p className="text-[10px] text-slate-500 uppercase">{label}</p>
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
            {COINS.map(({ key, label }) => (
              <label key={key} className="space-y-1">
                <span className="block text-[11px] text-slate-500 uppercase tracking-wide">{label}</span>
                {/* type="text" + inputMode="numeric" (issue #633): a type="number"
                    field silently strips locale grouping separators (en "1,234"
                    → "", de "1.234" → "1") before our parser ever sees them, so
                    the localized parse path is bypassed. A text field with a
                    numeric IME hint hands us the raw, locale-correct string. */}
                <TextInput
                  type="text"
                  inputMode="numeric"
                  value={values[key]}
                  aria-invalid={fieldErrors[key] != null}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [key]: e.target.value }));
                    // Clear this coin's error as the DM retypes; a fresh error
                    // is computed on the next save attempt.
                    setFieldErrors((fe) => (fe[key] ? { ...fe, [key]: undefined } : fe));
                  }}
                />
                {fieldErrors[key] && (
                  <span className="block text-[11px] text-rose-400">{fieldErrors[key]}</span>
                )}
              </label>
            ))}
          </div>
          <div className="flex gap-2 justify-end">
            <Btn ghost type="button" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Btn>
            <Btn type="submit" disabled={saving}>
              {conflict ? 'Reapply' : saving ? 'Saving…' : 'Save'}
            </Btn>
          </div>
        </form>
      ) : (
        <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
          {COINS.map(({ key, label }) => (
            <div key={key} className="text-center rounded-md py-2" style={{ background: 'var(--color-neutral-800)' }}>
              <div className="flex items-center justify-center gap-1.5">
                <span className="inline-flex shrink-0" style={{ color: COIN_COLORS[key] }}>
                  <GameIcon slug={COIN_ICON} size={16} title={`${label} coins`} />
                </span>
                <p className="text-lg font-extrabold text-white leading-none">{treasury[key]}</p>
              </div>
              <p className="text-[11px] text-slate-500 uppercase tracking-wide mt-1">
                {label} ({key})
              </p>
              {canEdit && (
                <div className="flex items-center justify-center gap-1 mt-1">
                  <Btn
                    ghost
                    className="!min-h-0 !py-0.5 !px-2 text-xs"
                    onClick={() => void quickDelta(key, -1)}
                    disabled={treasury[key] <= 0}
                    aria-label={`Spend one ${label}`}
                  >
                    −
                  </Btn>
                  <Btn
                    ghost
                    className="!min-h-0 !py-0.5 !px-2 text-xs"
                    onClick={() => void quickDelta(key, +1)}
                    aria-label={`Add one ${label}`}
                  >
                    +
                  </Btn>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ItemSection({
  title,
  icon,
  items,
  characters,
  writableOwners,
  canEditItem,
  onChanged,
}: {
  title: string;
  icon: string;
  items: InventoryItem[];
  characters: Character[];
  writableOwners: Character[];
  canEditItem: (item: InventoryItem) => boolean;
  onChanged: () => void;
}) {
  if (items.length === 0 && title !== 'Party stash') return null;
  return (
    <Card className="space-y-2">
      <h2 className="flex items-center gap-2 font-bold text-white text-sm">
        <GameIcon slug={icon} size={16} /> {title}
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">Empty.</p>
      ) : (
        <ul className="divide-y" style={{ borderColor: 'var(--color-neutral-800)' }}>
          {items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              editable={canEditItem(item)}
              characters={characters}
              writableOwners={writableOwners}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ItemRow({
  item,
  editable,
  writableOwners,
  onChanged,
}: {
  item: InventoryItem;
  editable: boolean;
  characters: Character[];
  writableOwners: Character[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickingIcon, setPickingIcon] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`${API}/inventory/${item.id}`, body);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update the item.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`${API}/inventory/${item.id}`);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete the item.");
    } finally {
      setBusy(false);
    }
  }

  function onMove(value: string) {
    if (value === 'party') {
      if (item.ownerType !== 'party') void patch({ ownerType: 'party' });
      return;
    }
    const characterId = Number(value);
    if (Number.isFinite(characterId) && characterId !== item.characterId) {
      void patch({ ownerType: 'character', characterId });
    }
  }

  const currentOwnerValue = item.ownerType === 'party' ? 'party' : String(item.characterId ?? '');

  const iconSlug = itemIconSlug(item);
  const hasOverride = !!(item.iconSlug && item.iconSlug.trim());

  return (
    <li className="py-2 flex flex-wrap items-start gap-x-3 gap-y-2" {...entityTargetProps('item', item.id)}>
      {editable ? (
        <button
          type="button"
          onClick={() => setPickingIcon(true)}
          disabled={busy}
          title={hasOverride ? `Icon: ${getIcon(iconSlug)?.name ?? 'custom'} — click to change` : 'Auto icon — click to override'}
          aria-label={`Change icon for ${item.name}`}
          className="shrink-0 mt-0.5 text-[var(--color-accent)] hover:text-[var(--color-accent-700)]"
        >
          <GameIcon slug={iconSlug} size={22} title={item.name} />
        </button>
      ) : (
        <span className="shrink-0 mt-0.5 text-[var(--color-accent)]">
          <GameIcon slug={iconSlug} size={22} title={item.name} />
        </span>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-white truncate">
          {item.name}
          {item.qty !== 1 && <span className="text-slate-500 font-normal"> ×{item.qty}</span>}
        </p>
        {item.notes && <Markdown className="!text-[12px] !text-slate-500">{item.notes}</Markdown>}
        {error && <p className="text-[12px] text-rose-400">{error}</p>}
      </div>
      {editable && (
        <div className="flex flex-wrap items-center gap-1.5 shrink-0 w-full sm:w-auto sm:ml-auto justify-end">
          <Btn
            ghost
            className="!min-h-0 !py-0.5 !px-2 text-xs"
            disabled={busy || item.qty <= 0}
            onClick={() => void patch({ qty: Math.max(0, item.qty - 1) })}
            aria-label={`Decrease ${item.name} quantity`}
          >
            −
          </Btn>
          <Btn
            ghost
            className="!min-h-0 !py-0.5 !px-2 text-xs"
            disabled={busy}
            onClick={() => void patch({ qty: item.qty + 1 })}
            aria-label={`Increase ${item.name} quantity`}
          >
            +
          </Btn>
          <select
            className="cf-select !min-h-0 !py-1 text-xs"
            style={{ width: 'auto' }}
            value={currentOwnerValue}
            disabled={busy}
            onChange={(e) => onMove(e.target.value)}
            aria-label={`Move ${item.name}`}
          >
            <option value="party">Party stash</option>
            {writableOwners.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
            {item.ownerType === 'character' && item.characterId != null && !writableOwners.some((c) => c.id === item.characterId) && (
              <option value={String(item.characterId)}>(current owner)</option>
            )}
          </select>
          <Btn
            ghost
            danger
            className="!min-h-0 !py-0.5 !px-2 text-xs"
            disabled={busy}
            onClick={() => void remove()}
            aria-label={`Delete ${item.name}`}
          >
            ✕
          </Btn>
        </div>
      )}
      {pickingIcon && (
        <IconPicker
          value={item.iconSlug ?? ''}
          onSelect={(slug) => {
            setPickingIcon(false);
            // '' clears the override, reverting the row to its name-derived default.
            if ((item.iconSlug ?? '') !== slug) void patch({ iconSlug: slug });
          }}
          onClose={() => setPickingIcon(false)}
        />
      )}
    </li>
  );
}

function AddItemForm({
  campaignId,
  owners,
  onCancel,
  onCreated,
}: {
  campaignId: number;
  owners: Character[];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [qty, setQty] = useState('1');
  const [owner, setOwner] = useState('party');
  const [notes, setNotes] = useState('');
  const [iconSlug, setIconSlug] = useState('');
  const [pickingIcon, setPickingIcon] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-field error (issue #633): qty is parsed in the viewer's locale; an
  // unparseable value keeps the field's current text and shows this message
  // rather than silently defaulting to 1.
  const [qtyError, setQtyError] = useState<string | null>(null);
  const formatLocale = useFormattingLocale();

  // Live preview: the DM's explicit pick, else the name-derived default so they
  // see what the row will show before saving.
  const previewSlug = itemIconSlug({ name, iconSlug });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    // Issue #633: parse qty in the viewer's locale. On failure, surface a
    // field error and keep the current value — do NOT fall back to 1.
    const qtyParsed = parseLocalizedInteger(qty, formatLocale, { min: 0 });
    if (!qtyParsed.ok) {
      setQtyError(qtyParsed.error);
      return;
    }
    setQtyError(null);
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        qty: qtyParsed.value,
        notes: notes.trim(),
        iconSlug, // '' keeps the auto (name-derived) default
      };
      if (owner !== 'party') {
        body.ownerType = 'character';
        body.characterId = Number(owner);
      }
      await api.post(`${API}/campaigns/${campaignId}/inventory`, body);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add the item.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm">Add item</h2>
      {error && <p className="text-sm text-rose-400">{error}</p>}
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-[1fr_90px] gap-3">
          <TextInput placeholder="Item name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          {/* type="text" + inputMode="numeric" (issue #633): see TreasuryCard for
              why a numeric text field beats type="number" for locale-aware input. */}
          <TextInput
            type="text"
            inputMode="numeric"
            placeholder="Qty"
            value={qty}
            aria-invalid={qtyError != null}
            onChange={(e) => {
              setQty(e.target.value);
              setQtyError(null);
            }}
          />
        </div>
        {qtyError && <p className="text-xs text-rose-400 -mt-1">{qtyError}</p>}
        <div className="grid grid-cols-2 gap-3">
          <select className="cf-select" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner">
            <option value="party">Party stash</option>
            {owners.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </select>
          <TextInput placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-md text-[var(--color-accent)] shrink-0" style={{ background: 'var(--color-neutral-800)' }}>
            <GameIcon slug={previewSlug} size={24} title={getIcon(previewSlug)?.name} />
          </span>
          <Btn ghost type="button" className="!min-h-0 !py-1.5 text-xs" onClick={() => setPickingIcon(true)}>
            {iconSlug ? 'Change icon' : 'Choose icon'}
          </Btn>
          {iconSlug && (
            <Btn ghost type="button" className="!min-h-0 !py-1.5 text-xs" onClick={() => setIconSlug('')}>
              Auto
            </Btn>
          )}
          {!iconSlug && <span className="text-[11px] text-slate-500">Auto from name</span>}
        </div>
        <div className="flex gap-2 justify-end">
          <Btn ghost type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </Btn>
          <Btn type="submit" disabled={saving || !name.trim()}>
            {saving ? 'Adding…' : 'Add'}
          </Btn>
        </div>
      </form>
      {pickingIcon && (
        <IconPicker
          value={iconSlug}
          onSelect={(slug) => {
            setIconSlug(slug);
            setPickingIcon(false);
          }}
          onClose={() => setPickingIcon(false)}
        />
      )}
    </Card>
  );
}
