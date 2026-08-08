/**
 * Shared inventory item UI — used by the campaign Inventory page and character
 * sheet inventory section (issue #454).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Character, CharacterAction, InventoryItem, PartyCharacter, RuleEntry } from '@campfire/schema';
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
import { useFormattingLocale, formatNumber } from '../../lib/format';
import { UI_ICON_SIZE } from '../../lib/uiIcons';
import { useDialog } from '../../components/useDialog';
import { ruleEntryIconSlug } from '../../lib/ruleEntryIcon';
import { EntryFacts, hasEntryFacts } from '../../components/EntryFacts';

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

  // Equip/unequip (issue #1901) — a character-owned item can carry an authored
  // `equippedAction` that surfaces as a usable combat action once equipped (server-side,
  // action-resolver.service.ts). `equipSlot` is a free string (not an enum, see
  // packages/schema), so the slot input below is plain text with common-slot suggestions.
  const [equipOpen, setEquipOpen] = useState(false);
  const [slotDraft, setSlotDraft] = useState('');
  const [equipBusy, setEquipBusy] = useState(false);
  const [equipError, setEquipError] = useState<string | null>(null);
  const [slotConflict, setSlotConflict] = useState<{ itemId: number; itemName: string; slot: string } | null>(null);
  const slotSuggestionsMap = t('inventory.equip.slotSuggestions', { returnObjects: true }) as Record<string, string>;
  const slotSuggestions = useMemo(() => Object.values(slotSuggestionsMap ?? {}), [slotSuggestionsMap]);

  async function submitEquip(slot: string) {
    const trimmed = slot.trim();
    if (!trimmed) {
      setEquipError(t('inventory.equip.slotRequired'));
      return;
    }
    setEquipBusy(true);
    setEquipError(null);
    try {
      const updated = await api.patch<InventoryItem>(`${API}/inventory/${committed.id}`, { equipped: true, equipSlot: trimmed });
      setCommitted(updated);
      setSlotConflict(null);
      setEquipOpen(false);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'INVENTORY_SLOT_CONFLICT' && err.conflictingItemId != null) {
        setSlotConflict({ itemId: err.conflictingItemId, itemName: err.conflictingItemName ?? '', slot: err.equipSlot ?? trimmed });
      } else {
        setEquipError(translateApiError(err, t, { fallbackKey: 'inventory.errors.updateItem' }));
      }
    } finally {
      setEquipBusy(false);
    }
  }

  /**
   * One-tap swap (issue #1901 rework, review: devin-ai-integration + chatgpt-codex-connector
   * P2 on PR #1951): a single atomic PATCH — `displaceEquipped: true` tells the server to
   * unequip the slot-conflicting incumbent and equip THIS item in the same transaction. This
   * used to be two client-orchestrated requests (unequip incumbent, then retry the original
   * equip) with a real half-applied window: another writer could claim the slot between the
   * two requests, or the second request could simply fail — either way leaving the character
   * wearing neither item, and (because the second request went through `submitEquip`, which
   * silently returns without touching `equipBusy` when its slot argument is empty) the equip
   * controls could stay disabled forever with no error shown. One request removes both the
   * race and the swallowed-failure path entirely; there's no intermediate committed state to
   * roll back because the server never applies the unequip half without the equip half.
   *
   * Rework round 3 (review: devin-ai-integration): the button reads "Replace <incumbent>"
   * and the warning above it names `slotConflict.itemName`/`.slot` — that is the
   * confirmation the player is acting on, so the request below MUST target that exact
   * slot. It deliberately ignores the separate slot-text-input state, which stays open and
   * editable while this warning is shown — reading it here would let a player edit that box
   * after seeing the conflict and have "Replace X" silently displace whatever now occupies
   * the freshly typed slot instead of X. The plain equip button (`submitEquip`) is the path
   * for trying a different slot.
   *
   * Rework round (review: chatgpt-codex-connector P2): also sends `expectedConflictingItemId`
   * so the server rejects (with a FRESH 409) rather than silently displacing a DIFFERENT item
   * than the one confirmed, if another writer swapped who occupies the slot between the
   * original 409 and this request — e.g. unequipping the named incumbent and equipping a
   * third item into the same slot while this warning was on screen. On that fresh 409 the
   * catch below re-arms `slotConflict` with the new incumbent, same as `submitEquip`'s own
   * conflict handling, so the player re-confirms against current reality instead of the
   * request just failing opaquely or silently displacing the wrong item.
   */
  async function swapEquip() {
    if (!slotConflict) return;
    setEquipBusy(true);
    setEquipError(null);
    try {
      const updated = await api.patch<InventoryItem>(`${API}/inventory/${committed.id}`, {
        equipped: true,
        equipSlot: slotConflict.slot,
        displaceEquipped: true,
        expectedConflictingItemId: slotConflict.itemId,
      });
      setCommitted(updated);
      setSlotConflict(null);
      setEquipOpen(false);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'INVENTORY_SLOT_CONFLICT' && err.conflictingItemId != null) {
        setSlotConflict({ itemId: err.conflictingItemId, itemName: err.conflictingItemName ?? '', slot: err.equipSlot ?? slotConflict.slot });
      } else {
        setEquipError(translateApiError(err, t, { fallbackKey: 'inventory.errors.updateItem' }));
      }
    } finally {
      setEquipBusy(false);
    }
  }

  /**
   * Issue #2097: the equipped action is now editable in place. Before this the server could
   * hold one (and, since #2097, derive one) but the web app could only DISPLAY it — the only
   * writers were the REST PATCH and the MCP tool, so in practice nobody ever authored or
   * corrected one. Saving here always flips the row's provenance to `manual` server-side, so
   * an edit is never regenerated over by a later equip.
   */
  const [actionOpen, setActionOpen] = useState(false);
  const [actionDraft, setActionDraft] = useState<CharacterAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function openActionEditor() {
    setActionDraft(
      committed.equippedAction ?? { name: committed.name, kind: '', toHit: '', damage: '', targetAc: '', notes: '' },
    );
    setActionError(null);
    setActionOpen(true);
  }

  async function saveAction() {
    if (!actionDraft) return;
    const name = actionDraft.name.trim();
    if (!name) {
      setActionError(t('inventory.equip.actionNameRequired'));
      return;
    }
    setActionBusy(true);
    setActionError(null);
    try {
      // `spec` is deliberately preserved untouched: a derived action carries a structured
      // spec the resolver uses to auto-resolve the attack, and these five text fields are
      // not enough to rebuild one. Dropping it on every edit would silently downgrade a
      // resolvable attack to a text-only row the moment anyone fixed a typo in its name.
      const updated = await api.patch<InventoryItem>(`${API}/inventory/${committed.id}`, {
        equippedAction: { ...actionDraft, name },
      });
      setCommitted(updated);
      setActionOpen(false);
      onChanged();
    } catch (err) {
      setActionError(translateApiError(err, t, { fallbackKey: 'inventory.errors.updateItem' }));
    } finally {
      setActionBusy(false);
    }
  }

  async function removeAction() {
    setActionBusy(true);
    setActionError(null);
    try {
      const updated = await api.patch<InventoryItem>(`${API}/inventory/${committed.id}`, { equippedAction: null });
      setCommitted(updated);
      setActionOpen(false);
      onChanged();
    } catch (err) {
      setActionError(translateApiError(err, t, { fallbackKey: 'inventory.errors.updateItem' }));
    } finally {
      setActionBusy(false);
    }
  }

  async function unequip() {
    setEquipBusy(true);
    setEquipError(null);
    try {
      const updated = await api.patch<InventoryItem>(`${API}/inventory/${committed.id}`, { equipped: false });
      setCommitted(updated);
      onChanged();
    } catch (err) {
      setEquipError(translateApiError(err, t, { fallbackKey: 'inventory.errors.updateItem' }));
    } finally {
      setEquipBusy(false);
    }
  }

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
        <>
          <button
            type="button"
            onClick={() => setPickingIcon(true)}
            disabled={busy}
            title={hasOverride ? t('inventory.iconTitleOverride', { name: getIcon(iconSlug)?.name ?? 'custom' }) : t('inventory.iconTitleAuto')}
            aria-label={t('inventory.iconAriaChange', { name: committed.name })}
            className="shrink-0 mt-0.5 text-[var(--color-accent)] hover:text-[var(--color-accent-700)] cf-print-hide"
          >
            <GameIcon slug={iconSlug} size={UI_ICON_SIZE.lg} title={committed.name} />
          </button>
          <span className="shrink-0 mt-0.5 text-[var(--color-accent)] cf-print-only">
            <GameIcon slug={iconSlug} size={UI_ICON_SIZE.lg} title={committed.name} />
          </span>
        </>
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
              {/* The item's own stats — price, bulk, damage, AC — read straight off the
                  snapshot. Shown OPEN and formatted: they used to sit collapsed behind
                  "Item data" as a raw JSON string, which is the stat line a player needs
                  most while the item is equipped. */}
              {hasEntryFacts(committed.compendiumSnapshot.dataJson) && (
                <EntryFacts data={committed.compendiumSnapshot.dataJson} compact label={t('inventory.compendium.statsLabel')} />
              )}
              {committed.compendiumSnapshot.body && <details><summary>{t('inventory.compendium.sourceDetails')}</summary><Markdown className="!text-[12px]">{committed.compendiumSnapshot.body}</Markdown></details>}
              {committed.ruleEntryId != null && committed.compendiumState !== 'detached' && <a className="ml-1 underline" href={`/c/${committed.campaignId}/compendium/${committed.ruleEntryId}`}>Open in Compendium</a>}
              {committed.compendiumSnapshot.sourceUrl && <a className="ml-1 underline" href={committed.compendiumSnapshot.sourceUrl} target="_blank" rel="noreferrer">Source ↗</a>}
            </>}
          </div>
        )}
        {error && <p className="text-[12px] text-rose-400">{error}</p>}

        {/* Equip/unequip (issue #1901) — party-stash items can never be equipped. */}
        {committed.ownerType === 'character' && (
          <div className="mt-1.5 space-y-1" data-testid="inventory-equip">
            {committed.equipped ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="tag tag-accent text-[11px]" data-testid="inventory-equipped-badge">
                  {committed.equipSlot
                    ? t('inventory.equip.equippedInSlot', { slot: committed.equipSlot })
                    : t('inventory.equip.badge')}
                </span>
                {editable && (
                  <Btn
                    density="xs"
                    ghost
                    className="!px-2 text-xs cf-print-hide"
                    disabled={equipBusy}
                    onClick={() => void unequip()}
                    aria-label={t('inventory.equip.unequipAria', { name: committed.name })}
                    data-testid="inventory-unequip-btn"
                  >
                    {t('inventory.equip.unequipButton')}
                  </Btn>
                )}
              </div>
            ) : (
              editable && (
                <>
                  {!equipOpen ? (
                    <Btn
                      density="xs"
                      ghost
                      type="button"
                      className="!px-2 text-xs cf-print-hide"
                      onClick={() => setEquipOpen(true)}
                      aria-label={t('inventory.equip.equipAria', { name: committed.name })}
                      data-testid="inventory-equip-btn"
                    >
                      {t('inventory.equip.equipButton')}
                    </Btn>
                  ) : (
                    <form
                      className="flex flex-wrap items-center gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void submitEquip(slotDraft);
                      }}
                    >
                      <input
                        type="text"
                        className="input text-xs"
                        style={{ minHeight: 32, maxWidth: 180 }}
                        list={`inventory-slot-suggestions-${committed.id}`}
                        value={slotDraft}
                        onChange={(e) => setSlotDraft(e.target.value)}
                        placeholder={t('inventory.equip.slotPlaceholder')}
                        aria-label={t('inventory.equip.slotLabel')}
                        autoFocus
                        disabled={equipBusy}
                      />
                      <datalist id={`inventory-slot-suggestions-${committed.id}`}>
                        {slotSuggestions.map((slot) => (
                          <option key={slot} value={slot} />
                        ))}
                      </datalist>
                      <Btn density="xs" type="submit" className="text-xs" disabled={equipBusy}>
                        {t('inventory.equip.equipButton')}
                      </Btn>
                      <Btn
                        density="xs"
                        ghost
                        type="button"
                        className="text-xs"
                        disabled={equipBusy}
                        onClick={() => {
                          setEquipOpen(false);
                          setEquipError(null);
                          setSlotConflict(null);
                        }}
                      >
                        {t('common.cancel')}
                      </Btn>
                    </form>
                  )}
                </>
              )
            )}
            {/* Issue #1901 review (devin-ai-integration): an authored equippedAction only
                contributes to the merged usable-action list while the item is EQUIPPED
                (ActionResolverService.equippedItemActionRows filters on equipped=true) — this
                line must not claim a stowed item grants a combat action it doesn't currently
                offer. */}
            {committed.equipped && committed.equippedAction && (
              <p className="text-[11px] text-secondary flex flex-wrap items-center gap-1.5" data-testid="inventory-grants-action">
                <span>{t('inventory.equip.grantsAction', { name: committed.equippedAction.name })}</span>
                {/* Issue #2097: say plainly that the server built this one, so nobody mistakes
                    an assumed proficiency bonus for a number a person checked. */}
                {committed.equippedActionSource === 'derived' && (
                  <span className="tag text-[10px]" title={t('inventory.equip.derivedHelp')} data-testid="inventory-action-derived-badge">
                    {t('inventory.equip.derivedBadge')}
                  </span>
                )}
              </p>
            )}
            {/* The editor is gated on `editable` like every other write control here, and on
                the server having actually sent the field: a reader who is neither DM nor the
                owning player gets `equippedAction: null` (fail-closed redaction), and must
                not be offered an editor that would write one. */}
            {editable && !actionOpen && (
              <Btn
                density="xs"
                ghost
                className="text-xs self-start"
                disabled={actionBusy}
                onClick={openActionEditor}
                aria-label={t(committed.equippedAction ? 'inventory.equip.editActionAria' : 'inventory.equip.addActionAria', { name: committed.name })}
                data-testid="inventory-edit-action-btn"
              >
                {t(committed.equippedAction ? 'inventory.equip.editAction' : 'inventory.equip.addAction')}
              </Btn>
            )}
            {editable && actionOpen && actionDraft && (
              <form
                className="space-y-1.5 rounded border border-subtle p-2"
                data-testid="inventory-action-editor"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  void saveAction();
                }}
              >
                <div className="flex flex-wrap gap-1.5">
                  <TextInput
                    density="xs"
                    className="text-xs"
                    value={actionDraft.name}
                    placeholder={t('inventory.equip.actionName')}
                    aria-label={t('inventory.equip.actionName')}
                    disabled={actionBusy}
                    onChange={(e) => setActionDraft({ ...actionDraft, name: e.target.value })}
                    data-testid="inventory-action-name"
                  />
                  <TextInput
                    density="xs"
                    className="text-xs"
                    value={actionDraft.kind}
                    placeholder={t('inventory.equip.actionKindPlaceholder')}
                    aria-label={t('inventory.equip.actionKind')}
                    disabled={actionBusy}
                    onChange={(e) => setActionDraft({ ...actionDraft, kind: e.target.value })}
                    data-testid="inventory-action-kind"
                  />
                  <TextInput
                    density="xs"
                    className="text-xs"
                    value={actionDraft.toHit}
                    placeholder={t('inventory.equip.actionToHitPlaceholder')}
                    aria-label={t('inventory.equip.actionToHit')}
                    disabled={actionBusy}
                    onChange={(e) => setActionDraft({ ...actionDraft, toHit: e.target.value })}
                    data-testid="inventory-action-tohit"
                  />
                  <TextInput
                    density="xs"
                    className="text-xs"
                    value={actionDraft.damage}
                    placeholder={t('inventory.equip.actionDamagePlaceholder')}
                    aria-label={t('inventory.equip.actionDamage')}
                    disabled={actionBusy}
                    onChange={(e) => setActionDraft({ ...actionDraft, damage: e.target.value })}
                    data-testid="inventory-action-damage"
                  />
                </div>
                <TextInput
                  density="xs"
                  className="text-xs w-full"
                  value={actionDraft.notes}
                  placeholder={t('inventory.equip.actionNotes')}
                  aria-label={t('inventory.equip.actionNotes')}
                  disabled={actionBusy}
                  onChange={(e) => setActionDraft({ ...actionDraft, notes: e.target.value })}
                  data-testid="inventory-action-notes"
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  <Btn density="xs" type="submit" className="text-xs" disabled={actionBusy} data-testid="inventory-action-save-btn">
                    {actionBusy ? t('inventory.equip.savingAction') : t('inventory.equip.saveAction')}
                  </Btn>
                  <Btn
                    density="xs"
                    ghost
                    className="text-xs"
                    type="button"
                    disabled={actionBusy}
                    onClick={() => {
                      setActionOpen(false);
                      setActionError(null);
                    }}
                  >
                    {t('common.cancel')}
                  </Btn>
                  {committed.equippedAction && (
                    <Btn
                      density="xs"
                      ghost
                      className="text-xs text-rose-400"
                      type="button"
                      disabled={actionBusy}
                      onClick={() => void removeAction()}
                      data-testid="inventory-action-remove-btn"
                    >
                      {t('inventory.equip.removeAction')}
                    </Btn>
                  )}
                </div>
                {actionError && <p className="text-[12px] text-rose-400">{actionError}</p>}
              </form>
            )}
            {slotConflict && (
              <div className="text-[11px] text-amber-400 flex flex-wrap items-center gap-2" data-testid="inventory-slot-conflict">
                <span>{t('inventory.equip.conflictBody', { incumbent: slotConflict.itemName, slot: slotConflict.slot })}</span>
                {editable && (
                  <Btn density="xs" className="text-xs" disabled={equipBusy} onClick={() => void swapEquip()} data-testid="inventory-slot-swap-btn">
                    {equipBusy ? t('inventory.equip.swapping') : t('inventory.equip.swapButton', { incumbent: slotConflict.itemName })}
                  </Btn>
                )}
              </div>
            )}
            {equipError && <p className="text-[12px] text-rose-400">{equipError}</p>}
          </div>
        )}
      </div>
      {editable && (
        <div className="flex flex-wrap items-center gap-1.5 shrink-0 w-full sm:w-auto sm:ml-auto justify-end cf-print-hide">
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
    min: formatNumber(ITEM_QTY_MIN),
    max: formatNumber(ITEM_QTY_MAX),
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
            {/* Stats for the highlighted row, so the choice is made on damage/price/bulk
                rather than on the name alone.

                Height-bounded and independently scrollable ON PURPOSE. This card is
                `max-h-[85vh] overflow-hidden` and the results list above it holds a
                `min-h-[200px]` floor, so it cannot shrink to absorb a tall sibling: an
                unbounded preview (a magic weapon carries a dozen-plus facts) would push the
                owner/quantity fields and the Add button past the card edge, clipped with no
                way to scroll to them. */}
            {hasEntryFacts(selectedEntry.dataJson) && (
              <div className="max-h-[22vh] overflow-y-auto pr-1" data-testid="compendium-picker-stats">
                <EntryFacts data={selectedEntry.dataJson} compact label={t('inventory.compendium.statsLabel')} />
              </div>
            )}
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
