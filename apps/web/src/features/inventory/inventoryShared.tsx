/**
 * Shared inventory item UI — used by the campaign Inventory page and character
 * sheet inventory section (issue #454).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Character, InventoryItem, PartyCharacter, RuleEntry } from '@campfire/schema';
import { api, API, ApiError, translateApiError } from '../../lib/api';
import { useAnnounce } from '../../components/Announcer';
import { Card, Btn, TextInput, Skeleton } from '../../components/ui';
import { UIIcon } from '../../components/UIIcon';
import { ConfirmDialog } from '../../components/ConfirmDialog';
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
import { defaultItemIconSlug, itemIconSlug } from '../../lib/inventoryIcons';
import { parseLocalizedInteger } from '../../lib/i18nNumbers';
import { useFormattingLocale } from '../../lib/format';
import { UI_ICON_SIZE } from '../../lib/uiIcons';
import { useDialog } from '../../components/useDialog';
import { ruleEntryIconSlug } from '../../lib/ruleEntryIcon';

/** Add-item quantity bounds (issue #459). */
export const ITEM_QTY_MIN = 0;
export const ITEM_QTY_MAX = 1_000_000;
export const ITEM_QTY_STEP = 1;

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function ItemSection({
  title,
  icon,
  items,
  characters,
  writableOwners,
  canEditItem,
  onChanged,
  partyStashTitle,
  embedded,
}: {
  title: string;
  icon: string;
  items: InventoryItem[];
  characters: Pick<PartyCharacter, 'id' | 'name'>[];
  writableOwners: Character[];
  canEditItem: (item: InventoryItem) => boolean;
  onChanged: () => void;
  partyStashTitle: string;
  /** When true, omit the outer Card wrapper (embedded in another card). */
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  if (items.length === 0 && title !== partyStashTitle) return null;

  const body = (
    <>
      <h2 className="flex items-center gap-2 font-bold text-white text-sm">
        <GameIcon slug={icon} size={UI_ICON_SIZE.sm} /> {title}
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-secondary">{t('inventory.empty')}</p>
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
    </>
  );

  if (embedded) return <div className="space-y-2">{body}</div>;
  return <Card className="space-y-2">{body}</Card>;
}

export function ItemRow({
  item,
  editable,
  characters,
  writableOwners,
  onChanged,
}: {
  item: InventoryItem;
  editable: boolean;
  characters: Pick<PartyCharacter, 'id' | 'name'>[];
  writableOwners: Character[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickingIcon, setPickingIcon] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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

  async function compendiumAction(action: 'refresh' | 'overridden' | 'detached') {
    setBusy(true); setError(null);
    try {
      const updated = await api.post<InventoryItem>(`${API}/inventory/${committed.id}/compendium/${action}`);
      setCommitted(updated); onChanged();
    } catch (err) { setError(translateApiError(err, t, { fallbackKey: 'inventory.errors.updateItem' })); }
    finally { setBusy(false); }
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
          <GameIcon slug={iconSlug} size={UI_ICON_SIZE.lg} title={committed.name} />
        </button>
      ) : (
        <span className="shrink-0 mt-0.5 text-[var(--color-accent)]">
          <GameIcon slug={iconSlug} size={UI_ICON_SIZE.lg} title={committed.name} />
        </span>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-white truncate">
          {committed.name}
          {committed.qty !== 1 && <span className="text-secondary font-normal"> ×{committed.qty}</span>}
        </p>
        {committed.notes && <Markdown className="!text-[12px] !text-secondary">{committed.notes}</Markdown>}
        {committed.compendiumState && (
          <div className="mt-1 text-[11px] text-secondary space-y-1" data-testid="compendium-inventory-source">
            <span className="tag tag-neutral">{committed.compendiumState.replace('_', ' ')}</span>
            {committed.compendiumSnapshot && <>
              <span className="ml-1">{committed.compendiumSnapshot.source || committed.compendiumRef?.packSlug}{committed.compendiumSnapshot.license ? ` · ${committed.compendiumSnapshot.license}` : ''}</span>
              {committed.compendiumSnapshot.body && <details><summary>Source details</summary><Markdown className="!text-[12px]">{committed.compendiumSnapshot.body}</Markdown></details>}
              {committed.compendiumSnapshot.dataJson && <details><summary>Item data</summary><pre className="text-xs whitespace-pre-wrap">{committed.compendiumSnapshot.dataJson}</pre></details>}
              {committed.ruleEntryId != null && committed.compendiumState !== 'detached' && <a className="ml-1 underline" href={`/c/${committed.campaignId}/compendium/${committed.ruleEntryId}`}>Open in Compendium</a>}
              {committed.compendiumSnapshot.sourceUrl && <a className="ml-1 underline" href={committed.compendiumSnapshot.sourceUrl} target="_blank" rel="noreferrer">Source ↗</a>}
            </>}
          </div>
        )}
        {error && <p className="text-[12px] text-rose-400">{error}</p>}
      </div>
      {editable && (
        <div className="flex flex-wrap items-center gap-1.5 shrink-0 w-full sm:w-auto sm:ml-auto justify-end">
          <Btn density="xs"
            ghost
            className="!px-2 text-xs"
            disabled={busy || committed.qty <= 0}
            onClick={() => void adjustQty(-1)}
            aria-label={t('inventory.decreaseQtyAria', { name: committed.name })}
          >
            −
          </Btn>
          <Btn density="xs"
            ghost
            className="!px-2 text-xs"
            disabled={busy}
            onClick={() => void adjustQty(1)}
            aria-label={t('inventory.increaseQtyAria', { name: committed.name })}
          >
            +
          </Btn>
          <select
            className="cf-select text-xs cf-density-xs"
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
          <Btn density="xs"
            ghost
            danger
            className="!px-2 text-xs"
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
            aria-label={t('inventory.deleteAria', { name: committed.name })}
          >
            <UIIcon name="close" size="xs" />
          </Btn>
          {committed.compendiumState && committed.compendiumState !== 'detached' && <>
            {committed.compendiumState === 'linked_updated' && <Btn density="xs" ghost className="!px-2 text-xs" disabled={busy} onClick={() => void compendiumAction('refresh')}>Refresh source</Btn>}
            <Btn density="xs" ghost className="!px-2 text-xs" disabled={busy} onClick={() => void compendiumAction('overridden')}>Keep local</Btn>
            <Btn density="xs" ghost className="!px-2 text-xs" disabled={busy} onClick={() => void compendiumAction('detached')}>Detach</Btn>
          </>}
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
            if ((committed.iconSlug ?? '') !== slug) void patch({ iconSlug: slug });
          }}
          onClose={() => setPickingIcon(false)}
        />
      )}
    </li>
  );
}

export function AddItemForm({
  campaignId,
  owners,
  defaultOwner = 'party',
  onCancel,
  onCreated,
}: {
  campaignId: number;
  owners: Character[];
  /** Initial owner select value — 'party' or a character id string. */
  defaultOwner?: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [qty, setQty] = useState('1');
  const [owner, setOwner] = useState(defaultOwner);
  const [notes, setNotes] = useState('');
  const [iconSlug, setIconSlug] = useState('');
  const [pickingIcon, setPickingIcon] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qtyError, setQtyError] = useState<string | null>(null);
  const formatLocale = useFormattingLocale();
  const qtyHelp = t('inventory.quantityHelp', {
    min: ITEM_QTY_MIN.toLocaleString(formatLocale ?? 'en-US'),
    max: ITEM_QTY_MAX.toLocaleString(formatLocale ?? 'en-US'),
    step: ITEM_QTY_STEP,
  });

  const previewSlug = itemIconSlug({ name, iconSlug });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
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
        iconSlug,
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

  const [showCompendiumPicker, setShowCompendiumPicker] = useState(false);

  return (
    <Card className="space-y-3" data-testid="inventory-add-item">
      <div className="flex items-center justify-between">
        <h2 className="font-bold text-white text-sm">{t('inventory.addItemTitle')}</h2>
        <Btn
          density="xs"
          ghost
          type="button"
          className="text-xs text-[var(--color-accent)] hover:underline"
          onClick={() => setShowCompendiumPicker(true)}
        >
          {t('inventory.fromCompendium')}
        </Btn>
      </div>
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
            <GameIcon slug={previewSlug} size={UI_ICON_SIZE.lg} title={getIcon(previewSlug)?.name} />
          </span>
          <Btn density="xs" ghost type="button" className="text-xs" onClick={() => setPickingIcon(true)}>
            {iconSlug ? t('inventory.changeIcon') : t('inventory.chooseIcon')}
          </Btn>
          {iconSlug && (
            <Btn density="xs" ghost type="button" className="text-xs" onClick={() => setIconSlug('')}>
              {t('inventory.autoIcon')}
            </Btn>
          )}
          {!iconSlug && <span className="text-[11px] text-secondary">{t('inventory.autoFromName')}</span>}
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
      {showCompendiumPicker && (
        <CompendiumItemPickerModal
          campaignId={campaignId}
          owners={owners}
          defaultOwner={owner}
          onClose={() => setShowCompendiumPicker(false)}
          onCreated={() => {
            setShowCompendiumPicker(false);
            onCreated();
          }}
        />
      )}
    </Card>
  );
}

export function CompendiumItemPickerModal({
  campaignId,
  owners,
  defaultOwner = 'party',
  onClose,
  onCreated,
}: {
  campaignId: number;
  owners: Character[];
  defaultOwner?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useDialog({ onClose });
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<RuleEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<RuleEntry | null>(null);
  const [owner, setOwner] = useState(defaultOwner);
  const [qty, setQty] = useState('1');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicatePrompt, setDuplicatePrompt] = useState(false);

  const fetchGen = useRef(0);

  const search = useCallback(
    async (q: string) => {
      const gen = ++fetchGen.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api.get<{ items: RuleEntry[] }>(
          `${API}/rules/search?campaignId=${campaignId}&type=item&q=${encodeURIComponent(q)}`,
        );
        if (gen !== fetchGen.current) return;
        setItems(res.items ?? []);
      } catch (err) {
        if (gen !== fetchGen.current) return;
        setError(translateApiError(err, t, { fallbackKey: 'inventory.errors.load' }));
      } finally {
        if (gen === fetchGen.current) {
          setLoading(false);
        }
      }
    },
    [campaignId, t],
  );

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      if (!cancelled) void search(query);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, search]);

  async function acquire(duplicateMode: 'confirm' | 'increment' | 'separate' = 'confirm') {
    if (!selectedEntry) return;
    setSubmitting(true);
    setError(null);
    try {
      const ownerType = owner === 'party' ? 'party' : 'character';
      const characterId = owner === 'party' ? null : Number(owner);
      const qtyParsed = Math.max(1, Number(qty) || 1);
      await api.post(`${API}/campaigns/${campaignId}/inventory/from-compendium`, {
        ruleEntryId: selectedEntry.id,
        ownerType,
        characterId,
        qty: qtyParsed,
        notes: notes.trim(),
        duplicateMode,
      });
      onCreated();
      onClose();
    } catch (err) {
      const code = err instanceof Error && 'body' in err ? (err as { body?: { code?: string } }).body?.code : '';
      if (code === 'INVENTORY_COMPENDIUM_DUPLICATE' || (err instanceof ApiError && err.status === 409)) {
        setDuplicatePrompt(true);
      } else {
        setError(translateApiError(err, t, { fallbackKey: 'inventory.errors.addItem' }));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="compendium-picker-title"
      ref={dialogRef}
    >
      <Card
        className="w-full max-w-xl max-h-[85vh] flex flex-col space-y-4 overflow-hidden"
        data-testid="compendium-item-picker-modal"
      >
        <div className="flex items-center justify-between pb-2 border-b border-[var(--color-neutral-800)]">
          <h2 id="compendium-picker-title" className="font-bold text-white text-base flex items-center gap-2">
            <GameIcon slug="backpack" size={UI_ICON_SIZE.sm} />
            {t('inventory.fromCompendiumTitle')}
          </h2>
          <Btn density="xs" ghost onClick={onClose} aria-label={t('common.cancel')}>
            <UIIcon name="close" size="xs" />
          </Btn>
        </div>

        {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}

        <div className="space-y-3">
          <TextInput
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedEntry(null);
              setDuplicatePrompt(false);
            }}
            placeholder={t('inventory.searchCompendiumPlaceholder')}
            autoFocus
          />
        </div>

        <div className="flex-1 overflow-y-auto min-h-[200px] space-y-2 pr-1" style={{ borderColor: 'var(--color-neutral-800)' }}>
          {loading ? (
            <Skeleton lines={4} />
          ) : items.length === 0 ? (
            <p className="text-sm text-secondary py-8 text-center">{t('inventory.noCompendiumItems')}</p>
          ) : (
            <ul className="divide-y divide-[var(--color-neutral-800)]">
              {items.map((entry) => {
                const icon = ruleEntryIconSlug(entry);
                const isSelected = selectedEntry?.id === entry.id;
                return (
                  <li key={entry.id} className="py-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedEntry(entry);
                        setDuplicatePrompt(false);
                      }}
                      className={`w-full text-left p-2 rounded-md transition-colors flex items-center gap-3 ${
                        isSelected
                          ? 'bg-[var(--color-neutral-800)] border border-[var(--color-accent)]'
                          : 'hover:bg-[var(--color-neutral-800)]'
                      }`}
                    >
                      <span className="shrink-0 text-[var(--color-accent)]">
                        <GameIcon slug={icon} size={UI_ICON_SIZE.md} title={entry.name} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-white truncate">{entry.name}</p>
                        {entry.summary && <p className="text-xs text-secondary truncate">{entry.summary}</p>}
                      </div>
                      {isSelected ? (
                        <span className="text-xs font-semibold text-[var(--color-accent)]">{t('inventory.selectItem')} ✓</span>
                      ) : (
                        <Btn density="xs" ghost type="button" className="text-xs">
                          {t('common.select', { defaultValue: 'Select' })}
                        </Btn>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {selectedEntry && (
          <div className="pt-3 border-t border-[var(--color-neutral-800)] space-y-3">
            {duplicatePrompt ? (
              <div className="p-3 rounded bg-[var(--color-neutral-800)] space-y-2">
                <p className="text-xs font-semibold text-amber-400">{t('inventory.duplicateConfirmTitle')}</p>
                <p className="text-xs text-secondary">{t('inventory.duplicateConfirmBody')}</p>
                <div className="flex gap-2 pt-1">
                  <Btn density="xs" type="button" disabled={submitting} onClick={() => void acquire('increment')}>
                    {t('inventory.incrementQty')}
                  </Btn>
                  <Btn density="xs" ghost type="button" disabled={submitting} onClick={() => void acquire('separate')}>
                    {t('inventory.addSeparate')}
                  </Btn>
                </div>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    idPrefix="compendium-picker"
                    name="owner"
                    as="select"
                    label={t('inventory.fields.owner.label')}
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                  >
                    <option value="party">{t('inventory.partyStash')}</option>
                    {owners.map((c) => (
                      <option key={c.id} value={String(c.id)}>
                        {c.name}
                      </option>
                    ))}
                  </Field>
                  <Field
                    idPrefix="compendium-picker"
                    name="qty"
                    label={t('inventory.quantity')}
                    type="text"
                    inputMode="numeric"
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                  />
                </div>
                <Field
                  idPrefix="compendium-picker"
                  name="notes"
                  label={t('inventory.fields.notes.label')}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t('inventory.notesPlaceholder')}
                  optional
                />
              </>
            )}
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-[var(--color-neutral-800)]">
          <a
            href={`/c/${campaignId}/compendium?type=item`}
            className="text-xs text-[var(--color-accent)] hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            {t('inventory.browseCompendiumLink')}
          </a>
          <div className="flex gap-2">
            <Btn ghost type="button" onClick={onClose} disabled={submitting}>
              {t('common.cancel')}
            </Btn>
            {selectedEntry && !duplicatePrompt && (
              <Btn type="button" disabled={submitting} onClick={() => void acquire('confirm')}>
                {submitting ? t('inventory.adding') : t('inventory.addFromCompendium')}
              </Btn>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
