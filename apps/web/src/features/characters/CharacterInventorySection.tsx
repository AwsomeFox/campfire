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
}: {
  campaignId: number;
  character: Character;
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

  const canManageCharacter =
    canEdit && (isDm || (myUserId != null && character.ownerUserId === myUserId));

  return (
    <div className="space-y-3" data-testid="character-inventory">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="card-kicker mb-0">{t('inventory.title')}</p>
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
            <div className="flex items-center gap-2">
              <Btn density="xs" type="button" className="text-xs" onClick={() => setAdding(true)}>
                {t('inventory.addItem')}
              </Btn>
              <Btn density="xs" ghost type="button" className="text-xs" onClick={() => setShowCompendiumPicker(true)} aria-label={t('inventory.fromCompendium')}>
                {t('inventory.fromCompendium')}
              </Btn>
            </div>
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
