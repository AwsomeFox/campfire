import { useState } from 'react';
import { Dialog, Btn } from './ui';

export type MapReplaceMode = 'replace' | 'remove';

export type MapReplaceAlignment = 'preserve' | 'reset';

export type MapReplaceCounts = {
  /** World-map pins or encounter tokens, depending on caller. */
  points?: number;
  /** Battle-map grid (size + calibration) is set. */
  grid?: boolean;
  /** Battle-map fog of war is enabled. */
  fog?: boolean;
  /** Battle-map AoE templates. */
  aoe?: number;
};

type MapReplaceDialogProps = {
  mode: MapReplaceMode;
  /** The new map preview for replace; the current map preview for remove. */
  previewUrl: string | null;
  /** Counts of dependent spatial state to inventory for the user. */
  counts: MapReplaceCounts;
  /** Initial selected alignment. */
  defaultAlignment: MapReplaceAlignment;
  busy?: boolean;
  onChoice: (alignment: MapReplaceAlignment) => void;
  onCancel: () => void;
};

export function MapReplaceDialog({
  mode,
  previewUrl,
  counts,
  defaultAlignment,
  busy,
  onChoice,
  onCancel,
}: MapReplaceDialogProps) {
  const titleId = 'map-replace-dialog-title';
  const [alignment, setAlignment] = useState<MapReplaceAlignment>(defaultAlignment);

  const confirmLabel = mode === 'remove' ? 'Remove map' : 'Use this map';

  const pointLabel = mode === 'remove'
    ? 'Pins / tokens stay on the removed map'
    : 'Pins / tokens carry over to the new map';

  return (
    <Dialog
      title={mode === 'remove' ? 'Remove map?' : 'Replace map?'}
      titleId={titleId}
      onBackdropClick={onCancel}
      data-overlay="dialog"
    >
      <div
        className="flex flex-col gap-4"
        style={{ maxWidth: 420 }}
        role="radiogroup"
        aria-labelledby={titleId}
      >
        {previewUrl && (
          <img
            src={previewUrl}
            alt={mode === 'remove' ? 'Current map' : 'New map preview'}
            className="w-full object-contain rounded"
            style={{ maxHeight: 180, background: 'var(--color-neutral-900)' }}
          />
        )}

        <p className="text-sm text-neutral-300">
          This map has dependent overlays. Choose what happens to them.
        </p>

        <ul className="text-xs space-y-1 text-neutral-400" aria-label="Dependent spatial state">
          {counts.points != null && counts.points > 0 && (
            <li>{counts.points} {counts.points === 1 ? 'pin / token' : 'pins / tokens'}</li>
          )}
          {counts.grid && <li>Grid calibration</li>}
          {counts.fog && <li>Fog of war mask</li>}
          {counts.aoe != null && counts.aoe > 0 && (
            <li>{counts.aoe} AoE template{counts.aoe === 1 ? '' : 's'}</li>
          )}
          {counts.points === 0 && !counts.grid && !counts.fog && (counts.aoe == null || counts.aoe === 0) && (
            <li>No saved overlays</li>
          )}
        </ul>

        <label className="flex items-start gap-3 p-3 rounded border border-neutral-700 cursor-pointer hover:bg-neutral-800/50">
          <input
            type="radio"
            name="mapAlignment"
            value="reset"
            checked={alignment === 'reset'}
            onChange={() => setAlignment('reset')}
            disabled={busy}
          />
          <span className="text-sm">
            <strong>Reset spatial state</strong>
            <span className="block text-neutral-400 text-xs">
              Clear the list above. Recommended when the new image is unrelated.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 p-3 rounded border border-neutral-700 cursor-pointer hover:bg-neutral-800/50">
          <input
            type="radio"
            name="mapAlignment"
            value="preserve"
            checked={alignment === 'preserve'}
            onChange={() => setAlignment('preserve')}
            disabled={busy}
          />
          <span className="text-sm">
            <strong>Preserve alignment</strong>
            <span className="block text-neutral-400 text-xs">
              {pointLabel} at the same percentage positions.
            </span>
          </span>
        </label>

        <p className="text-xs text-neutral-500">
          {mode === 'remove'
            ? 'Removing keeps the overlays unless you reset them now. They reappear if you re-add a map later.'
            : 'An unrelated image should usually reset. You can still remove this choice and re-attach a previous map to restore preserved overlays.'}
        </p>
      </div>

      <div className="dialog-actions" style={{ marginTop: 16 }}>
        <Btn ghost onClick={onCancel} disabled={busy}>
          Cancel
        </Btn>
        <Btn onClick={() => onChoice(alignment)} busy={busy} disabled={busy}>
          {confirmLabel}
        </Btn>
      </div>
    </Dialog>
  );
}
