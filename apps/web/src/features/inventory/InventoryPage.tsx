/**
 * Inventory & loot — party treasury (coin totals) plus items grouped into the
 * party stash and per-character packs. Members can read everything; the dm and
 * players may adjust the treasury and manage the stash; character items are
 * writable only by the dm or the character's owning player (server-enforced,
 * mirrored here so read-only rows don't render controls).
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import type { Character, InventoryItem, Treasury } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Btn, TextInput, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { IconPicker } from '../../components/IconPicker';
import { Markdown } from '../../components/Markdown';
import { getIcon } from '../../lib/icons';
import { itemIconSlug, COIN_ICON, COIN_COLORS } from '../../lib/inventoryIcons';

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
          {treasury && <TreasuryCard campaignId={id} treasury={treasury} canEdit={canEdit} onChanged={setTreasury} />}

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
              icon="🎒"
              title="No loot yet"
              hint={canEdit ? 'Add the party\'s first item with "+ Add item".' : 'Nothing has been logged by the party yet.'}
            />
          ) : (
            <>
              <ItemSection
                title="Party stash"
                icon="🎒"
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
                  icon="🧝"
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

function TreasuryCard({
  campaignId,
  treasury,
  canEdit,
  onChanged,
}: {
  campaignId: number;
  treasury: Treasury;
  canEdit: boolean;
  onChanged: (t: Treasury) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<CoinKey, string>>({ pp: '', gp: '', ep: '', sp: '', cp: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setValues({
      pp: String(treasury.pp),
      gp: String(treasury.gp),
      ep: String(treasury.ep),
      sp: String(treasury.sp),
      cp: String(treasury.cp),
    });
    setError(null);
    setEditing(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const set: Partial<Record<CoinKey, number>> = {};
      for (const { key } of COINS) {
        const n = Number(values[key]);
        set[key] = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
      }
      const updated = await api.patch<Treasury>(`${API}/campaigns/${campaignId}/treasury`, { set });
      onChanged(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update the treasury.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="font-bold text-white text-sm">💰 Party treasury</h2>
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
          <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
            {COINS.map(({ key, label }) => (
              <label key={key} className="space-y-1">
                <span className="block text-[11px] text-slate-500 uppercase tracking-wide">{label}</span>
                <TextInput
                  type="number"
                  min={0}
                  value={values[key]}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <div className="flex gap-2 justify-end">
            <Btn ghost type="button" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Btn>
            <Btn type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
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
      <h2 className="font-bold text-white text-sm">
        {icon} {title}
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
    <li className="py-2 flex flex-wrap items-start gap-x-3 gap-y-2">
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

  // Live preview: the DM's explicit pick, else the name-derived default so they
  // see what the row will show before saving.
  const previewSlug = itemIconSlug({ name, iconSlug });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        qty: Math.max(0, Math.trunc(Number(qty) || 1)),
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
          <TextInput type="number" min={0} placeholder="Qty" value={qty} onChange={(e) => setQty(e.target.value)} />
        </div>
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
