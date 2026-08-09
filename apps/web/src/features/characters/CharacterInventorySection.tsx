/**
 * Character sheet inventory — filters the campaign inventory to this character's
 * pack and reuses the same item controls as the campaign Inventory page (issue #454).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { Character, InventoryItem } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { Btn, ErrorNote, Skeleton } from '../../components/ui';
import { AddItemForm, CompendiumItemPickerModal, ItemSection, type InventoryItemChange } from '../inventory/inventoryShared';

export function CharacterInventorySection({
  campaignId,
  character,
  onPackLoaded,
}: {
  campaignId: number;
  character: Character;
  /**
   * Reports this character's pack whenever it loads or changes — on mount and after any
   * mutation made here (add, edit, qty, equip/unequip).
   *
   * The sheet needs the same list to surface the actions equipped gear grants, and this
   * section is already mounted for both tabs, so it publishes what it fetched rather than
   * the sheet fetching `/inventory` a second time. One reader, one source: the two views
   * cannot diverge, and equipping here updates the Actions card with no page reload.
   */
  onPackLoaded?: (items: InventoryItem[]) => void;
}) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const { isDm, canPlayerWrite } = useCampaignAccess();
  const canEdit = canPlayerWrite;
  const myUserId = me?.user.id != null ? String(me.user.id) : null;

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showCompendiumPicker, setShowCompendiumPicker] = useState(false);

  /**
   * Monotonic token so an OLDER reconciliation cannot overwrite newer state.
   *
   * Mutations on two different rows each start their own `load()`. Without this, a GET that
   * captured the list before the second mutation but settled after its GET would replace the
   * newer result wholesale — putting the Build list and the Play gear actions back to stale,
   * which is the very failure the publish-what-you-wrote work removed. Bumped by every load
   * AND by every locally applied mutation, so a refresh already in flight when a write lands
   * is discarded rather than believed.
   */
  const generation = useRef(0);

  const load = useCallback(async () => {
    setError(null);
    const token = ++generation.current;
    try {
      const [itemList, chars] = await Promise.all([
        api.get<InventoryItem[]>(`${API}/campaigns/${campaignId}/inventory`),
        api.get<Character[]>(`${API}/campaigns/${campaignId}/characters`),
      ]);
      if (token !== generation.current) return;
      setItems(itemList);
      setCharacters(chars);
    } catch (err) {
      if (token !== generation.current) return;
      setError(translateApiError(err, t, { fallbackKey: 'inventory.errors.load' }));
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }, [campaignId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Apply what the mutation itself reported, then reconcile with a refetch.
   *
   * The refetch alone was not enough: `load()` keeps the previous `items` when its GET
   * fails, so a successful equip with a failed refresh never reached the sheet — Build
   * showed the item unequipped (from the card's own state) while Play still offered its
   * action as rollable. The write's own response cannot go stale that way.
   */
  const applyChange = useCallback(
    (change?: InventoryItemChange) => {
      // A write is newer than anything already in flight — invalidate those refreshes.
      if (change) generation.current += 1;
      if (change && 'updated' in change) {
        const next = change.updated;
        const displacedId = change.displacedId;
        setItems((prev) => {
          // A slot swap unequipped the incumbent in the same server write; apply that half
          // too, or both items claim the slot (and both offer their actions) until a
          // refetch succeeds.
          const withDisplaced =
            displacedId == null
              ? prev
              : prev.map((i) => (i.id === displacedId ? { ...i, equipped: false, equipSlot: null } : i));
          return withDisplaced.some((i) => i.id === next.id)
            ? withDisplaced.map((i) => (i.id === next.id ? next : i))
            : [...withDisplaced, next];
        });
      } else if (change && 'created' in change) {
        // Creation was the one mutation still relying entirely on the refetch: the POST
        // response was discarded, so a successful add with a failed GET left the new item
        // missing from both this list and the sheet's pack.
        //
        // REPLACE on a matching id rather than skipping: the compendium picker's
        // "Increment quantity" resolution returns the EXISTING row updated
        // (`acquireFromCompendium`), so an id already in the list means a changed item, not
        // a duplicate to ignore — keeping the old object would show a stale qty and notes.
        const made = change.created;
        setItems((prev) => (prev.some((i) => i.id === made.id) ? prev.map((i) => (i.id === made.id ? made : i)) : [...prev, made]));
      } else if (change && 'deletedId' in change) {
        setItems((prev) => prev.filter((i) => i.id !== change.deletedId));
      }
      void load();
    },
    [load],
  );

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

  const writableOwners = useMemo(() => {
    return isDm ? characters : characters.filter((c) => myUserId != null && c.ownerUserId === myUserId);
  }, [characters, isDm, myUserId]);

  const characterItems = useMemo(
    () => items.filter((i) => i.ownerType === 'character' && i.characterId === character.id),
    [items, character.id],
  );

  // Publish after render rather than from `load`, so every path that changes `items`
  // reaches the sheet — including ones the shared ItemSection drives. `characterItems`
  // only gets a new identity when `items` actually changes, so this cannot loop.
  useEffect(() => {
    onPackLoaded?.(characterItems);
  }, [characterItems, onPackLoaded]);

  const canManageCharacter =
    canEdit && (isDm || (myUserId != null && character.ownerUserId === myUserId));

  return (
    <div className="space-y-3" data-testid="character-inventory">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="character-section-inventory-heading" className="card-kicker mb-0">{t('inventory.title')}</h2>
        <Link
          to={`/c/${campaignId}/inventory`}
          className="text-xs text-[var(--color-accent)] hover:underline"
        >
          {t('inventory.characterSheet.partyStashLink')}
        </Link>
      </div>

      {error && <ErrorNote message={error} onRetry={() => void load()} />}

      {loading ? (
        <Skeleton lines={3} />
      ) : (
        <>
          {canManageCharacter && !adding && (
            <>
              <Btn density="xs" type="button" className="text-xs cf-print-hide" onClick={() => setAdding(true)}>
                {t('inventory.addItem')}
              </Btn>
              <Btn density="xs" ghost type="button" className="cf-print-hide text-xs ml-2" onClick={() => setShowCompendiumPicker(true)} aria-label={t('inventory.fromCompendium')}>
                {t('inventory.fromCompendium')}
              </Btn>
            </>
          )}

          {adding && canManageCharacter && (
            <AddItemForm
              campaignId={campaignId}
              owners={writableOwners}
              defaultOwner={String(character.id)}
              onCancel={() => setAdding(false)}
              onCreated={(change) => {
                setAdding(false);
                applyChange(change);
              }}
            />
          )}

          {showCompendiumPicker && canManageCharacter && (
            <CompendiumItemPickerModal
              campaignId={campaignId}
              owners={writableOwners}
              defaultOwner={String(character.id)}
              onClose={() => setShowCompendiumPicker(false)}
              onCreated={(change) => {
                setShowCompendiumPicker(false);
                applyChange(change);
              }}
            />
          )}

          {characterItems.length === 0 && !adding ? (
            <p className="text-xs text-secondary">
              {t('inventory.characterSheet.emptyHint', { name: character.name })}
            </p>
          ) : (
            <ItemSection
              title={character.name}
              icon="backpack"
              items={characterItems}
              characters={characters}
              writableOwners={writableOwners}
              canEditItem={canEditItem}
              onChanged={applyChange}
              partyStashTitle={character.name}
              embedded
            />
          )}
        </>
      )}
    </div>
  );
}
