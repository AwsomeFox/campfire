/**
 * Set pieces panel (issue #1308) — DM-only management surface for persistent map objects
 * (chests, traps, doors, hazards, quest markers). Deliberately a form-driven CRUD list, NOT
 * click-to-place / drag-on-canvas: `BattleMap.tsx` is a 4000+-line, heavily perf-tuned
 * pointer-gesture state machine (issues #2083, #2149 both landed the same day this feature
 * was scoped), and adding a new interactive gesture kind there is exactly the kind of
 * expansion the smallest-coherent-slice discipline exists to defer. Placement/move/label/
 * delete all round-trip through this panel's fields instead; the object itself still RENDERS
 * on the map (see `map/MapObjectsOverlay.tsx`, a read-only overlay layer) so the DM sees it
 * land in the right spot. Drag-on-canvas and grid snapping are left to a follow-up.
 *
 * DM-only by mount gate (`canDmWrite`), matching every other write-capable panel in this
 * file's siblings (`CheckRequestPanel`, `ResourceTrackerPanel`). A player still SEES
 * non-dmOnly objects — that happens automatically via the map overlay reading the same
 * `encounter.mapObjects` this panel does, already redacted server-side
 * (`filterMapObjectsForViewer`) before either component ever mounts.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MapObject } from '@campfire/schema';
import { Card, Btn, TextInput } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { IconPicker } from '../../components/IconPicker';
import { UI_ICON_SIZE } from '../../lib/uiIcons';
import { api, API, translateApiError } from '../../lib/api';
import { invalidateEncounter } from '../../lib/query';
import { useQueryClient } from '@tanstack/react-query';
import { useAnnounce } from '../../components/Announcer';

/** Stable-ish short id for a new map object (crypto.randomUUID when available). Mirrors BattleMap's own newAoeId. */
function newMapObjectId(): string {
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return uuid.slice(0, 40);
}

function clampPercent(raw: string, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

export function MapObjectsPanel({
  encounterId,
  objects,
  canDmWrite,
  onError,
}: {
  encounterId: number;
  objects: MapObject[];
  canDmWrite: boolean;
  onError: (msg: string | null) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addLabel, setAddLabel] = useState('');
  const [addIconSlug, setAddIconSlug] = useState('');
  const [pickingIconFor, setPickingIconFor] = useState<'add' | string | null>(null);

  if (!canDmWrite) return null;

  async function place(): Promise<void> {
    if (!addIconSlug) return;
    onError(null);
    setBusyId('__add__');
    const id = newMapObjectId();
    try {
      await api.post(`${API}/encounters/${encounterId}/map-objects`, {
        id,
        label: addLabel.trim(),
        iconSlug: addIconSlug,
        x: 50,
        y: 50,
        dmOnly: false,
      });
      setAddLabel('');
      setAddIconSlug('');
      announce(t('encounters.map.objects.placed', { label: addLabel.trim() || addIconSlug }));
      invalidateEncounter(queryClient, encounterId);
    } catch (err) {
      onError(translateApiError(err, t, { fallbackKey: 'encounters.map.objects.placeError' }));
    } finally {
      setBusyId(null);
    }
  }

  async function update(objectId: string, patch: Partial<Pick<MapObject, 'label' | 'iconSlug' | 'x' | 'y' | 'dmOnly'>>): Promise<void> {
    onError(null);
    setBusyId(objectId);
    try {
      await api.patch(`${API}/encounters/${encounterId}/map-objects/${encodeURIComponent(objectId)}`, patch);
      invalidateEncounter(queryClient, encounterId);
    } catch (err) {
      onError(translateApiError(err, t, { fallbackKey: 'encounters.map.objects.updateError' }));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(objectId: string, label: string): Promise<void> {
    onError(null);
    setBusyId(objectId);
    try {
      await api.delete(`${API}/encounters/${encounterId}/map-objects/${encodeURIComponent(objectId)}`);
      announce(t('encounters.map.objects.removed', { label }));
      invalidateEncounter(queryClient, encounterId);
    } catch (err) {
      onError(translateApiError(err, t, { fallbackKey: 'encounters.map.objects.removeError' }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className="space-y-2" data-testid="map-objects-panel">
      <h2 className="card-kicker mb-0">{t('encounters.map.objects.title')}</h2>
      {objects.length === 0 && <p className="text-[12px] text-secondary">{t('encounters.map.objects.empty')}</p>}
      <div className="space-y-1.5">
        {objects.map((obj) => (
          <div key={obj.id} className="flex items-center gap-1.5 flex-wrap text-[13px]" data-testid={`map-object-row-${obj.id}`}>
            <button
              type="button"
              onClick={() => setPickingIconFor(obj.id)}
              disabled={busyId === obj.id}
              aria-label={t('encounters.map.objects.chooseIcon')}
              className="cf-inset"
              style={{ background: 'transparent', border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', padding: 2, cursor: busyId === obj.id ? 'default' : 'pointer' }}
            >
              <GameIcon slug={obj.iconSlug} size={UI_ICON_SIZE.sm} />
            </button>
            <TextInput
              defaultValue={obj.label}
              aria-label={t('encounters.map.objects.labelField')}
              placeholder={t('encounters.map.objects.labelPlaceholder')}
              disabled={busyId === obj.id}
              style={{ flex: '1 1 140px', minWidth: 100 }}
              onBlur={(e) => {
                const next = e.currentTarget.value;
                if (next !== obj.label) void update(obj.id, { label: next });
              }}
            />
            <TextInput
              type="number"
              min={0}
              max={100}
              defaultValue={obj.x}
              aria-label={t('encounters.map.objects.xField')}
              disabled={busyId === obj.id}
              style={{ width: 64 }}
              onBlur={(e) => {
                const next = clampPercent(e.currentTarget.value, obj.x);
                if (next !== obj.x) void update(obj.id, { x: next });
              }}
            />
            <TextInput
              type="number"
              min={0}
              max={100}
              defaultValue={obj.y}
              aria-label={t('encounters.map.objects.yField')}
              disabled={busyId === obj.id}
              style={{ width: 64 }}
              onBlur={(e) => {
                const next = clampPercent(e.currentTarget.value, obj.y);
                if (next !== obj.y) void update(obj.id, { y: next });
              }}
            />
            <label className="flex items-center gap-1 text-[11px] text-secondary">
              <input
                type="checkbox"
                checked={obj.dmOnly}
                disabled={busyId === obj.id}
                onChange={(e) => void update(obj.id, { dmOnly: e.currentTarget.checked })}
              />
              {t('encounters.map.objects.dmOnly')}
            </label>
            <Btn
              density="xs"
              ghost
              type="button"
              className="text-xs"
              disabled={busyId === obj.id}
              onClick={() => void remove(obj.id, obj.label || obj.iconSlug)}
            >
              {t('common.delete')}
            </Btn>
          </div>
        ))}
      </div>
      <form
        className="flex items-center gap-1.5 flex-wrap cf-print-hide"
        onSubmit={(e) => {
          e.preventDefault();
          void place();
        }}
      >
        <button
          type="button"
          onClick={() => setPickingIconFor('add')}
          disabled={busyId === '__add__'}
          aria-label={t('encounters.map.objects.chooseIcon')}
          className="cf-inset"
          style={{ background: 'transparent', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)', padding: 2, cursor: busyId === '__add__' ? 'default' : 'pointer' }}
        >
          {addIconSlug ? <GameIcon slug={addIconSlug} size={UI_ICON_SIZE.sm} /> : <span className="text-[11px] text-secondary px-1">{t('encounters.map.objects.chooseIcon')}</span>}
        </button>
        <TextInput
          value={addLabel}
          onChange={(e) => setAddLabel(e.currentTarget.value)}
          placeholder={t('encounters.map.objects.labelPlaceholder')}
          aria-label={t('encounters.map.objects.labelField')}
          disabled={busyId === '__add__'}
          style={{ flex: '1 1 140px', minWidth: 100 }}
        />
        <Btn type="submit" density="xs" disabled={busyId === '__add__' || !addIconSlug}>
          {busyId === '__add__' ? t('encounters.map.objects.placing') : t('encounters.map.objects.add')}
        </Btn>
      </form>
      {pickingIconFor != null && (
        <IconPicker
          value={pickingIconFor === 'add' ? addIconSlug : objects.find((o) => o.id === pickingIconFor)?.iconSlug ?? ''}
          onSelect={(slug) => {
            if (pickingIconFor === 'add') {
              setAddIconSlug(slug);
            } else {
              void update(pickingIconFor, { iconSlug: slug });
            }
            setPickingIconFor(null);
          }}
          onClose={() => setPickingIconFor(null)}
        />
      )}
    </Card>
  );
}
