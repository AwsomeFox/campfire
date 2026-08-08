/**
 * Character sheet inventory — filters the campaign inventory to this character's
 * pack and reuses the same item controls as the campaign Inventory page (issue #454).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { Character, InventoryItem } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { Btn, ErrorNote, Skeleton } from '../../components/ui';
import { AddItemForm, CompendiumItemPickerModal, ItemSection } from '../inventory/inventoryShared';

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

  const load = useCallback(async () => {
    setError(null);
    try {
      const [itemList, chars] = await Promise.all([
        api.get<InventoryItem[]>(`${API}/campaigns/${campaignId}/inventory`),
        api.get<Character[]>(`${API}/campaigns/${campaignId}/characters`),
      ]);
      setItems(itemList);
      setCharacters(chars);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'inventory.errors.load' }));
    } finally {
      setLoading(false);
    }
  }, [campaignId, t]);

  useEffect(() => {
    void load();
  }, [load]);

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
              onCreated={() => {
                setAdding(false);
                void load();
              }}
            />
          )}

          {showCompendiumPicker && canManageCharacter && (
            <CompendiumItemPickerModal
              campaignId={campaignId}
              owners={writableOwners}
              defaultOwner={String(character.id)}
              onClose={() => setShowCompendiumPicker(false)}
              onCreated={() => {
                setShowCompendiumPicker(false);
                void load();
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
              onChanged={() => void load()}
              partyStashTitle={character.name}
              embedded
            />
          )}
        </>
      )}
    </div>
  );
}
