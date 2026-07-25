/**
 * Inventory & loot — party treasury (coin totals) plus items grouped into the
 * party stash and per-character packs. Members can read everything; the dm and
 * players may adjust the treasury and manage the stash; character items are
 * writable only by the dm or the character's owning player (server-enforced,
 * mirrored here so read-only rows don't render controls).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import type { Character, InventoryItem, Treasury } from '@campfire/schema';
import { api, API, ApiError, translateApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { useCampaignEvents } from '../../lib/useCampaignEvents';
import { useAnnounce } from '../../components/Announcer';
import { Card, Btn, TextInput, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { Field } from '../../components/Field';
import {
  INVENTORY_ADD_PREFIX,
  INVENTORY_FIELD,
} from '../../components/formFieldLabels';
import { GameIcon } from '../../components/GameIcon';
import { entityTargetProps } from '../../lib/entityLinks';
import { IconPicker } from '../../components/IconPicker';
import { Markdown } from '../../components/Markdown';
import { getIcon } from '../../lib/icons';
import { defaultItemIconSlug, itemIconSlug, COIN_ICON, COIN_COLORS } from '../../lib/inventoryIcons';
import { parseLocalizedInteger } from '../../lib/i18nNumbers';
import { useFormattingLocale } from '../../lib/format';

const COIN_KEYS = [
  { key: 'pp', labelKey: 'inventory.coins.pp' },
  { key: 'gp', labelKey: 'inventory.coins.gp' },
  { key: 'ep', labelKey: 'inventory.coins.ep' },
  { key: 'sp', labelKey: 'inventory.coins.sp' },
  { key: 'cp', labelKey: 'inventory.coins.cp' },
] as const;
type CoinKey = (typeof COIN_KEYS)[number]['key'];

/** Add-item quantity bounds (issue #459). Schema allows any non-negative int; the
 *  form exposes a practical max via help text + parseLocalizedInteger. */
const ITEM_QTY_MIN = 0;
const ITEM_QTY_MAX = 1_000_000;
const ITEM_QTY_STEP = 1;

export default function InventoryPage() {
  const { t } = useTranslation();
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const { me } = useAuth();
  const { isDm, canPlayerWrite } = useCampaignAccess();
  const canEdit = canPlayerWrite;
  const myUserId = me?.user.id != null ? String(me.user.id) : null;

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [trashItems, setTrashItems] = useState<InventoryItem[] | null>(null);
  const [showTrash, setShowTrash] = useState(false);
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
    if (orphans.length > 0) groups.push({ character: null, label: t('inventory.unassigned'), items: orphans });
    return groups;
  }, [items, characters]);

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
            <Btn type="button" className="cf-page-header__action" onClick={() => setAdding(true)}>
              {t('inventory.addItem')}
            </Btn>
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
                characters={characters}
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
                  characters={characters}
                  writableOwners={writableOwners}
                  canEditItem={canEditItem}
                  onChanged={load}
                  partyStashTitle={t('inventory.partyStash')}
                />
              ))}

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
                  characters={characters}
                  onChanged={() => {
                    void load();
                    void loadTrash();
                  }}
                />
              )}
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
        <h2 className="flex items-center gap-2 font-bold text-white text-sm"><GameIcon slug="coins" size={16} /> {t('inventory.partyTreasury')}</h2>
        <div className="flex-1" />
        {canEdit && !editing && (
          <Btn ghost className="!min-h-0 !py-1 text-xs" onClick={startEdit}>
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
              <Btn
                ghost
                type="button"
                className="!min-h-0 !py-0.5 !px-2 text-xs ml-2"
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
            {COIN_KEYS.map(({ key, labelKey }) => {
              const label = t(labelKey);
              return (
              <label key={key} className="space-y-1">
                <span className="block text-[11px] text-slate-500 uppercase tracking-wide">{label}</span>
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
                  <GameIcon slug={COIN_ICON} size={16} title={t('inventory.coinCoinsAria', { label })} />
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
                    aria-label={t('inventory.spendOne', { label })}
                  >
                    −
                  </Btn>
                  <Btn
                    ghost
                    className="!min-h-0 !py-0.5 !px-2 text-xs"
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

function ItemSection({
  title,
  icon,
  items,
  characters,
  writableOwners,
  canEditItem,
  onChanged,
  partyStashTitle,
}: {
  title: string;
  icon: string;
  items: InventoryItem[];
  characters: Character[];
  writableOwners: Character[];
  canEditItem: (item: InventoryItem) => boolean;
  onChanged: () => void;
  partyStashTitle: string;
}) {
  const { t } = useTranslation();
  if (items.length === 0 && title !== partyStashTitle) return null;
  return (
    <Card className="space-y-2">
      <h2 className="flex items-center gap-2 font-bold text-white text-sm">
        <GameIcon slug={icon} size={16} /> {title}
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">{t('inventory.empty')}</p>
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

function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function ItemRow({
  item,
  editable,
  characters,
  writableOwners,
  onChanged,
}: {
  item: InventoryItem;
  editable: boolean;
  characters: Character[];
  writableOwners: Character[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickingIcon, setPickingIcon] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Issue #782: render from the last committed server item so +/- announce and
  // display the applied quantity rather than a stale optimistic absolute.
  const [committed, setCommitted] = useState(item);
  useEffect(() => {
    setCommitted(item);
  }, [item]);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.patch<InventoryItem>(`${API}/inventory/${committed.id}`, body);
      setCommitted(updated);
      onChanged();
      return updated;
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'inventory.errors.updateItem' }));
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** Atomic +/- with a fresh per-click idempotency key (issue #782). */
  async function adjustQty(delta: number) {
    const updated = await patch({ qtyDelta: delta, idempotencyKey: newIdempotencyKey() });
    if (updated) {
      announce(t('inventory.qtyAnnouncement', { name: updated.name, qty: updated.qty }));
    }
  }

  async function remove() {
    setConfirmingDelete(false);
    setBusy(true);
    setError(null);
    try {
      await api.delete(`${API}/inventory/${committed.id}`);
      onChanged();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'inventory.errors.deleteItem' }));
    } finally {
      setBusy(false);
    }
  }

  function onMove(value: string) {
    if (value === 'party') {
      if (committed.ownerType !== 'party') void patch({ ownerType: 'party' });
      return;
    }
    const characterId = Number(value);
    if (Number.isFinite(characterId) && characterId !== committed.characterId) {
      void patch({ ownerType: 'character', characterId });
    }
  }

  const currentOwnerValue = committed.ownerType === 'party' ? 'party' : String(committed.characterId ?? '');

  const iconSlug = itemIconSlug(committed);
  const hasOverride = !!(committed.iconSlug && committed.iconSlug.trim());

  return (
    <li className="py-2 flex flex-wrap items-start gap-x-3 gap-y-2" {...entityTargetProps('item', committed.id)}>
      {editable ? (
        <button
          type="button"
          onClick={() => setPickingIcon(true)}
          disabled={busy}
          title={hasOverride ? t('inventory.iconTitleOverride', { name: getIcon(iconSlug)?.name ?? 'custom' }) : t('inventory.iconTitleAuto')}
          aria-label={t('inventory.iconAriaChange', { name: committed.name })}
          className="shrink-0 mt-0.5 text-[var(--color-accent)] hover:text-[var(--color-accent-700)]"
        >
          <GameIcon slug={iconSlug} size={22} title={committed.name} />
        </button>
      ) : (
        <span className="shrink-0 mt-0.5 text-[var(--color-accent)]">
          <GameIcon slug={iconSlug} size={22} title={committed.name} />
        </span>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-white truncate">
          {committed.name}
          {committed.qty !== 1 && <span className="text-slate-500 font-normal"> ×{committed.qty}</span>}
        </p>
        {committed.notes && <Markdown className="!text-[12px] !text-slate-500">{committed.notes}</Markdown>}
        {error && <p className="text-[12px] text-rose-400">{error}</p>}
      </div>
      {editable && (
        <div className="flex flex-wrap items-center gap-1.5 shrink-0 w-full sm:w-auto sm:ml-auto justify-end">
          <Btn
            ghost
            className="!min-h-0 !py-0.5 !px-2 text-xs"
            disabled={busy || committed.qty <= 0}
            onClick={() => void adjustQty(-1)}
            aria-label={t('inventory.decreaseQtyAria', { name: committed.name })}
          >
            −
          </Btn>
          <Btn
            ghost
            className="!min-h-0 !py-0.5 !px-2 text-xs"
            disabled={busy}
            onClick={() => void adjustQty(1)}
            aria-label={t('inventory.increaseQtyAria', { name: committed.name })}
          >
            +
          </Btn>
          <select
            className="cf-select !min-h-0 !py-1 text-xs"
            style={{ width: 'auto' }}
            value={currentOwnerValue}
            disabled={busy}
            onChange={(e) => onMove(e.target.value)}
            aria-label={t('inventory.moveAria', { name: committed.name })}
          >
            <option value="party">{t('inventory.partyStash')}</option>
            {writableOwners.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
            {committed.ownerType === 'character' && committed.characterId != null && !writableOwners.some((c) => c.id === committed.characterId) && (
              <option value={String(committed.characterId)}>{t('inventory.currentOwner')}</option>
            )}
          </select>
          <Btn
            ghost
            danger
            className="!min-h-0 !py-0.5 !px-2 text-xs"
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
            aria-label={t('inventory.deleteAria', { name: committed.name })}
          >
            ✕
          </Btn>
        </div>
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title={t('inventory.deleteConfirmTitle', { defaultValue: 'Delete item?' })}
          body={
            <div className="space-y-2 text-sm">
              <p>
                {t('inventory.deleteConfirmBody', {
                  defaultValue:
                    'This will move {{name}} (×{{qty}}) to the Trash. It can be restored from there until it is purged.',
                  name: committed.name,
                  qty: committed.qty,
                  owner:
                    committed.ownerType === 'party'
                      ? t('inventory.partyStash')
                      : characters.find((c) => c.id === committed.characterId)?.name ?? t('inventory.currentOwner'),
                })}
              </p>
              <p className="text-slate-400">
                {t('inventory.deleteConfirmConsequence', {
                  defaultValue: 'Owner: {{owner}}',
                  owner:
                    committed.ownerType === 'party'
                      ? t('inventory.partyStash')
                      : characters.find((c) => c.id === committed.characterId)?.name ?? t('inventory.currentOwner'),
                })}
              </p>
            </div>
          }
          confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
          pendingLabel={t('common.deleting', { defaultValue: 'Deleting…' })}
          cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}

      {pickingIcon && (
        <IconPicker
          value={committed.iconSlug ?? ''}
          autoSlug={defaultItemIconSlug(committed.name)}
          onSelect={(slug) => {
            setPickingIcon(false);
            // '' clears the override, reverting the row to its name-derived default.
            if ((committed.iconSlug ?? '') !== slug) void patch({ iconSlug: slug });
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
  const { t } = useTranslation();
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
  const qtyHelp = t('inventory.quantityHelp', {
    min: ITEM_QTY_MIN.toLocaleString(formatLocale ?? 'en-US'),
    max: ITEM_QTY_MAX.toLocaleString(formatLocale ?? 'en-US'),
    step: ITEM_QTY_STEP,
  });

  // Live preview: the DM's explicit pick, else the name-derived default so they
  // see what the row will show before saving.
  const previewSlug = itemIconSlug({ name, iconSlug });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    // Issue #633: parse qty without silently defaulting to 1. Issue #459: enforce
    // the same min/max the field help exposes so out-of-range values announce.
    const qtyParsed = parseLocalizedInteger(qty, formatLocale, {
      min: ITEM_QTY_MIN,
      max: ITEM_QTY_MAX,
    });
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
      setError(translateApiError(err, t, { fallbackKey: 'inventory.errors.addItem' }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3" data-testid="inventory-add-item">
      <h2 className="font-bold text-white text-sm">{t('inventory.addItemTitle')}</h2>
      {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-[1fr_7.5rem] gap-3 items-start">
          <Field
            idPrefix={INVENTORY_ADD_PREFIX}
            name={INVENTORY_FIELD.name}
            label={t('inventory.fields.name.label')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
            help={t('inventory.fields.name.help')}
            placeholder={t('inventory.fields.name.placeholder')}
          />
          <Field
            idPrefix={INVENTORY_ADD_PREFIX}
            name={INVENTORY_FIELD.qty}
            label={t('inventory.quantity')}
            type="text"
            inputMode="numeric"
            min={ITEM_QTY_MIN}
            max={ITEM_QTY_MAX}
            step={ITEM_QTY_STEP}
            value={qty}
            error={qtyError}
            help={qtyHelp}
            onChange={(e) => {
              setQty(e.target.value);
              setQtyError(null);
            }}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            idPrefix={INVENTORY_ADD_PREFIX}
            name={INVENTORY_FIELD.owner}
            as="select"
            label={t('inventory.fields.owner.label')}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            help={t('inventory.fields.owner.help')}
          >
            <option value="party">{t('inventory.partyStash')}</option>
            {owners.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </Field>
          <Field
            idPrefix={INVENTORY_ADD_PREFIX}
            name={INVENTORY_FIELD.notes}
            label={t('inventory.fields.notes.label')}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            help={t('inventory.fields.notes.help')}
            placeholder={t('inventory.notesPlaceholder')}
            optional
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-md text-[var(--color-accent)] shrink-0" style={{ background: 'var(--color-neutral-800)' }}>
            <GameIcon slug={previewSlug} size={24} title={getIcon(previewSlug)?.name} />
          </span>
          <Btn ghost type="button" className="!min-h-0 !py-1.5 text-xs" onClick={() => setPickingIcon(true)}>
            {iconSlug ? t('inventory.changeIcon') : t('inventory.chooseIcon')}
          </Btn>
          {iconSlug && (
            <Btn ghost type="button" className="!min-h-0 !py-1.5 text-xs" onClick={() => setIconSlug('')}>
              {t('inventory.autoIcon')}
            </Btn>
          )}
          {!iconSlug && <span className="text-[11px] text-slate-500">{t('inventory.autoFromName')}</span>}
        </div>
        <div className="flex gap-2 justify-end">
          <Btn ghost type="button" onClick={onCancel} disabled={saving}>
            {t('common.cancel')}
          </Btn>
          <Btn type="submit" disabled={saving || !name.trim()}>
            {saving ? t('inventory.adding') : t('inventory.add')}
          </Btn>
        </div>
      </form>
      {pickingIcon && (
        <IconPicker
          value={iconSlug}
          autoSlug={defaultItemIconSlug(name)}
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

function TrashSection({
  items,
  characters,
  onChanged,
}: {
  items: InventoryItem[] | null;
  characters: Character[];
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
  characters: Character[];
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
        <GameIcon slug={iconSlug} size={22} title={item.name} />
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
      <Btn
        ghost
        className="!min-h-0 !py-0.5 !px-2 text-xs"
        disabled={busy}
        onClick={() => void restore()}
        aria-label={t('inventory.restoreAria', { defaultValue: 'Restore {{name}}', name: item.name })}
      >
        {t('inventory.restore', { defaultValue: 'Restore' })}
      </Btn>
    </li>
  );
}
