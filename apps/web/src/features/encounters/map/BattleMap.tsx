import { useTranslation } from 'react-i18next';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { UIIcon } from '../../../components/UIIcon';
import { GatedControl } from '../../../components/GatedControl';
import { revealCockpitPanel } from '../vtt/revealCockpitPanel';
import type { AoeShape, AoeTemplate, Attachment, Combatant, EncounterWithCombatants, FogState, GenerateMapParams, GridDistanceRule, GridType, HexOrientation, TokenSize } from '@campfire/schema';
import type { HpFeedbackEvent } from '../hpFeedback';
import { FloatingNumbers } from '../FloatingNumbers';
import { FogUndoStack, appendFogReveal, deleteFogRegion, ensureFogRectIds, eraseFogRegion, filterAoeTemplatesForViewer, fogRectFromCorners, gridDistanceForAdapter, hitTestFogRegion, moveFogRegion, ruleSystemAdapter, type CustomMechanicsProfile } from '@campfire/schema';
import { useQuery } from '@tanstack/react-query';
import { api, API, translateApiError } from '../../../lib/api';
import { reconcileFogSyncState } from '../fogSyncState';
import { adapterConditionLabel } from '../../../lib/adapterVocabularyLabel';
import { initials as tokenInitials } from '../../../lib/avatarText';
import { Card, TextInput } from '../../../components/ui';
import { ImageUpload, MapUploadButton, castEncounterMapUrl, encounterMapSrcSet, encounterMapUrl, playerDisplayEncounterMapUrl, uploadAttachment } from '../../../components/ImageUpload';
import { MapReplaceDialog, type MapReplaceAlignment } from '../../../components/MapReplaceDialog';
import { useDerivativeManifest } from '../../../components/useAttachmentDerivatives';
import { planEncounterMapResponsive } from '../../../components/attachmentSrcSet';
import { GetAMapPanel } from '../../../components/GetAMapPanel';
import { MapConceptGlossary, MapPurposePreview } from '../../../components/mapOnboarding';
import { UndoSnackbar } from '../../../components/UndoSnackbar';
import { useAnnounce } from '../../../components/Announcer';
import { GameIcon } from '../../../components/GameIcon';
import { useDisclosure } from '../../../components/useDisclosure';
import { FOG_HIDDEN_TOKEN_LABEL, partitionMapTokens } from '../mapTokenPlacement';
import { planFormationPlacement, planCollisionFreePlacement, resolveDesiredFormation, selectBy, toggleTokenSelection, tokensInLasso, tokensInRectangle, translateGroup } from '../mapTokenBatch';
import { gridCellRevealRect } from '../fogGridReveal';
import { combatantsInAoe, type AoeHitLayout, type AoeHitTestContext } from '../aoeHitTest';
import { buildAoeDamageApplications, normalizeDirectDamageType, type DamageSaveOutcome, type DirectDamageMetadata, type TargetDamageApplication } from '../directDamage';
import { calibrationToPx, clampPercent, computeContainedRect, DEFAULT_GRID_OPACITY, layerPxToMapPercent, mapPercentToLayerPx, pointerToMapPercent, resolveGridCalibration, snapMapPercentCalibrated, type GridCalibration, type Rect } from '../mapRenderedBounds';
import { formatRulerReadout, gridCellUnitPlural, measureToolHelp, rulerDistanceFeet } from '../rulerReadout';
import { hexAoeCirclePolygons, hexPolygons, hexKeyboardStepPx, mapPercentGridDistance, snapFogRectToHexGrid, snapMapPercentToHex, tokenFootprintDiameterPx } from '../hexGeometry';
import { dragBudget, dragMoveFt, isCurrentActorDrag, type DragBudget } from '../dragDistance';
import { scrollBehavior, prefersReducedMotion } from '../../../lib/prefersReducedMotion';
import { armMapPingTap, decideMapPingTapRelease, isMapPingIntentMenuKeyboardActivation, isMapPingKeyboardActivation, mapPingTapExceededSlop, MAP_PING_KEYBOARD_POINT, MAP_PING_TAP_MAX_MS, type MapPingTapArm } from '../mapPingTap';
import { applyPinch, applyWheelZoom, clampPan, DEFAULT_MAP_VIEWPORT, fitViewport, formatViewportZoomPercent, MAP_VIEWPORT_PAN_STEP_PX, MAP_VIEWPORT_ZOOM_STEP, panBy, resetViewport, surfaceToContentPoint, viewportTransformStyle, zoomByFactor, type MapViewportState, type PinchGesture } from '../mapViewport';
import { tokenDiameterPx } from '../tokenFootprint';
import { tokenIdentityBackground, tokenIdentityShape, TOKEN_IDENTITY_SHAPE_CLIP_PATH } from '../tokenIdentity';
import {
  readTokenDetailMode,
  tokenArcGeometry,
  tokenBadgePlacements,
  tokenConditionBadges,
  tokenDeathMarker,
  tokenHpFraction,
  tokenHpTone,
  writeTokenDetailMode,
  type TokenDetailMode,
} from '../tokenStateBadges';
import { UI_ICON_SIZE } from '../../../lib/uiIcons';
import { GridOverlay } from './GridOverlay';
import { MapObjectsOverlay } from './MapObjectsOverlay';
export const TOKEN_SIZE_OPTIONS: TokenSize[] = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'];

/** Measure an element's rendered pixel box, tracking resizes — used for square grid cells + the ruler. */
function useElementSize<T extends HTMLElement>(ref: RefObject<T | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Round to `digits` decimals (calibration writes stay tidy, not 12-decimal float noise). */
function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Clamp a grid cell dimension (percent of map width) to the schema's [1, 100] range. */
function clampGridPercent(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(100, value));
}

type MapTool = 'move' | 'token-select' | 'measure' | 'reveal' | 'erase' | 'select' | 'ping' | 'calibrate';

/** One draggable calibration anchor (issue #417). Origin sets the grid offset; cell sets cell w/h. */
type CalibrateAnchor = 'origin' | 'cell';

// Issue #1917 stage 3: hoisted from a type local to `BattleMap` so the module-scope
// `MapTokenSlot` / `DragDistanceOverlay` components below can reference it too.
type MapPoint = { x: number; y: number };

/**
 * Ping intents (issue #1937) — a fixed, small set (not an extensible taxonomy), matching
 * the icons already used elsewhere in the app for the same concepts: `eyeball`
 * (EntitySecrecyControls), `hazard-sign` (StuckLadder), `position-marker`
 * (LocationStatusLabel / SessionLog).
 */
const PING_INTENTS = [
  { key: 'look', icon: 'eyeball' },
  { key: 'danger', icon: 'hazard-sign' },
  { key: 'move', icon: 'position-marker' },
] as const;
type PingIntentKey = (typeof PING_INTENTS)[number]['key'];

// Creature token footprints live in ./tokenFootprint; AoE template geometry lives here.
const BASE_AOE_LENGTH_MULT = 3; // default cone/line length = 3 cells; circle radius = 2 cells.

// Issue #1911: a pause this long after the last arrow-key nudge ends a keyboard-drag "burst" and
// commits its accumulated distance as one `moveFt` delta, mirroring a pointer drag's single
// commit-on-drop rather than one POST per keypress.
const KEYBOARD_DRAG_BURST_MS = 900;

/** Stable-ish short id for a new AoE template (crypto.randomUUID when available). */
function newAoeId(): string {
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return uuid.slice(0, 40);
}

/**
 * Pixel-space SVG `points` for one AoE template (issue #238). Circle callers use radius instead;
 * this builds the cone (5e quadrant-style triangle, far edge ≈ length) and line (a rectangle of
 * one grid-cell width) polygons. `ox/oy` is the origin in px, `lengthPx` the reach, `angleRad`
 * the aim, `widthPx` the line thickness.
 */
function aoePolygonPoints(
  shape: AoeShape,
  ox: number,
  oy: number,
  lengthPx: number,
  angleRad: number,
  widthPx: number,
): string {
  const dx = Math.cos(angleRad);
  const dy = Math.sin(angleRad);
  const px = -dy; // unit perpendicular
  const py = dx;
  if (shape === 'cone') {
    const fx = ox + dx * lengthPx;
    const fy = oy + dy * lengthPx;
    const half = lengthPx / 2;
    const a = [fx + px * half, fy + py * half];
    const b = [fx - px * half, fy - py * half];
    return `${ox.toFixed(1)},${oy.toFixed(1)} ${a[0].toFixed(1)},${a[1].toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)}`;
  }
  // line: a rectangle of width widthPx running from the origin along the aim
  const half = widthPx / 2;
  const fx = ox + dx * lengthPx;
  const fy = oy + dy * lengthPx;
  const p1 = [ox + px * half, oy + py * half];
  const p2 = [fx + px * half, fy + py * half];
  const p3 = [fx - px * half, fy - py * half];
  const p4 = [ox - px * half, oy - py * half];
  return [p1, p2, p3, p4].map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

/**
 * Battle map (issue #39 + VTT phases 2–3, issue #40): a DM-uploaded image rendered as the
 * encounter background with combatant tokens overlaid at combatant.tokenX/tokenY (0–100
 * percent). On top of the #39 token drag it adds:
 *  - a configurable square grid overlay (DM sets cell size / scale / unit / snap),
 *  - a click-drag measurement ruler that reads out distance in grid cells + scale units,
 *  - per-token size footprints (tiny→gargantuan) via combatant.tokenSize,
 *  - a square OR hex grid overlay (issue #238, gridType),
 *  - fog of war: the DM reveals rectangular regions; players see only revealed area, and
 *    the server additionally withholds token positions in the dark (redaction-safe),
 *  - shared circle/cone/line AoE templates (issue #238) persisted on the encounter so every
 *    client sees the same shapes (the old circle was client-local),
 *  - transient tap-to-ping markers broadcast to the whole table over SSE (issue #238 / #809).
 * Grid config, fog, and AoE are DM-only PATCHes to the encounter; every change rides the existing
 * SSE `encounter.updated` signal so other clients update live (the poll is the backstop). Pings
 * ride a dedicated one-shot `encounter.ping` signal and publish only after a completed tap
 * (matching pointer-up inside slop + time), never on touch-down. DM may move any token; a player
 * only their own character's (canMoveToken), but any member may ping.
 */
export type EncounterGridPatch = Partial<
  Pick<
    EncounterWithCombatants,
    | 'gridSize'
    | 'gridScale'
    | 'gridUnit'
    | 'gridSnap'
    | 'gridType'
    | 'hexOrientation'
    | 'gridOffsetX'
    | 'gridOffsetY'
    | 'gridCellHeight'
    | 'gridRotation'
    | 'gridOpacity'
  >
>;

/**
 * Rail glyphs for the cockpit layout (encounter-vtt design import). The template
 * draws each tool as a glyph over its label; the horizontal card toolbar stays
 * text-only, so the glyph is decorative (`aria-hidden`) and the button's
 * accessible name is the label either way.
 */
const TOOL_GLYPH: Record<MapTool, string> = {
  move: '✥',
  'token-select': '⬚',
  measure: '⟺',
  ping: '◎',
  reveal: '☀',
  erase: '☁',
  select: '▭',
  calibrate: '⊹',
};

export type BattleMapProps = {
  encounter: EncounterWithCombatants;
  campaignId: number;
  isDm: boolean;
  viewerUserId: string | null;
  canDmWrite: boolean;
  busy: boolean;
  canMoveToken: (c: Combatant) => boolean;
  onSetMap: (attachmentId: number | null, alignment?: MapReplaceAlignment) => void;
  onMoveToken: (combatantId: number, x: number, y: number) => void;
  /** Issue #1911: the running encounter's current-actor combatant id, and their turn-workspace
   * movement max (`TurnWorkspaceRead.movement.maxFt`) — already redacted server-side to the DM
   * and that combatant's owner, so its mere presence is the client's whole secrecy gate for the
   * drag budget line. `null` when there is no running turn, or the viewer cannot see it. */
  currentTurnCombatantId?: number | null;
  currentTurnMovementMaxFt?: number | null;
  /** POST a `moveFt` turn-state delta for a completed token drag/keyboard-nudge burst on the
   * current actor (issue #1911); negative to undo. No-op default for the cast projection, where
   * dragging is already disabled via `canMoveToken`. */
  onMoveFt?: (combatantId: number, moveFt: number) => void;
  onBatchTokens?: (placements: Array<{ combatantId: number; x: number; y: number }>, mapAspect: number) => Promise<{ undoToken: string }>;
  onUndoTokenBatch?: (undoToken: string) => Promise<void>;
  onBeginTokenBatchUndo?: () => boolean;
  dismissTokenUndoNonce?: number;
  onUnplaceToken: (combatantId: number) => void;
  onSetTokenSize?: (combatantId: number, size: TokenSize) => void;
  onSetGrid: (patch: EncounterGridPatch) => void;
  onSetFog: (fog: FogState | null) => void;
  pendingFog?: FogState | null;
  onSetAoe: (aoe: AoeTemplate[]) => void;
  canDeclareAoe?: boolean;
  onDeclareAoe?: (template: Omit<AoeTemplate, 'declaredByUserId'>) => void;
  onUpdateAoe?: (templateId: string, patch: Partial<Omit<AoeTemplate, 'id' | 'declaredByUserId'>>) => void | Promise<void>;
  onRemoveAoe?: (templateId: string) => void;
  onClearPlayerAoe?: () => void;
  aoeDeclarerNames?: ReadonlyMap<string, string>;
  onGenerateMap?: (params: GenerateMapParams) => Promise<void>;
  onImportMap?: (attachmentId: number) => void;
  showGuidance?: boolean;
  onDismissGuidance?: () => void;
  /** `label` is set only for an intent chosen from the long-press/right-click menu (issue #1937). */
  onPing: (x: number, y: number, label?: string | null) => void;
  pings: ReadonlyArray<{ key: number; x: number; y: number; senderName: string | null; color: string | null; label: string | null }>;
  onDismissPing: (key: number) => void;
  onError: (message: string) => void;
  onAoeHitLayoutChange?: (layout: AoeHitLayout | null) => void;
  projection?: 'session' | 'cast';
  castToken?: string | null;
  hpFeedbackByCombatant?: ReadonlyMap<number, readonly (HpFeedbackEvent & { id: number })[]>;
  ruleSystem: string | null;
  customMechanicsProfile?: CustomMechanicsProfile | null;
  targeting?: { actorId: number; legalIds: readonly number[]; selectedIds: readonly number[]; declared: boolean; atCapacity: boolean; onToggle: (id: number) => void } | null;
  impactTargetIds?: readonly number[];
  /**
   * Color-vision-assist mode (issue #1942): adds a non-color identity shape badge
   * and a current-turn chevron to the map token, alongside their color-only
   * counterparts (fill color, accent ring).
   */
  colorVisionAssist?: boolean;
  /**
   * Chrome variant. `card` is the historical stacked-card map. `vtt` is the
   * cockpit layout from the `encounter-vtt` design template: the map surface
   * fills its container, the interaction tools become the vertical rail along
   * the left edge, and the remaining chrome (viewport controls, grid & fog
   * panel, token editor, load status) floats over the canvas. Only layout
   * changes — every permission, secrecy and gating decision below is shared.
   */
  layout?: 'card' | 'vtt';
};

// Issue #1917 stage 3: `dragPos` used to be `BattleMap`'s own `useState`, set on every
// `pointermove` of a token drag. Since a component's OWN state update re-runs its OWN render
// function regardless of `memo()` (memo only guards re-renders triggered by a parent), that
// re-ran BattleMap's entire ~4,000-line render body once per pointer-move frame — recomputing
// and reconciling every token, AoE shape, and fog rect on the map, not just the dragged token.
// (`GridOverlay`'s own memo boundary, stage 2, already stopped ITS render function from being
// re-invoked when BattleMap re-rendered — but BattleMap re-rendering at all, every frame, was
// never contained.)
//
// This tiny external store (subscribe/getSnapshot, the shape `useSyncExternalStore` expects)
// replaces that `useState`. BattleMap writes to it via `.set()` without ever reading from it in
// its own render, so a drag frame no longer touches BattleMap's render function at all. Only
// `MapTokenSlot` (for the dragged token) and `DragDistanceOverlay` (the live distance readout)
// call `useSyncExternalStore` on it, so a drag frame re-renders exactly those two components —
// `useSyncExternalStore`'s `Object.is` check on `getSnapshot()`'s result additionally means a
// non-dragged `MapTokenSlot` (whose selector always returns the same `null`) never re-renders.
type DragPositionState = { combatantId: number; x: number; y: number } | null;

interface DragPositionStore {
  getSnapshot: () => DragPositionState;
  subscribe: (listener: () => void) => () => void;
  set: (next: DragPositionState) => void;
}

function createDragPositionStore(): DragPositionStore {
  let state: DragPositionState = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      state = next;
      listeners.forEach((listener) => listener());
    },
  };
}

/**
 * Positions one token disc (issue #1917 stage 3). The token's visual content — badges, HP arc,
 * condition controls, the "Remove" button — is unchanged and still computed by `BattleMap`'s own
 * render, passed through unmodified as `children`; only `left`/`top`/`opacity`/`zIndex` are owned
 * here, sourced from `dragPosStore` while this is the dragged token. React bails out of
 * reconciling `children` whenever this wrapper re-renders on its own (the `children` element
 * reference is unchanged from BattleMap's last real render), so a drag frame's DOM work is just
 * this one wrapper's four style properties.
 */
function MapTokenSlot({
  combatantId,
  isDragging,
  restLeft,
  restTop,
  restOpacity,
  dragPosStore,
  role,
  tabIndex,
  ariaLabel,
  ariaPressed,
  ariaDisabled,
  ariaDescribedby,
  ariaKeyshortcuts,
  dataTestId,
  className,
  pointerEvents,
  cursor,
  outline,
  onPointerDown,
  onClick,
  onKeyDown,
  onFocus,
  children,
}: {
  combatantId: number;
  isDragging: boolean;
  restLeft: number;
  restTop: number;
  restOpacity: number;
  dragPosStore: DragPositionStore;
  role?: string;
  tabIndex: number;
  ariaLabel: string;
  ariaPressed?: boolean;
  ariaDisabled?: true;
  ariaDescribedby: string;
  ariaKeyshortcuts?: string;
  dataTestId: string;
  className: string;
  pointerEvents: 'auto' | 'none';
  cursor: string;
  outline?: string;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  onFocus: (e: ReactFocusEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const live = useSyncExternalStore(
    dragPosStore.subscribe,
    () => (isDragging ? dragPosStore.getSnapshot() : null),
  );
  const dragging = isDragging && live != null && live.combatantId === combatantId;
  const left = dragging ? live!.x : restLeft;
  const top = dragging ? live!.y : restTop;
  return (
    <div
      data-testid={dataTestId}
      role={role}
      tabIndex={tabIndex}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      aria-disabled={ariaDisabled}
      aria-describedby={ariaDescribedby}
      aria-keyshortcuts={ariaKeyshortcuts}
      className={className}
      style={{
        left: `${left}%`,
        top: `${top}%`,
        pointerEvents,
        touchAction: 'none',
        cursor,
        opacity: dragging ? 0.85 : restOpacity,
        outline,
        zIndex: dragging ? 10 : 2,
      }}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      {children}
    </div>
  );
}

/**
 * Live token-drag / keyboard-nudge distance readout (issue #1911), lifted out of BattleMap's own
 * render (issue #1917 stage 3) into its own `useSyncExternalStore` subscriber so a pointer-move
 * frame re-renders only this overlay, never BattleMap. Keyboard-nudge bursts are unaffected —
 * `keyboardDrag` stays an ordinary (much lower frequency) prop.
 */
function DragDistanceOverlay({
  dragPosStore,
  draggingId,
  keyboardDrag,
  combatants,
  canMeasure,
  mapRect,
  cellPx,
  gridType,
  calibration,
  hexOrientation,
  gridDistanceRule,
  gridScale,
  gridUnit,
  currentTurnMovementMaxFt,
  encounterStatus,
  currentTurnCombatantId,
}: {
  dragPosStore: DragPositionStore;
  draggingId: number | null;
  keyboardDrag: { combatantId: number; origin: MapPoint; current: MapPoint } | null;
  combatants: readonly Combatant[];
  canMeasure: boolean;
  mapRect: Rect | null;
  cellPx: number;
  gridType: GridType;
  calibration: GridCalibration | null;
  hexOrientation: HexOrientation;
  gridDistanceRule: GridDistanceRule;
  gridScale: number | null | undefined;
  gridUnit: string;
  currentTurnMovementMaxFt: number | null | undefined;
  encounterStatus: string;
  currentTurnCombatantId: number | null | undefined;
}) {
  const live = useSyncExternalStore(dragPosStore.subscribe, dragPosStore.getSnapshot);
  const { t } = useTranslation();
  if (!canMeasure || !mapRect) return null;

  let combatantId: number | null = null;
  let origin: MapPoint | null = null;
  let current: MapPoint | null = null;
  if (draggingId != null && live != null && live.combatantId === draggingId) {
    const dragged = combatants.find((c) => c.id === draggingId);
    if (dragged) {
      combatantId = dragged.id;
      origin = { x: dragged.tokenX ?? 0, y: dragged.tokenY ?? 0 };
      current = { x: live.x, y: live.y };
    }
  } else if (keyboardDrag) {
    combatantId = keyboardDrag.combatantId;
    origin = keyboardDrag.origin;
    current = keyboardDrag.current;
  }
  if (combatantId == null || !origin || !current) return null;

  const cells = mapPercentGridDistance(origin, current, mapRect, cellPx, gridType, calibration, hexOrientation, gridDistanceRule);
  let budget: DragBudget | null = null;
  if (currentTurnMovementMaxFt != null && isCurrentActorDrag(encounterStatus, currentTurnCombatantId, combatantId)) {
    const draggedCombatant = combatants.find((c) => c.id === combatantId);
    if (draggedCombatant) {
      budget = dragBudget(draggedCombatant.turnState.movementUsedFt, rulerDistanceFeet(cells, gridScale ?? 0), currentTurnMovementMaxFt);
    }
  }

  return (
    <>
      <svg className="absolute inset-0 w-full h-full" style={{ zIndex: 7 }}>
        <line
          data-testid="map-drag-distance-line"
          x1={`${origin.x}%`}
          y1={`${origin.y}%`}
          x2={`${current.x}%`}
          y2={`${current.y}%`}
          stroke="var(--color-accent)"
          strokeWidth={1.5}
          strokeDasharray="3 4"
          opacity={0.65}
        />
      </svg>
      <div
        data-testid="map-drag-distance-readout"
        className="absolute"
        style={{
          left: `${current.x}%`,
          top: `${current.y}%`,
          transform: 'translate(10px, -100%)',
          background: budget?.overBudget ? 'var(--color-warning, #d97706)' : 'rgba(15,23,42,.9)',
          color: '#fff',
          fontSize: 11,
          fontWeight: 600,
          padding: '2px 6px',
          borderRadius: 4,
          whiteSpace: 'nowrap',
          zIndex: 9,
        }}
      >
        <div>
          {formatRulerReadout({ cells, scale: gridScale ?? 0, gridUnit, gridType }, 'display')}
        </div>
        {budget && (
          <div data-testid="map-drag-distance-budget">
            {t('encounters.map.dragDistance.budget', { used: budget.usedFt, max: budget.maxFt, unit: gridUnit })}
            {budget.overBudget ? ` · ${t('encounters.map.dragDistance.overSpeed')}` : ''}
          </div>
        )}
      </div>
    </>
  );
}

export const BattleMap = memo(function BattleMap({
  encounter,
  campaignId,
  isDm,
  viewerUserId,
  canDmWrite,
  busy,
  canMoveToken,
  onSetMap,
  onMoveToken,
  currentTurnCombatantId = null,
  currentTurnMovementMaxFt = null,
  onMoveFt = () => undefined,
  onBatchTokens,
  onUndoTokenBatch,
  dismissTokenUndoNonce,
  onBeginTokenBatchUndo,
  onUnplaceToken,
  onSetTokenSize,
  onSetGrid,
  onSetFog,
  pendingFog,
  onSetAoe,
  canDeclareAoe = false,
  onDeclareAoe = () => undefined,
  onUpdateAoe = () => undefined,
  onRemoveAoe = () => undefined,
  onClearPlayerAoe,
  aoeDeclarerNames = new Map(),
  onGenerateMap,
  onImportMap,
  showGuidance,
  onDismissGuidance,
  onPing,
  pings,
  onDismissPing,
  onError,
  onAoeHitLayoutChange,
  projection = 'session',
  castToken = null,
  hpFeedbackByCombatant = new Map(),
  ruleSystem,
  customMechanicsProfile,
  targeting = null,
  impactTargetIds = [],
  colorVisionAssist = false,
  layout = 'card',
}: BattleMapProps) {
  const isCast = projection === 'cast';
  /** Cast projection keeps its own bare full-bleed chrome; the rail is session-only. */
  const isVtt = layout === 'vtt' && !isCast;
  const effectiveIsDm = isCast ? false : isDm;
  const effectiveCanDmWrite = isCast ? false : canDmWrite;
  const effectiveCanDeclareAoe = isCast ? false : canDeclareAoe;
  const effectiveCanMoveToken = isCast ? () => false : canMoveToken;
  const { t } = useTranslation();
  const announce = useAnnounce();
  const pingIntentLabel = useCallback((key: PingIntentKey) => t(`encounters.map.ping.intents.${key}`), [t]);
  // A received ping's `label` is plain text — the schema deliberately carries no separate
  // intent slug (issue #1937 keeps the wire shape to color+label only) — so an incoming
  // label is matched against THIS viewer's own translated intent strings to find its icon.
  // A ping labeled in a different locale than the viewer's still renders (plain text, no
  // icon) rather than breaking; it just doesn't match any of the three known intents.
  const pingIntentIconForLabel = useCallback(
    (label: string | null): string | null => {
      if (!label) return null;
      return PING_INTENTS.find((intent) => pingIntentLabel(intent.key) === label)?.icon ?? null;
    },
    [pingIntentLabel],
  );
  const [dmTokenDetailMode, setDmTokenDetailMode] = useState<TokenDetailMode>(() =>
    readTokenDetailMode(typeof localStorage === 'undefined' ? null : localStorage),
  );
  const tokenDetailMode: TokenDetailMode = effectiveIsDm ? dmTokenDetailMode : 'full';
  const reducedMotion = prefersReducedMotion();
  const setTokenDetailMode = (mode: TokenDetailMode) => {
    setDmTokenDetailMode(mode);
    writeTokenDetailMode(mode, typeof localStorage === 'undefined' ? null : localStorage);
  };
  type ActiveMapGesture =
    | { kind: 'token'; pointerId: number; captureTarget: Element; tokenId: number; point: MapPoint | null; start: MapPoint; clientX: number; clientY: number; moved: boolean; targetable: boolean }
    | { kind: 'token-select'; pointerId: number; captureTarget: Element; start: MapPoint; end: MapPoint; additive: boolean }
    | { kind: 'token-lasso'; pointerId: number; captureTarget: Element; points: MapPoint[]; additive: boolean }
    | { kind: 'aoe'; pointerId: number; captureTarget: Element; templateId: string; point: MapPoint }
    | { kind: 'fog'; mode: 'reveal' | 'erase'; pointerId: number; captureTarget: Element; start: MapPoint; end: MapPoint }
    | { kind: 'fog-region'; pointerId: number; captureTarget: Element; regionId: string; start: MapPoint; last: MapPoint }
    | { kind: 'measure'; pointerId: number; captureTarget: Element; start: MapPoint; end: MapPoint }
    | { kind: 'calibrate'; pointerId: number; captureTarget: Element; anchor: CalibrateAnchor; point: MapPoint }
    | { kind: 'ping'; pointerId: number; captureTarget: Element; arm: MapPingTapArm }
    | { kind: 'viewport-pan'; pointerId: number; captureTarget: Element; lastX: number; lastY: number };

  const [uploading, setUploading] = useState(false);
  const [mapDialog, setMapDialog] = useState<{
    mode: 'replace' | 'remove';
    previewUrl: string | null;
    pendingFile?: File;
    defaultAlignment: MapReplaceAlignment;
  } | null>(null);

  // Revoke the blob preview URL when the dialog closes or the component unmounts,
  // so navigating away while the dialog is open does not leak the staged image.
  useEffect(() => {
    const previewUrl = mapDialog?.previewUrl;
    if (previewUrl?.startsWith('blob:')) {
      return () => URL.revokeObjectURL(previewUrl);
    }
  }, [mapDialog?.previewUrl]);

  const [draggingId, setDraggingId] = useState<number | null>(null);
  // Issue #1917 stage 3: `dragPos` itself lives outside React state now — see
  // `createDragPositionStore` above. `draggingId` stays ordinary state; it only changes twice per
  // drag (start/end), so it never re-renders BattleMap at pointer-move frequency.
  const dragPosStoreRef = useRef(createDragPositionStore());
  const dragPosStore = dragPosStoreRef.current;
  // Issue #1911: a keyboard-nudge "burst" — arrow-key repeats on a focused token — tracked the
  // same way a pointer drag tracks `dragPos`, so the live distance readout renders for both. The
  // ref is the source of truth read by the burst-end timeout (a closure over state can be stale
  // by the time the timeout fires); the state copy exists only to re-render the overlay.
  const [keyboardDrag, setKeyboardDrag] = useState<{ combatantId: number; origin: MapPoint; current: MapPoint } | null>(null);
  const keyboardDragRef = useRef<{ combatantId: number; origin: MapPoint; current: MapPoint } | null>(null);
  const keyboardDragTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (keyboardDragTimeoutRef.current) clearTimeout(keyboardDragTimeoutRef.current);
  }, []);
  // Issue #1911: the inline "undo this move" chip after a drag/nudge posts a `moveFt` delta —
  // reuses the same UndoSnackbar the DM's token-batch undo does, one pending move at a time.
  const [dragMoveUndo, setDragMoveUndo] = useState<{ combatantId: number; origin: MapPoint; moveFt: number } | null>(null);
  const [tool, setTool] = useState<MapTool>('move');
  // Issue #1937: long-press (past the tap window) or right-click, with Ping armed, opens a
  // small Look/Danger/Move-here intent menu at the point instead of publishing a plain ping.
  // `pingHoldTimeoutRef` is armed alongside the ordinary tap gesture below and cleared by
  // every path that ends that gesture before it fires (release, slop-cancel, or any other
  // `cancelActiveGesture` — see there), so a completed plain tap never also opens the menu.
  const [pingIntentMenu, setPingIntentMenu] = useState<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const pingHoldTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPingHoldTimer = useCallback(() => {
    if (pingHoldTimeoutRef.current != null) {
      clearTimeout(pingHoldTimeoutRef.current);
      pingHoldTimeoutRef.current = null;
    }
  }, []);
  useEffect(() => () => clearPingHoldTimer(), [clearPingHoldTimer]);
  const [ruler, setRuler] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
  const [revealCorners, setRevealCorners] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
  const [selectedFogRegionId, setSelectedFogRegionId] = useState<string | null>(null);
  const [fogRegionDrag, setFogRegionDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const fogUndoStackRef = useRef(new FogUndoStack());
  const lastLocalFogRef = useRef<FogState | null>(encounter.fog);
  const [fogUndoUi, setFogUndoUi] = useState({ canUndo: false, canRedo: false });

  const syncFogUndoUi = useCallback(() => {
    setFogUndoUi({
      canUndo: fogUndoStackRef.current.canUndo(),
      canRedo: fogUndoStackRef.current.canRedo(),
    });
  }, []);
  const gridDisclosure = useDisclosure({
    focusManagement: false,
    regionLabel: 'Grid and fog settings',
  });
  const gridPanelOpen = gridDisclosure.open;
  /**
   * In the cockpit, map setup and token selection are rail tools that open on demand —
   * the same disclosure contract as Grid & fog above.
   *
   * They used to be permanent floating panels: "Token detail / Replace map / Remove map"
   * camped on the map's top-left and the multi-selection helpers on its top-right, so a
   * board the whole screen exists to show was covered by controls nobody was using at
   * that moment. Only the cockpit is affected; in the card layout these sit in normal
   * flow below the board and cover nothing, so they stay visible there.
   */
  const mapSetupDisclosure = useDisclosure({
    focusManagement: false,
    regionLabel: 'Map setup',
  });
  const selectionDisclosure = useDisclosure({
    focusManagement: false,
    regionLabel: 'Manage tokens',
  });
  // Shared AoE templates (issue #238) live in encounter state; `selectedAoeId` is the DM's local
  // editing selection and `aoeDrag` a live drag override (committed to the encounter on release).
  const [selectedAoeId, setSelectedAoeId] = useState<string | null>(null);
  const [aoeDrag, setAoeDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [aoeDraft, setAoeDraft] = useState<{ id: string; x: string; y: string; sizeFt: string; angleDeg: string } | null>(null);
  const [editingAoeDraft, setEditingAoeDraft] = useState(false);
  const pendingAoeDraftRef = useRef<string | null>(null);
  // Keyboard-accessible token selection and numeric editing state (issue #419).
  const [selectedTokenId, setSelectedTokenId] = useState<number | null>(null);
  // This is intentionally a Set rather than a colour-only visual state: the adjacent
  // named checkbox list remains the complete keyboard/touch alternative.
  const [selectedTokenIds, setSelectedTokenIds] = useState<Set<number>>(new Set());
  const [tokenSelectionRect, setTokenSelectionRect] = useState<{ start: MapPoint; end: MapPoint } | null>(null);
  const [tokenLasso, setTokenLasso] = useState<MapPoint[] | null>(null);
  const [tokenBatchUndo, setTokenBatchUndo] = useState<string | null>(null);
  const tokenUndoDismissNonceRef = useRef(dismissTokenUndoNonce);
  useEffect(() => {
    if (tokenUndoDismissNonceRef.current === dismissTokenUndoNonce) return;
    tokenUndoDismissNonceRef.current = dismissTokenUndoNonce;
    setTokenBatchUndo(null);
  }, [dismissTokenUndoNonce]);
  const beginTokenBatchUndo = useCallback((undoToken: string) => {
    if (onBeginTokenBatchUndo?.() === false) return;
    setTokenBatchUndo(undoToken);
  }, [onBeginTokenBatchUndo]);
  const [formationName, setFormationName] = useState('');
  const formationsQuery = useQuery({
    queryKey: ['token-formations', campaignId],
    queryFn: () => api.get<Array<{ id: number; name: string; layoutJson: string }>>(`${API}/campaigns/${campaignId}/encounters/token-formations`),
    enabled: effectiveIsDm,
  });
  const [tokenEdit, setTokenEdit] = useState<{ x: string; y: string } | null>(null);
  // Live calibration-anchor drag (issue #417): a local map-percent override for the anchor
  // being dragged, committed to the encounter (a grid PATCH) on release so the overlay,
  // snapping, and ruler preview in real time without a server round-trip per pointermove.
  const [calibrateDrag, setCalibrateDrag] = useState<{ anchor: CalibrateAnchor; x: number; y: number } | null>(null);
  // Natural pixel size of the loaded map image, used to compute its letterboxed
  // (object-contain) rendered rect so the grid overlay can be clipped to it (issue #273b).
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
  // Local viewport navigation (issue #712) — never synced to the server.
  const [viewport, setViewport] = useState<MapViewportState>(DEFAULT_MAP_VIEWPORT);
  const [viewportPan, setViewportPan] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const activeGestureRef = useRef<ActiveMapGesture | null>(null);
  const pinchRef = useRef<{ pointers: Map<number, { x: number; y: number }>; gesture: PinchGesture | null }>({
    pointers: new Map(),
    gesture: null,
  });
  const viewportRef = useRef(viewport);
  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);
  // A successful pointerup normally causes lostpointercapture immediately afterwards. Keep the
  // released id long enough to identify that expected notification; any earlier capture loss is
  // an interruption and must roll the gesture back without persisting it.
  const successfulPointerUpRef = useRef<number | null>(null);
  const targetGestureRef = useRef<{ tokenId: number; moved: boolean } | null>(null);
  const { w: surfaceW, h: surfaceH } = useElementSize(surfaceRef);

  const clearGesturePreview = useCallback((kind: ActiveMapGesture['kind']) => {
    if (kind === 'token') {
      setDraggingId(null);
      dragPosStore.set(null);
    } else if (kind === 'aoe') {
      setAoeDrag(null);
    } else if (kind === 'fog') {
      setRevealCorners(null);
    } else if (kind === 'fog-region') {
      setFogRegionDrag(null);
    } else if (kind === 'calibrate') {
      setCalibrateDrag(null);
    } else if (kind === 'ping') {
      // Armed ping has no live preview — publish is deferred until a completed tap.
    } else {
      setRuler(null);
    }
    if (kind === 'token-select') setTokenSelectionRect(null);
    if (kind === 'token-lasso') setTokenLasso(null);
    // `dragPosStore` is a ref's `.current` (see `dragPosStoreRef` above) — its identity never
    // changes across renders, so listing it here satisfies exhaustive-deps without changing
    // when this callback is recreated.
  }, [dragPosStore]);

  const cancelActiveGesture = useCallback(
    (pointerId?: number, clearPreview = true) => {
      const gesture = activeGestureRef.current;
      if (!gesture || (pointerId != null && gesture.pointerId !== pointerId)) return;

      // Clear ownership before releasing capture because releasePointerCapture may synchronously
      // dispatch lostpointercapture. That follow-up must observe an already-cancelled gesture.
      activeGestureRef.current = null;
      successfulPointerUpRef.current = null;
      // Issue #1937: this is the single choke point every non-release ping-ending path
      // (slop-cancel, pointercancel, lostpointercapture, tab-hidden, page-hide, rotation)
      // funnels through, so the pending long-press timer never survives past its gesture.
      if (gesture.kind === 'ping') clearPingHoldTimer();
      if (clearPreview) clearGesturePreview(gesture.kind);
      try {
        if (gesture.captureTarget.hasPointerCapture?.(gesture.pointerId)) {
          gesture.captureTarget.releasePointerCapture?.(gesture.pointerId);
        }
      } catch {
        // The browser may already have dropped capture while backgrounding or unmounting.
      }
    },
    [clearGesturePreview, clearPingHoldTimer],
  );

  useEffect(() => {
    const cancelWhenHidden = () => {
      if (document.visibilityState === 'hidden') cancelActiveGesture();
    };
    const cancelForPageExit = () => cancelActiveGesture();
    const cancelForRotation = () => cancelActiveGesture();
    const orientation = globalThis.screen?.orientation;

    document.addEventListener('visibilitychange', cancelWhenHidden);
    window.addEventListener('pagehide', cancelForPageExit);
    window.addEventListener('orientationchange', cancelForRotation);
    orientation?.addEventListener?.('change', cancelForRotation);
    return () => {
      document.removeEventListener('visibilitychange', cancelWhenHidden);
      window.removeEventListener('pagehide', cancelForPageExit);
      window.removeEventListener('orientationchange', cancelForRotation);
      orientation?.removeEventListener?.('change', cancelForRotation);
      // Component teardown already removes every preview from the DOM. Drop ownership and capture
      // without scheduling state updates; in particular, never turn unmount into a commit.
      cancelActiveGesture(undefined, false);
    };
  }, [cancelActiveGesture]);

  // The encounter-scoped route is the VTT secrecy boundary (issue #463): DMs receive
  // the source, while players receive a server-rendered image containing only revealed
  // pixels. mapAttachmentId is used only as the presence bit, never as a player image URL.
  // A cast display (issue #547) has no session of its own, so it must read pixels
  // through its capability rather than the cookie-authenticated encounter route.
  const mapImageUrl =
    encounter.mapAttachmentId == null
      ? null
      : castToken
        ? castEncounterMapUrl(castToken, encounter.id, encounter.updatedAt)
        : isCast
          ? playerDisplayEncounterMapUrl(campaignId, encounter.id, encounter.updatedAt)
          : encounterMapUrl(encounter.id, encounter.updatedAt);
  // Issue #604 — responsive battle map. The board used to load at full resolution on
  // every device; the derivative ladder lets the browser pick a rung that fits the
  // surface. Both the manifest and every srcset URL go through the ROLE-SAFE
  // /encounters/:id/map route, never an attachment route, so the #463 fog boundary is
  // untouched and players get responsive delivery too. `src` stays the full-size
  // role-safe URL, so the board still renders while rungs process or if they failed.
  //
  // BOTH are disabled on a cast display (#547) — see planEncounterMapResponsive, which
  // owns that rule as a single pure decision so the three things it gates (manifest
  // fetch, retry, srcset) can never drift apart. In short: those URLs authenticate from
  // the session COOKIE, so on a shared TV still holding the DM's cookie a srcset rung
  // would be served the UNFOGGED SOURCE map — reintroducing precisely the leak the cast
  // capability exists to close. A cast display keeps plain `src` through its capability
  // URL and simply forgoes responsive rungs.
  const mapResponsive = planEncounterMapResponsive({
    encounterId: encounter.id,
    mapAttachmentId: encounter.mapAttachmentId,
    castToken,
    isCastProjection: isCast,
    canDmWrite: effectiveCanDmWrite,
  });
  const mapDerivatives = useDerivativeManifest(mapResponsive.manifestUrl, mapResponsive.retryUrl);
  const mapSrcSet = mapResponsive.responsive
    ? encounterMapSrcSet(encounter.id, encounter.updatedAt, mapDerivatives.manifest)
    : undefined;
  // Issue #418: fog-redacted tokens keep null coords but set tokenHiddenByFog — do not
  // treat them as Unplaced (that offered a no-op place-at-center for the owner).
  const { placed, unplaced, hiddenByFog } = partitionMapTokens(encounter.combatants);

  const gridSize = encounter.gridSize; // cell edge as % of map width; null = no grid
  const gridScale = encounter.gridScale;
  const gridUnit = encounter.gridUnit || 'ft';
  const gridType: GridType = encounter.gridType ?? 'square';
  const hexOrientation = encounter.hexOrientation ?? 'pointy';
  const gridDistanceRule = useMemo(
    () => gridDistanceForAdapter(ruleSystemAdapter(ruleSystem, customMechanicsProfile)),
    [ruleSystem, customMechanicsProfile],
  );
  const gridOn = gridSize != null && gridSize > 0;

  // A new map starts with unknown natural size until its <img> fires onLoad.
  useEffect(() => {
    setImgNatural(null);
    setViewport(DEFAULT_MAP_VIEWPORT);
    setViewportPan(false);
    pinchRef.current.pointers.clear();
    pinchRef.current.gesture = null;
  }, [mapImageUrl]);

  const surfaceSize = useMemo(() => ({ w: surfaceW, h: surfaceH }), [surfaceW, surfaceH]);

  // Wheel / trackpad zoom toward the cursor (passive: false so we can prevent page scroll).
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el || !mapImageUrl) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) return;
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      setViewport((v) => applyWheelZoom(v, e.deltaY, localX, localY, { w: rect.width, h: rect.height }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [mapImageUrl]);

  // Re-clamp pan when the surface resizes (narrow/wide breakpoints).
  useEffect(() => {
    if (!(surfaceW > 0) || !(surfaceH > 0)) return;
    setViewport((v) => clampPan(v, surfaceSize));
  }, [surfaceW, surfaceH, surfaceSize]);

  // Rendered rect of the map image inside the 16:9 surface (issue #464 / #273b).
  // object-contain letterboxes non-16:9 images; every tool shares this transform.
  const mapRect = useMemo(
    () => computeContainedRect({ w: surfaceW, h: surfaceH }, imgNatural),
    [surfaceW, surfaceH, imgNatural],
  );
  // Percent coordinates use independent map-width/map-height axes. This actual
  // rendered height/width ratio is persisted with every batch preview so server
  // preview, apply, and undo validate the same physical footprint geometry.
  const tokenPlanningAspect = mapRect && mapRect.width > 0 ? mapRect.height / mapRect.width : 1;
  // When a map is attached but still loading, the fallback surface aspect is wrong for
  // non-square maps. Disable batch placement until the intrinsic image size is known.
  const tokenPlanningReady = encounter.mapAttachmentId == null || imgNatural != null;

  // Grid calibration (issue #417): resolve the persisted grid fields into ONE normalized
  // transform, then apply the live anchor-drag override so the overlay/snap/ruler preview
  // as the DM drags. Every consumer below reads geometry through this (and its px form),
  // and — because it derives purely from encounter state — every viewport renders it the same.
  // Keyed on the SIX grid fields `resolveGridCalibration` actually reads, not on `encounter`
  // (issue #1917 stage 2, review round 2). React Query hands back a new encounter object on
  // every refetch, SSE-driven invalidation and optimistic `setQueryData`, so an `[encounter]`
  // dependency recomputed this on every HP tick — and since `calibration` → `calibrationPx` →
  // `hexCells` all chain off it, two of `GridOverlay`'s props were reference-different every
  // time. Its `memo()` comparator is shallow, so it re-rendered exactly as it had before being
  // extracted: the containment this stage exists to deliver was not happening at all. These
  // six are primitives, so the memo now holds while the grid geometry itself is unchanged.
  const calGridSize = encounter.gridSize;
  const calGridCellHeight = encounter.gridCellHeight;
  const calGridOffsetX = encounter.gridOffsetX;
  const calGridOffsetY = encounter.gridOffsetY;
  const calGridRotation = encounter.gridRotation;
  const calGridOpacity = encounter.gridOpacity;
  const baseCalibration = useMemo(
    () =>
      resolveGridCalibration({
        gridSize: calGridSize,
        gridCellHeight: calGridCellHeight,
        gridOffsetX: calGridOffsetX,
        gridOffsetY: calGridOffsetY,
        gridRotation: calGridRotation,
        gridOpacity: calGridOpacity,
      }),
    [calGridSize, calGridCellHeight, calGridOffsetX, calGridOffsetY, calGridRotation, calGridOpacity],
  );
  const calibration = useMemo<GridCalibration | null>(() => {
    if (!baseCalibration || !calibrateDrag || !mapRect) return baseCalibration;
    const w = mapRect.width;
    const originXpx = (baseCalibration.offsetX / 100) * w;
    const originYpx = (baseCalibration.offsetY / 100) * w;
    const dragPx = mapPercentToLayerPx({ x: calibrateDrag.x, y: calibrateDrag.y }, mapRect);
    if (calibrateDrag.anchor === 'origin') {
      return { ...baseCalibration, offsetX: (dragPx.x / w) * 100, offsetY: (dragPx.y / w) * 100 };
    }
    // Cell anchor: inverse-rotate the drag vector into the grid frame so cell w/h stay
    // correct even when the grid is rotated. Guard a minimum so a collapsed cell can't stick.
    const rad = (baseCalibration.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = dragPx.x - originXpx;
    const dy = dragPx.y - originYpx;
    const gw = dx * cos + dy * sin;
    const gh = -dx * sin + dy * cos;
    return {
      ...baseCalibration,
      cellW: Math.max(1, (gw / w) * 100),
      cellH: Math.max(1, (gh / w) * 100),
    };
  }, [baseCalibration, calibrateDrag, mapRect]);

  const calibrationPx = useMemo(
    () => (calibration && mapRect ? calibrationToPx(calibration, mapRect.width) : null),
    [calibration, mapRect],
  );
  // One cell in rendered pixels — derived from the calibrated cell WIDTH (#464/#417).
  const cellPx = calibrationPx?.cellWpx ?? 0;
  // Distance readout needs both a cell size (px) and a real-world scale.
  const canMeasure = gridOn && gridScale != null && gridScale > 0 && cellPx > 0;
  const canAoe = canMeasure; // AoE sizes are expressed in feet, so they need the scale too.
  const canCalibrate = gridOn && !!mapRect; // calibration acts on an enabled grid + loaded map

  const aoeHitLayout = useMemo(
    () => (mapRect && cellPx > 0 ? { mapRect, cellPx } : null),
    [mapRect, cellPx],
  );
  useEffect(() => {
    onAoeHitLayoutChange?.(aoeHitLayout);
    return () => onAoeHitLayoutChange?.(null);
  }, [aoeHitLayout, onAoeHitLayoutChange]);

  const aoeTemplates = useMemo(() => {
    const all = encounter.aoe ?? [];
    if (effectiveIsDm) return all;
    return filterAoeTemplatesForViewer(all, encounter.fog, { viewerUserId });
  }, [encounter.aoe, encounter.fog, effectiveIsDm, viewerUserId]);
  // Keep the optimistic fog as both the rendered and editable source until its PATCH
  // settles; a stale poll must not make the map appear to revert mid-gesture.
  const fog = pendingFog === undefined ? encounter.fog : pendingFog;
  const fogOn = !!fog?.enabled;

  const commitFogEdit = useCallback(
    (next: FogState | null) => {
      fogUndoStackRef.current.commit(lastLocalFogRef.current, next);
      lastLocalFogRef.current = next;
      onSetFog(next);
      syncFogUndoUi();
    },
    [onSetFog, syncFogUndoUi],
  );

  useEffect(() => {
    // The query cache is updated optimistically, but an older poll/SSE response can still
    // arrive before the PATCH settles. Keep the local edit and its active drag/undo state
    // authoritative during that interval; on settle the parent clears this marker and the
    // fresh server snapshot becomes the new baseline.
    const sync = reconcileFogSyncState({
      serverFog: encounter.fog,
      localFog: lastLocalFogRef.current,
      pendingFog,
    });
    if (!sync.resetLocalUi) {
      lastLocalFogRef.current = sync.fog;
      return;
    }
    lastLocalFogRef.current = sync.fog;
    fogUndoStackRef.current.reset();
    setSelectedFogRegionId(null);
    setFogRegionDrag(null);
    syncFogUndoUi();
  }, [encounter.fog, pendingFog, syncFogUndoUi]);

  const undoFogEdit = useCallback(() => {
    if (!fogUndoStackRef.current.canUndo()) return;
    const prev = fogUndoStackRef.current.undo(lastLocalFogRef.current);
    lastLocalFogRef.current = prev;
    onSetFog(prev);
    syncFogUndoUi();
    announce('Fog edit undone.');
  }, [announce, onSetFog, syncFogUndoUi]);

  const redoFogEdit = useCallback(() => {
    if (!fogUndoStackRef.current.canRedo()) return;
    const next = fogUndoStackRef.current.redo(lastLocalFogRef.current);
    lastLocalFogRef.current = next;
    onSetFog(next);
    syncFogUndoUi();
    announce('Fog edit redone.');
  }, [announce, onSetFog, syncFogUndoUi]);

  // A non-DM whose token sits outside revealed fog never receives its coordinates (issue #40).
  // Those combatants land in `hiddenByFog` via tokenHiddenByFog (issue #418), not Unplaced.

  function uploadMapFile(file: File) {
    setMapDialog({
      mode: 'replace',
      previewUrl: URL.createObjectURL(file),
      pendingFile: file,
      defaultAlignment: 'preserve',
    });
  }

  async function commitMapReplace(alignment: MapReplaceAlignment) {
    const file = mapDialog?.pendingFile;
    if (!file) return;
    setUploading(true);
    try {
      const attachment: Attachment = await uploadAttachment(campaignId, 'map', file);
      onSetMap(attachment.id, alignment);
    } catch (err) {
      onError(translateApiError(err, t, { fallbackKey: 'encounters.errors.uploadMap' }));
    } finally {
      setUploading(false);
    }
  }

  function openMapRemoveDialog() {
    setMapDialog({
      mode: 'remove',
      previewUrl: mapImageUrl,
      defaultAlignment: 'preserve',
    });
  }

  /**
   * Pointer → map-image percent (issue #464). Letterbox hits return null unless
   * `clamp` is set (in-progress drags stay pinned to the map edge). Inverse-applies
   * the local viewport transform first (issue #712).
   */
  function pointerToPercent(e: { clientX: number; clientY: number }, clamp = false): MapPoint | null {
    if (!mapRect) return null;
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    const content = surfaceToContentPoint(localX, localY, viewport);
    return pointerToMapPercent(rect.left + content.x, rect.top + content.y, rect, mapRect, { clamp });
  }

  function surfaceLocalFromEvent(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function trackPinchPointer(
    e: ReactPointerEvent<HTMLDivElement>,
    phase: 'down' | 'move' | 'up' | 'cancel',
  ): boolean {
    if (e.pointerType !== 'touch') return false;
    const track = pinchRef.current;
    if (phase === 'down') {
      track.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    } else if (phase === 'move') {
      if (!track.pointers.has(e.pointerId)) return false;
      track.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    } else {
      track.pointers.delete(e.pointerId);
      if (track.pointers.size < 2) track.gesture = null;
    }

    if (track.pointers.size < 2) return false;

    const pts = [...track.pointers.values()];
    const local = surfaceLocalFromEvent({ clientX: (pts[0].x + pts[1].x) / 2, clientY: (pts[0].y + pts[1].y) / 2 });
    if (!local || !(surfaceW > 0) || !(surfaceH > 0)) return true;
    const cx = local.x;
    const cy = local.y;
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (!track.gesture) {
      cancelActiveGesture();
      track.gesture = {
        startViewport: viewportRef.current,
        startDistance: dist,
        startCenterX: cx,
        startCenterY: cy,
      };
    }
    setViewport(applyPinch(track.gesture, cx, cy, dist, surfaceSize));
    return true;
  }

  function zoomViewportAt(factor: number, focalX: number, focalY: number) {
    setViewport((v) => zoomByFactor(v, factor, focalX, focalY, surfaceSize));
  }

  function onViewportKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    // Issue #2047: Shift+Enter/Space, checked before the plain-ping activation below,
    // opens the intent menu instead of sending an unlabeled ping — the keyboard-only
    // path to the same Look/Danger/Move-here menu long-press and right-click reach.
    if (tool === 'ping' && isMapPingIntentMenuKeyboardActivation(e)) {
      onPingIntentMenuKeyDown(e);
      return;
    }
    if (tool === 'ping' && isMapPingKeyboardActivation(e)) {
      onPingKeyDown(e);
      return;
    }
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomViewportAt(MAP_VIEWPORT_ZOOM_STEP, surfaceW / 2, surfaceH / 2);
      return;
    }
    if (e.key === '-') {
      e.preventDefault();
      zoomViewportAt(1 / MAP_VIEWPORT_ZOOM_STEP, surfaceW / 2, surfaceH / 2);
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      setViewport(resetViewport());
      return;
    }

    const arrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown';

    // Number keys switch tools when the surface is focused (no modifier chords).
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (e.key === '1') { changeTool('move'); return; }
      if (e.key === '2') { changeTool('measure'); return; }
      if (e.key === '3') { changeTool('ping'); return; }
      if (e.key === '4') { changeTool('reveal'); return; }
      if (e.key === '5') { changeTool('calibrate'); return; }
      if (e.key === '6') { changeTool('erase'); return; }
      if (e.key === '7') { changeTool('select'); return; }
    }

    if (canDmWrite && fogOn && (e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undoFogEdit();
      return;
    }
    if (canDmWrite && fogOn && (e.ctrlKey || e.metaKey) && (e.key === 'Z' || e.key === 'y')) {
      e.preventDefault();
      redoFogEdit();
      return;
    }

    if (tool === 'select' && selectedFogRegionId && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      commitFogEdit(deleteFogRegion(fog, selectedFogRegionId));
      setSelectedFogRegionId(null);
      announce('Fog region removed.');
      return;
    }

    // Keyboard measurement: Enter to start at the map center, arrows to aim, Enter to finish, Escape to clear.
    if (tool === 'measure') {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!ruler) {
          setRuler({ start: { x: 50, y: 50 }, end: { x: 50, y: 50 } });
          announce('Measurement started at map center. Arrow keys adjust the endpoint. Enter to finish, Escape to cancel.');
        } else if (ruler && canMeasure && mapRect) {
          const cells = mapPercentGridDistance(
            ruler.start,
            ruler.end,
            mapRect,
            cellPx,
            gridType,
            calibration,
            hexOrientation,
            gridDistanceRule,
          );
          announce(
            formatRulerReadout(
              { cells, scale: gridScale ?? 0, gridUnit, gridType },
              'announce',
            ),
          );
        }
        return;
      }
      if (ruler && arrow) {
        e.preventDefault();
        setRuler((prev) => prev && { ...prev, end: nudgeMapPoint(prev.end, e) });
        return;
      }
      if (ruler && e.key === 'Escape') {
        e.preventDefault();
        setRuler(null);
        return;
      }
    }

    // Keyboard fog reveal/erase: Enter to start a rectangle at the map center, arrows to resize, Enter to commit, Escape to cancel.
    if (tool === 'reveal' || tool === 'erase') {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!revealCorners) {
          setRevealCorners({ start: { x: 50, y: 50 }, end: { x: 50, y: 50 } });
          announce(
            tool === 'erase'
              ? 'Erase rectangle started at map center. Arrow keys to resize, Enter to erase, Escape to cancel.'
              : 'Reveal rectangle started at map center. Arrow keys to resize, Enter to reveal, Escape to cancel.',
          );
        } else {
          const rect = fogRectFromCorners(revealCorners.start, revealCorners.end);
          if (rect.w >= 1 && rect.h >= 1) {
            if (tool === 'erase') {
              commitFogEdit(eraseFogRegion(fog, rect));
              announce(`Erased ${Math.round(rect.w)} by ${Math.round(rect.h)} percent`);
            } else {
              commitFogReveal(revealCorners.start, revealCorners.end);
            }
          }
          setRevealCorners(null);
        }
        return;
      }
      if (revealCorners && arrow) {
        e.preventDefault();
        setRevealCorners((prev) => prev && { ...prev, end: nudgeMapPoint(prev.end, e) });
        return;
      }
      if (revealCorners && e.key === 'Escape') {
        e.preventDefault();
        setRevealCorners(null);
        return;
      }
    }

    if (viewport.scale > 1 && arrow) {
      e.preventDefault();
      const step = MAP_VIEWPORT_PAN_STEP_PX;
      const dx = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0;
      const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
      setViewport((v) => panBy(v, dx, dy, surfaceSize));
    }
  }

  /** Snap a drop point to the nearest calibrated cell centre when the grid + snap are on (issue #40/#417/#467). */
  function snapPoint(pt: MapPoint): MapPoint {
    if (!mapRect) return pt;
    if (gridOn && gridType === 'hex') {
      return snapMapPercentToHex(pt, calibration, mapRect, hexOrientation, encounter.gridSnap);
    }
    return snapMapPercentCalibrated(pt, calibration, mapRect, gridOn && encounter.gridSnap);
  }

  /**
   * Issue #1911: on a completed single-token drag drop or keyboard-nudge burst, declare the
   * straight-line distance as `moveFt` turn-state IF the dragged combatant is the current actor
   * of a running encounter — off-turn drags and DM repositioning of any other combatant show the
   * live readout (rendered separately) but write nothing, matching the acceptance criteria.
   * Gridless/uncalibrated maps (`canMeasure` false) have no distance to declare at all.
   */
  function commitDragMovement(combatantId: number, origin: MapPoint, current: MapPoint): void {
    if (!canMeasure || !mapRect) return;
    if (!isCurrentActorDrag(encounter.status, currentTurnCombatantId, combatantId)) return;
    const cells = mapPercentGridDistance(origin, current, mapRect, cellPx, gridType, calibration, hexOrientation, gridDistanceRule);
    const moveFt = dragMoveFt(cells, gridScale ?? 0);
    if (!(moveFt > 0)) return; // dropped back on the origin cell — nothing to declare or undo.
    onMoveFt(combatantId, moveFt);
    setDragMoveUndo({ combatantId, origin, moveFt });
  }

  /**
   * Issue #1911: accumulate an arrow-key nudge "burst" on a focused token — each keypress
   * extends the same in-progress move rather than declaring its own `moveFt` — then commit once
   * as a single delta after a pause, the same way a pointer drag commits once on drop.
   */
  function scheduleKeyboardDragCommit(combatantId: number, origin: MapPoint, current: MapPoint): void {
    const next = { combatantId, origin, current };
    keyboardDragRef.current = next;
    setKeyboardDrag(next);
    if (keyboardDragTimeoutRef.current) clearTimeout(keyboardDragTimeoutRef.current);
    keyboardDragTimeoutRef.current = setTimeout(() => {
      const final = keyboardDragRef.current;
      keyboardDragRef.current = null;
      setKeyboardDrag(null);
      if (final) commitDragMovement(final.combatantId, final.origin, final.current);
    }, KEYBOARD_DRAG_BURST_MS);
  }

  /** Commit a fog reveal rectangle, snapping corners to hex centres in hex grid mode (issue #467). */
  function commitFogReveal(start: MapPoint, end: MapPoint): void {
    let rect = fogRectFromCorners(start, end);
    if (rect.w >= 1 && rect.h >= 1) {
      if (gridOn && gridType === 'hex' && calibration && mapRect) {
        rect = snapFogRectToHexGrid(rect, calibration, mapRect, hexOrientation);
      }
      commitFogEdit(appendFogReveal(fog, rect));
      announce(`Revealed ${Math.round(rect.w)} by ${Math.round(rect.h)} percent`);
    }
  }

  /** Keyboard nudge step in layer pixels: one calibrated cell, or 1% of map width if the grid is off. */
  function keyboardStepPx(): { x: number; y: number } {
    if (calibrationPx) return { x: calibrationPx.cellWpx, y: calibrationPx.cellHpx };
    if (!mapRect) return { x: 0, y: 0 };
    return { x: mapRect.width * 0.01, y: mapRect.width * 0.01 };
  }

  /** Nudge a map-percent point by one grid cell (Shift = five) and snap to the nearest cell centre. */
  function nudgeMapPoint(pt: MapPoint, e: ReactKeyboardEvent): MapPoint {
    const mult = e.shiftKey ? 5 : 1;
    const baseRect = mapRect ?? { left: 0, top: 0, width: 1, height: 1 };
    const px = mapPercentToLayerPx(pt, baseRect);

    if (gridOn && gridType === 'hex' && calibrationPx && cellPx > 0) {
      const hexStep = hexKeyboardStepPx(e.key, cellPx, hexOrientation);
      if (hexStep) {
        const nextPx = { x: px.x + hexStep.x * mult, y: px.y + hexStep.y * mult };
        const raw = layerPxToMapPercent(nextPx, baseRect);
        if (!mapRect) return raw;
        return snapMapPercentToHex(raw, calibration, mapRect, hexOrientation, true);
      }
    }

    const step = keyboardStepPx();
    const nextPx = {
      x: px.x + (e.key === 'ArrowRight' ? step.x * mult : e.key === 'ArrowLeft' ? -step.x * mult : 0),
      y: px.y + (e.key === 'ArrowDown' ? step.y * mult : e.key === 'ArrowUp' ? -step.y * mult : 0),
    };
    const raw = layerPxToMapPercent(nextPx, baseRect);
    if (!mapRect) return raw;
    if (gridOn && gridType === 'hex') {
      return snapMapPercentToHex(raw, calibration, mapRect, hexOrientation, true);
    }
    return snapMapPercentCalibrated(raw, calibration, mapRect, gridOn);
  }

  function onTokenPointerDown(e: ReactPointerEvent<HTMLDivElement>, c: Combatant) {
    if (!e.isPrimary || activeGestureRef.current || tool !== 'move' || viewportPan || !mapImageUrl || !canMoveToken(c)) return;
    e.currentTarget.focus();
    setSelectedTokenId(c.id);
    // Modifier toggles exactly once on pointer-down. A plain drag of a selected
    // member retains the existing group; a plain press of another token selects it.
    setSelectedTokenIds(current => (e.metaKey || e.ctrlKey || e.shiftKey) ? toggleTokenSelection(current, c.id, true) : (current.has(c.id) ? current : new Set([c.id])));
    e.preventDefault();
    e.stopPropagation();
    // Token handles live on the map layer; clamp so a press on the token edge still binds.
    const point = pointerToPercent(e, true);
    if (!point) return;
    const captureTarget = e.currentTarget;
    const targetable = (targeting?.legalIds.includes(c.id) ?? false)
      && !targeting?.declared
      && ((targeting?.selectedIds.includes(c.id) ?? false) || !targeting?.atCapacity);
    if (targetable) targetGestureRef.current = null;
    captureTarget.setPointerCapture?.(e.pointerId);
    successfulPointerUpRef.current = null;
    activeGestureRef.current = { kind: 'token', pointerId: e.pointerId, captureTarget, tokenId: c.id, point, start: point, clientX: e.clientX, clientY: e.clientY, moved: false, targetable };
    setDraggingId(c.id);
    dragPosStore.set({ combatantId: c.id, x: point.x, y: point.y });
  }

  function onSurfacePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (trackPinchPointer(e, 'down')) return;
    // A palm / secondary contact cannot arm a ping, and if a ping is already armed it cancels
    // that gesture so the interrupted primary never publishes (issue #809).
    if (!e.isPrimary) {
      const armed = activeGestureRef.current;
      if (armed?.kind === 'ping') cancelActiveGesture(armed.pointerId);
      return;
    }
    if (activeGestureRef.current) return;
    const local = surfaceLocalFromEvent(e);
    if (viewportPan && local) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      successfulPointerUpRef.current = null;
      activeGestureRef.current = {
        kind: 'viewport-pan',
        pointerId: e.pointerId,
        captureTarget: e.currentTarget,
        lastX: local.x,
        lastY: local.y,
      };
      return;
    }
    // Letterbox bands are inert — do not start ping/measure/reveal/deselect there (#464).
    const pct = pointerToPercent(e);
    if (!pct) return;
    if (tool === 'ping') {
      // Issue #1937: the secondary (right) mouse button never arms a plain-tap ping — it
      // opens the intent menu instead, through the dedicated onContextMenu handler below.
      // (Belt-and-suspenders with onSurfaceContextMenu's own cancelActiveGesture() call —
      // this guard alone matters when a right button's own pointerup lands before any
      // contextmenu event ever reaches the surface, e.g. a suppressed native menu.)
      if (e.button === 2) return;
      // Arm on press; publish only from a matching completed tap (pointer-up inside slop/time).
      e.currentTarget.setPointerCapture?.(e.pointerId);
      successfulPointerUpRef.current = null;
      const arm = armMapPingTap({
        pointerId: e.pointerId,
        clientX: e.clientX,
        clientY: e.clientY,
        startedAt: performance.now(),
        x: pct.x,
        y: pct.y,
      });
      activeGestureRef.current = { kind: 'ping', pointerId: e.pointerId, captureTarget: e.currentTarget, arm };
      // Issue #1937: held past the tap window (which used to just cancel on release) opens
      // the Look/Danger/Move-here intent menu instead, at the armed point. A release before
      // this fires still takes the ordinary decideMapPingTapRelease path in onSurfacePointerUp
      // completely unchanged — this timer only ever fires for a hold that outlasts a tap.
      const pointerId = e.pointerId;
      clearPingHoldTimer();
      pingHoldTimeoutRef.current = setTimeout(() => {
        pingHoldTimeoutRef.current = null;
        const gesture = activeGestureRef.current;
        if (!gesture || gesture.kind !== 'ping' || gesture.pointerId !== pointerId) return;
        cancelActiveGesture(pointerId, false);
        setPingIntentMenu({ x: gesture.arm.x, y: gesture.arm.y, clientX: gesture.arm.clientX, clientY: gesture.arm.clientY });
      }, MAP_PING_TAP_MAX_MS + 1);
      return;
    }
    if (tool === 'token-select' && effectiveIsDm) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      successfulPointerUpRef.current = null;
      const additive = e.metaKey || e.ctrlKey || e.shiftKey;
      if (e.altKey) {
        activeGestureRef.current = { kind: 'token-lasso', pointerId: e.pointerId, captureTarget: e.currentTarget, points: [pct], additive };
        setTokenLasso([pct]);
      } else {
        activeGestureRef.current = { kind: 'token-select', pointerId: e.pointerId, captureTarget: e.currentTarget, start: pct, end: pct, additive };
        setTokenSelectionRect({ start: pct, end: pct });
      }
      return;
    }
    if (tool === 'measure' && canMeasure) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      successfulPointerUpRef.current = null;
      activeGestureRef.current = { kind: 'measure', pointerId: e.pointerId, captureTarget: e.currentTarget, start: pct, end: pct };
      setRuler({ start: pct, end: pct });
    } else if (tool === 'reveal' && canDmWrite) {
      if (e.shiftKey && gridOn && baseCalibration && mapRect) {
        const cell = gridCellRevealRect(pct, baseCalibration, mapRect);
        if (cell) {
          if ('reason' in cell) {
            announce(cell.reason);
          } else {
            commitFogEdit(appendFogReveal(fog, cell));
            announce('Revealed grid cell.');
          }
          return;
        }
      }
      e.currentTarget.setPointerCapture?.(e.pointerId);
      successfulPointerUpRef.current = null;
      activeGestureRef.current = { kind: 'fog', mode: 'reveal', pointerId: e.pointerId, captureTarget: e.currentTarget, start: pct, end: pct };
      setRevealCorners({ start: pct, end: pct });
    } else if (tool === 'erase' && canDmWrite) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      successfulPointerUpRef.current = null;
      activeGestureRef.current = { kind: 'fog', mode: 'erase', pointerId: e.pointerId, captureTarget: e.currentTarget, start: pct, end: pct };
      setRevealCorners({ start: pct, end: pct });
    } else if (tool === 'select' && canDmWrite && fogOn) {
      const regionId = hitTestFogRegion(fog?.revealed ?? [], pct.x, pct.y);
      if (regionId) {
        setSelectedFogRegionId(regionId);
        e.currentTarget.setPointerCapture?.(e.pointerId);
        successfulPointerUpRef.current = null;
        activeGestureRef.current = {
          kind: 'fog-region',
          pointerId: e.pointerId,
          captureTarget: e.currentTarget,
          regionId,
          start: pct,
          last: pct,
        };
      } else {
        setSelectedFogRegionId(null);
      }
    } else if (tool === 'move') {
      // Click on empty map in move mode clears any AoE or token selection (deselect).
      setSelectedAoeId(null);
      setSelectedTokenId(null);
    }
  }

  function onSurfacePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (trackPinchPointer(e, 'move')) return;
    const gesture = activeGestureRef.current;
    if (!e.isPrimary || !gesture || gesture.pointerId !== e.pointerId) return;
    if (gesture.kind === 'viewport-pan') {
      const local = surfaceLocalFromEvent(e);
      if (!local) return;
      const dx = local.x - gesture.lastX;
      const dy = local.y - gesture.lastY;
      gesture.lastX = local.x;
      gesture.lastY = local.y;
      setViewport((v) => panBy(v, dx, dy, surfaceSize));
      return;
    }
    if (gesture.kind === 'ping') {
      // Drag-away past tap slop cancels immediately — no publish on the eventual release.
      if (mapPingTapExceededSlop(gesture.arm, e.clientX, e.clientY)) {
        cancelActiveGesture(gesture.pointerId);
      }
      return;
    }
    // Keep an in-flight gesture alive across the letterbox by clamping to the map edge.
    const pct = pointerToPercent(e, true);
    if (!pct) return;

    if (gesture.kind === 'token') {
      gesture.point = pct;
      // A movable legal target needs ordinary touch jitter to remain a target tap. Use the
      // same CSS-pixel slop as map pings; map-percent movement varies with rendered map size.
      if (gesture.targetable
        ? mapPingTapExceededSlop(gesture, e.clientX, e.clientY)
        : Math.hypot(pct.x - gesture.start.x, pct.y - gesture.start.y) >= 0.25) gesture.moved = true;
      dragPosStore.set({ combatantId: gesture.tokenId, x: pct.x, y: pct.y });
    } else if (gesture.kind === 'token-select') {
      gesture.end = pct;
      setTokenSelectionRect({ start: gesture.start, end: pct });
    } else if (gesture.kind === 'token-lasso') {
      const last = gesture.points[gesture.points.length - 1];
      if (Math.hypot(last.x - pct.x, last.y - pct.y) >= 1) {
        gesture.points.push(pct);
        setTokenLasso([...gesture.points]);
      }
    } else if (gesture.kind === 'aoe') {
      gesture.point = pct;
      setAoeDrag({ id: gesture.templateId, ...pct });
    } else if (gesture.kind === 'calibrate') {
      gesture.point = pct;
      setCalibrateDrag({ anchor: gesture.anchor, ...pct });
    } else if (gesture.kind === 'fog') {
      gesture.end = pct;
      setRevealCorners({ start: gesture.start, end: pct });
    } else if (gesture.kind === 'fog-region') {
      gesture.last = pct;
      setFogRegionDrag({
        id: gesture.regionId,
        dx: pct.x - gesture.start.x,
        dy: pct.y - gesture.start.y,
      });
    } else if (gesture.kind === 'measure') {
      gesture.end = pct;
      setRuler({ start: gesture.start, end: pct });
    }
  }

  // Only the owning primary pointer's normal release may commit. Ownership is cleared before the
  // mutation callback, making duplicate pointerup/lostcapture delivery exactly-once by design.
  function releasePointerOwnership(gesture: ActiveMapGesture) {
    successfulPointerUpRef.current = gesture.pointerId;
    activeGestureRef.current = null;
    // Pointer capture is normally released implicitly after pointerup, but doing it explicitly
    // makes the lifecycle deterministic across mouse, pen, and touch implementations. Ownership
    // is already cleared, so a synchronous lostpointercapture can only acknowledge this success.
    try {
      if (gesture.captureTarget.hasPointerCapture?.(gesture.pointerId)) {
        gesture.captureTarget.releasePointerCapture?.(gesture.pointerId);
      }
    } catch {
      // The browser may already have released capture as part of pointerup dispatch.
    }
  }

  function onSurfacePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (trackPinchPointer(e, 'up')) return;
    const gesture = activeGestureRef.current;
    if (!e.isPrimary || !gesture || gesture.pointerId !== e.pointerId) return;

    if (gesture.kind === 'viewport-pan') {
      releasePointerOwnership(gesture);
      return;
    }

    // Ping: decide publish/cancel first, then always clear ownership + release capture so a
    // completed (or cancelled) tap never leaves `kind: 'ping'` armed for a later pointerup.
    if (gesture.kind === 'ping') {
      // A normal release always happens strictly before or strictly after the long-press
      // timer (never both fire the same gesture — the timer only checks a still-armed
      // 'ping' gesture, which this release is about to clear), but clear it here too so a
      // release that lands in the last instant before MAP_PING_TAP_MAX_MS never leaves a
      // stray timer that could theoretically outlive this gesture's pointerId being reused.
      clearPingHoldTimer();
      const decision = decideMapPingTapRelease(gesture.arm, {
        pointerId: e.pointerId,
        clientX: e.clientX,
        clientY: e.clientY,
        nowMs: performance.now(),
      });
      releasePointerOwnership(gesture);
      if (decision.action === 'publish') onPing(decision.x, decision.y);
      return;
    }

    // Clamp so a release that ends in the letterbox still commits at the map edge (#464).
    const finalPoint = pointerToPercent(e, true);
    releasePointerOwnership(gesture);
    // Completed measurements intentionally remain visible for reading. The three persistent
    // gesture classes clear their transient overrides before invoking their mutation callbacks.
    if (gesture.kind !== 'measure') clearGesturePreview(gesture.kind);

    if (gesture.kind === 'token') {
      if (gesture.targetable) targetGestureRef.current = { tokenId: gesture.tokenId, moved: gesture.moved };
      if (gesture.targetable && !gesture.moved) return;
      const raw = finalPoint ?? gesture.point;
      if (raw) {
        const pt = snapPoint(raw);
        const group = translateGroup(encounter.combatants, selectedTokenIds, gesture.tokenId, pt, gridOn ? Math.max(1, gridSize ?? 5) : 5, tokenPlanningAspect);
        // Player movement remains a single permitted token. A DM multi-drag is one
        // server-authoritative atomic batch, never a partial PATCH loop.
        if (effectiveIsDm && group.length > 1 && onBatchTokens) void onBatchTokens(group.map(item => ({ combatantId: item.id, x: item.x, y: item.y })), tokenPlanningAspect).then(result => {
          beginTokenBatchUndo(result.undoToken); announce(`${group.length} tokens moved together`);
        }).catch(error => onError(error instanceof Error ? error.message : 'Unable to move selected tokens'));
        else {
          // Issue #1911: origin is the combatant's pre-drop position — read it BEFORE
          // onMoveToken's patch lands, since a DM multi-select drag (above) never reaches here.
          const draggedCombatant = encounter.combatants.find((c) => c.id === gesture.tokenId);
          onMoveToken(gesture.tokenId, pt.x, pt.y);
          if (draggedCombatant) {
            commitDragMovement(gesture.tokenId, { x: draggedCombatant.tokenX ?? 0, y: draggedCombatant.tokenY ?? 0 }, pt);
          }
        }
      }
      return;
    }
    if (gesture.kind === 'token-select') {
      const end = finalPoint ?? gesture.end;
      const picked = tokensInRectangle(encounter.combatants, gesture.start, end);
      setSelectedTokenIds(current => gesture.additive ? new Set([...current, ...picked]) : picked);
      announce(`${picked.size} tokens selected`);
      return;
    }
    if (gesture.kind === 'token-lasso') {
      const points = [...gesture.points, ...(finalPoint ? [finalPoint] : [])];
      const picked = tokensInLasso(encounter.combatants, points);
      setSelectedTokenIds(current => gesture.additive ? new Set([...current, ...picked]) : picked);
      announce(`${picked.size} tokens selected`);
      return;
    }
    if (gesture.kind === 'aoe') {
      const point = finalPoint ?? gesture.point;
      if (effectiveCanDmWrite) updateAoe(gesture.templateId, { x: point.x, y: point.y });
      else updatePlayerAoeFromDraft(gesture.templateId, { x: point.x, y: point.y });
      return;
    }
    if (gesture.kind === 'calibrate') {
      // Commit the dragged anchor to the persisted grid (issue #417). Origin → offset;
      // cell → cell width/height (inverse-rotated into the grid frame so rotation is honored).
      const point = finalPoint ?? gesture.point;
      if (baseCalibration && mapRect) {
        const w = mapRect.width;
        const dragPx = mapPercentToLayerPx(point, mapRect);
        if (gesture.anchor === 'origin') {
          onSetGrid({
            gridOffsetX: roundTo((dragPx.x / w) * 100, 2),
            gridOffsetY: roundTo((dragPx.y / w) * 100, 2),
          });
        } else {
          const originXpx = (baseCalibration.offsetX / 100) * w;
          const originYpx = (baseCalibration.offsetY / 100) * w;
          const rad = (baseCalibration.rotationDeg * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const dx = dragPx.x - originXpx;
          const dy = dragPx.y - originYpx;
          const gw = dx * cos + dy * sin;
          const gh = -dx * sin + dy * cos;
          onSetGrid({
            gridSize: clampGridPercent(roundTo((gw / w) * 100, 2)),
            gridCellHeight: clampGridPercent(roundTo((gh / w) * 100, 2)),
          });
        }
      }
      return;
    }
    if (gesture.kind === 'fog') {
      if (gesture.mode === 'erase') {
        const rect = fogRectFromCorners(gesture.start, finalPoint ?? gesture.end);
        if (rect.w >= 1 && rect.h >= 1) {
          commitFogEdit(eraseFogRegion(fog, rect));
        }
      } else {
        commitFogReveal(gesture.start, finalPoint ?? gesture.end);
      }
      setRevealCorners(null);
      return;
    }
    if (gesture.kind === 'fog-region') {
      const final = finalPoint ?? gesture.last;
      const dx = final.x - gesture.start.x;
      const dy = final.y - gesture.start.y;
      if (Math.abs(dx) >= 0.25 || Math.abs(dy) >= 0.25) {
        commitFogEdit(moveFogRegion(fog, gesture.regionId, dx, dy));
      }
      setFogRegionDrag(null);
      return;
    }
    if (gesture.kind === 'measure') {
      setRuler({ start: gesture.start, end: finalPoint ?? gesture.end });
      return;
    }
  }

  function onPingKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (tool !== 'ping' || !isMapPingKeyboardActivation(e)) return;
    e.preventDefault();
    // Discrete keyboard activation never shares ownership with an armed pointer tap.
    if (activeGestureRef.current) return;
    onPing(MAP_PING_KEYBOARD_POINT.x, MAP_PING_KEYBOARD_POINT.y);
  }

  /** Right-click, with Ping armed, opens the intent menu directly (issue #1937) — the
   * mirror of the long-press path above, for a mouse user who never holds the button. */
  function onSurfaceContextMenu(e: ReactMouseEvent<HTMLDivElement>) {
    if (tool !== 'ping') return;
    e.preventDefault();
    const pct = pointerToPercent(e);
    if (!pct) return;
    // A synthetic pointerdown may already be armed from the right-click's own press —
    // drop it so it can never also publish a plain ping on some later stray pointerup.
    cancelActiveGesture();
    setPingIntentMenu({ x: pct.x, y: pct.y, clientX: e.clientX, clientY: e.clientY });
  }

  /**
   * Shift+Enter/Space, with Ping armed, opens the intent menu at the map center —
   * the keyboard-only mirror of the long-press and right-click paths above, neither
   * of which has any keyboard equivalent (issue #2047). The menu's own popover
   * (`clientX`/`clientY`) is anchored on the map surface itself, mirroring how a
   * plain keyboard ping (above) always lands at `MAP_PING_KEYBOARD_POINT` regardless
   * of pointer position.
   */
  function onPingIntentMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (tool !== 'ping' || !isMapPingIntentMenuKeyboardActivation(e)) return;
    e.preventDefault();
    // Discrete keyboard activation never shares ownership with an armed pointer tap.
    if (activeGestureRef.current) return;
    pingIntentOpenedByKeyboardRef.current = true;
    const rect = surfaceRef.current?.getBoundingClientRect();
    setPingIntentMenu({
      x: MAP_PING_KEYBOARD_POINT.x,
      y: MAP_PING_KEYBOARD_POINT.y,
      clientX: rect ? rect.left + rect.width / 2 : 0,
      clientY: rect ? rect.top + rect.height / 2 : 0,
    });
  }

  function choosePingIntent(key: PingIntentKey) {
    const menu = pingIntentMenu;
    if (!menu) return;
    setPingIntentMenu(null);
    onPing(menu.x, menu.y, pingIntentLabel(key));
    // Return focus to the map surface so a keyboard user who opened the menu with
    // Shift+Enter/Space isn't left with focus on a button that just unmounted.
    surfaceRef.current?.focus();
  }

  function dismissPingIntentMenu() {
    setPingIntentMenu(null);
  }

  // The first menu item is focused once the menu opens (issue #2047) — the intent
  // menu is a portal appended at the end of `document.body`, so its DOM tab order does
  // not follow the map surface; without an explicit focus move, a keyboard user who just
  // opened it via Shift+Enter/Space would have no reliable way to reach it at all.
  // When opened via keyboard, focus move is deferred until keyup so holding Shift+Enter
  // does not immediately auto-repeat into native button activation on the first item.
  const pingIntentOpenedByKeyboardRef = useRef(false);
  const pingIntentFirstItemRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!pingIntentMenu) return;
    if (pingIntentOpenedByKeyboardRef.current) {
      const handleKeyUp = (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          pingIntentOpenedByKeyboardRef.current = false;
          pingIntentFirstItemRef.current?.focus();
          window.removeEventListener('keyup', handleKeyUp);
        }
      };
      window.addEventListener('keyup', handleKeyUp);
      return () => {
        pingIntentOpenedByKeyboardRef.current = false;
        window.removeEventListener('keyup', handleKeyUp);
      };
    }
    pingIntentFirstItemRef.current?.focus();
  }, [pingIntentMenu]);

  // Close the intent menu on Escape or an outside pointerdown, matching the established
  // long-press/right-click popover pattern (RollContextMenu). Escape additionally returns
  // focus to the map surface — the outside-pointerdown path leaves focus alone, since the
  // user's pointer action already moved their attention elsewhere.
  useEffect(() => {
    if (!pingIntentMenu) return;
    const closeOnOutside = () => dismissPingIntentMenu();
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismissPingIntentMenu();
        surfaceRef.current?.focus();
      }
    };
    window.addEventListener('pointerdown', closeOnOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [pingIntentMenu]);

  function onSurfacePointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    trackPinchPointer(e, 'cancel');
    cancelActiveGesture(e.pointerId);
  }

  function onSurfaceLostPointerCapture(e: ReactPointerEvent<HTMLDivElement>) {
    if (successfulPointerUpRef.current === e.pointerId) {
      successfulPointerUpRef.current = null;
      return;
    }
    cancelActiveGesture(e.pointerId);
  }

  function onCalibrateAnchorPointerDown(e: ReactPointerEvent<HTMLDivElement>, anchor: CalibrateAnchor) {
    if (!e.isPrimary || activeGestureRef.current || !canDmWrite || tool !== 'calibrate') return;
    e.preventDefault();
    e.stopPropagation();
    const point = pointerToPercent(e, true);
    if (!point) return;
    const captureTarget = e.currentTarget;
    captureTarget.setPointerCapture?.(e.pointerId);
    successfulPointerUpRef.current = null;
    activeGestureRef.current = { kind: 'calibrate', pointerId: e.pointerId, captureTarget, anchor, point };
    setCalibrateDrag({ anchor, ...point });
  }

  function onAoeHandlePointerDown(e: ReactPointerEvent<HTMLDivElement>, t: AoeTemplate) {
    if (!e.isPrimary || activeGestureRef.current || viewportPan || !canEditAoe(t)) return;
    e.currentTarget.focus();
    setSelectedAoeId(t.id);
    e.preventDefault();
    e.stopPropagation();
    const pct = pointerToPercent(e, true);
    const point = pct ?? { x: t.x, y: t.y };
    const captureTarget = e.currentTarget;
    captureTarget.setPointerCapture?.(e.pointerId);
    successfulPointerUpRef.current = null;
    activeGestureRef.current = { kind: 'aoe', pointerId: e.pointerId, captureTarget, templateId: t.id, point };
    setAoeDrag({ id: t.id, ...point });
  }

  function onTokenKeyDown(e: ReactKeyboardEvent<HTMLDivElement>, c: Combatant) {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      const next = nudgeMapPoint({ x: c.tokenX ?? 0, y: c.tokenY ?? 0 }, e);
      onMoveToken(c.id, next.x, next.y);
      announce(`${c.name} moved to ${Math.round(next.x)} percent across, ${Math.round(next.y)} percent down`);
      // Issue #1911: keep the SAME burst (and its origin) going while nudges keep landing on
      // this token; a nudge on a different token, or after the previous burst already
      // committed, starts a fresh one from this token's own pre-nudge position.
      const burstOrigin =
        keyboardDragRef.current?.combatantId === c.id ? keyboardDragRef.current.origin : { x: c.tokenX ?? 0, y: c.tokenY ?? 0 };
      scheduleKeyboardDragCommit(c.id, burstOrigin, next);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      setSelectedTokenId(null);
      onUnplaceToken(c.id);
      announce(`${c.name} removed from map`);
    }
  }

  function onAoeHandleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>, t: AoeTemplate) {
    if (!canEditAoe(t)) return;
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      const next = nudgeMapPoint({ x: t.x, y: t.y }, e);
      if (effectiveCanDmWrite) updateAoe(t.id, { x: next.x, y: next.y });
      else updatePlayerAoeFromDraft(t.id, { x: next.x, y: next.y });
      announce(`${t.shape} template moved to ${Math.round(next.x)} percent across, ${Math.round(next.y)} percent down`);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      removeAoe(t.id);
      announce(`${t.shape} template removed`);
    }
  }

  function canEditAoe(t: AoeTemplate): boolean {
    return effectiveCanDmWrite || (effectiveCanDeclareAoe && t.declaredByUserId === viewerUserId);
  }

  // DMs retain the whole-list PATCH workflow; players use the scoped endpoints so
  // their ownership remains server-enforced (issue #1913).
  function addAoe(shape: AoeShape) {
    const sizeFt = shape === 'circle' ? (gridScale ?? 5) * 2 : (gridScale ?? 5) * BASE_AOE_LENGTH_MULT;
    const t: AoeTemplate = { id: newAoeId(), shape, x: 50, y: 50, sizeFt, angleDeg: 0, color: null, declaredByUserId: null };
    setSelectedAoeId(t.id);
    if (effectiveCanDmWrite) onSetAoe([...aoeTemplates, t]);
    else {
      // Omit at runtime, not merely in the TypeScript annotation: the server's
      // strict declaration schema rejects caller-supplied attribution.
      const { declaredByUserId: _serverOwnedDeclarer, ...declaration } = t;
      onDeclareAoe(declaration);
    }
  }
  function updateAoe(id: string, patch: Partial<Omit<AoeTemplate, 'id' | 'declaredByUserId'>>): void | Promise<void> {
    if (effectiveCanDmWrite) return onSetAoe(aoeTemplates.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    return onUpdateAoe(id, patch);
  }
  function updatePlayerAoeFromDraft(id: string, patch: Partial<Omit<AoeTemplate, 'id' | 'declaredByUserId'>>) {
    void Promise.resolve().then(() => updateAoe(id, patch)).catch(() => {
      // The server rejected this edit. Restore an editable draft from the
      // last known template; clearing it leaves a focused controlled input
      // without a draft for its onChange handler to update.
      if (pendingAoeDraftRef.current === id) pendingAoeDraftRef.current = null;
      const template = aoeTemplates.find((candidate) => candidate.id === id);
      setAoeDraft(template ? {
        id: template.id,
        x: String(template.x),
        y: String(template.y),
        sizeFt: String(template.sizeFt),
        angleDeg: String(template.angleDeg),
      } : null);
    });
  }
  function removeAoe(id: string) {
    if (selectedAoeId === id) setSelectedAoeId(null);
    if (effectiveCanDmWrite) onSetAoe(aoeTemplates.filter((t) => t.id !== id));
    else onRemoveAoe(id);
  }

  // Measurement readout — fractional cells along a straight line, rounded to whole cells for scale.
  const rulerReadout = (() => {
    if (!ruler || !canMeasure || !mapRect) return null;
    const cells = mapPercentGridDistance(
      ruler.start,
      ruler.end,
      mapRect,
      cellPx,
      gridType,
      calibration,
      hexOrientation,
      gridDistanceRule,
    );
    return { cells };
  })();

  // Issue #1911's live token-drag / keyboard-nudge distance readout now lives in
  // `DragDistanceOverlay` above (issue #1917 stage 3) — it derives the same thing from
  // `dragPosStore` directly via its own `useSyncExternalStore` subscription, so this component's
  // OWN render never needs to depend on the live drag position.

  const revealPreview = revealCorners ? fogRectFromCorners(revealCorners.start, revealCorners.end) : null;
  const fogBrushMode = tool === 'erase' ? 'erase' : 'reveal';
  const displayedFogRects = useMemo(() => {
    const revealed = ensureFogRectIds(fog?.revealed ?? []);
    if (!fogRegionDrag) return revealed;
    return revealed.map((r) =>
      r.id === fogRegionDrag.id ? { ...r, x: r.x + fogRegionDrag.dx, y: r.y + fogRegionDrag.dy } : r,
    );
  }, [fog?.revealed, fogRegionDrag]);
  const selectedAoe = aoeTemplates.find((t) => t.id === selectedAoeId) ?? null;
  useEffect(() => {
    if (!selectedAoe || effectiveCanDmWrite) {
      setAoeDraft(null);
      return;
    }
    // Keep unfocused fields truthful after a drag, keyboard nudge, or concurrent
    // DM update, but never replace text while the player is actively typing it.
    if (editingAoeDraft) return;
    if (pendingAoeDraftRef.current === selectedAoe.id && aoeDraft) {
      if (aoeDraft.x === String(selectedAoe.x) && aoeDraft.y === String(selectedAoe.y) && aoeDraft.sizeFt === String(selectedAoe.sizeFt) && aoeDraft.angleDeg === String(selectedAoe.angleDeg)) pendingAoeDraftRef.current = null;
      else return;
    }
    setAoeDraft({
      id: selectedAoe.id,
      x: String(selectedAoe.x),
      y: String(selectedAoe.y),
      sizeFt: String(selectedAoe.sizeFt),
      angleDeg: String(selectedAoe.angleDeg),
    });
  }, [editingAoeDraft, effectiveCanDmWrite, selectedAoe]);
  const playerAoeDraft = !effectiveCanDmWrite && selectedAoe && aoeDraft?.id === selectedAoe.id ? aoeDraft : null;
  const selectedToken = selectedTokenId != null ? encounter.combatants.find((c) => c.id === selectedTokenId) ?? null : null;

  // Condition chips already carry their detailed title/metadata in the roster. A
  // token badge is a shortcut to that same accessible detail rather than a second
  // condition UI, so it cannot drift from the server-shaped combatant data.
  const focusTokenConditionDetails = (combatantId: number) => {
    // Let the badge's pointer/click cycle settle before looking up a roster row.
    // This also handles a roster element React replaces as the latest encounter
    // state commits, so focus always lands on the live detailed condition row.
    const detailsId = `combatant-${combatantId}-conditions`;
    const focusDetails = () => {
      const details = document.getElementById(detailsId);
      if (!details) return false;
      // In the cockpit the roster row lives in a panel that may be on another tab, or
      // collapsed entirely — neither of which `scrollIntoView`/`focus` can undo. Ask for
      // it to be shown, then land focus on the next frame once that has committed.
      revealCockpitPanel(detailsId, () => {
        const shown = document.getElementById(detailsId);
        if (!shown) return;
        shown.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
        shown.focus({ preventScroll: true });
      });
      return true;
    };
    requestAnimationFrame(() => {
      // A data refresh can commit after this frame, so retry once after the
      // replacement roster row has had a chance to mount.
      if (!focusDetails()) window.setTimeout(focusDetails, 50);
    });
  };

  useEffect(() => {
    setTokenEdit(
      selectedToken
        ? { x: String(selectedToken.tokenX ?? 0), y: String(selectedToken.tokenY ?? 0) }
        : null,
    );
  }, [selectedToken]);

  // Hex overlay polygons (issue #238). Tiled in map-layer space so letterboxing never
  // stretches cells (#464). Memoized on geometry inputs so a token/AoE drag never recomputes.
  const hexCells = useMemo(
    () =>
      gridOn && gridType === 'hex' && mapRect && calibrationPx
        ? hexPolygons(mapRect.width, mapRect.height, calibrationPx, hexOrientation)
        : [],
    [gridOn, gridType, mapRect, calibrationPx, hexOrientation],
  );

  // A primitive value, not memoized (issue #1917 stage 2): comparing two equal numbers is
  // always `===` regardless of how many times this line runs, so `<GridOverlay>`'s memo
  // boundary skips just as cleanly as if this were wrapped in its own useMemo. Kept beside
  // `hexCells` since both feed `<GridOverlay>`'s geometry-only prop surface.
  const gridOverlayOpacity = calibrationPx?.opacity ?? DEFAULT_GRID_OPACITY;

  function changeTool(next: MapTool) {
    // Leaving a mode drops any armed/incomplete gesture (including an unfinished ping tap).
    cancelActiveGesture();
    setTool(next);
    setRuler(null);
    setRevealCorners(null);
    setCalibrateDrag(null);
    setSelectedAoeId(null);
    setSelectedTokenId(null);
    setSelectedFogRegionId(null);
    setFogRegionDrag(null);
  }

  // `gateReason` is optional and separate from `hint` (issue #1933): most of this
  // toolbar's disabled buttons keep their pre-existing hover-only `title`, unchanged.
  // Only the one call site that passes `gateReason` gets the full GatedControl
  // affordance (hover/focus tooltip, aria-describedby, coarse-pointer tap hint) — but the
  // wrapper itself is ALWAYS present (reason={gateReason}, which is undefined for every
  // other call site) rather than conditionally rendered. GatedControl's own doc comment
  // explains why: a conditional wrapper changes the tree shape the moment `gateReason`
  // flips from set to undefined, forcing React to unmount and remount the button — losing
  // focus on the exact transition (grid scale gets set) this affordance exists to explain.
  const modeBtn = (value: MapTool, label: string, disabled = false, hint?: string, gateReason?: string) => (
    <GatedControl reason={gateReason}>
      <button
        type="button"
        className="cf-map-tool cf-map-focusable"
        data-testid={`map-tool-${value}`}
        disabled={disabled}
        title={hint ?? (isVtt ? label : undefined)}
        aria-pressed={tool === value}
        onClick={() => changeTool(value)}
        style={{
          borderColor: tool === value ? 'var(--color-accent)' : isVtt ? 'transparent' : 'var(--color-divider)',
          color: tool === value ? 'var(--color-accent)' : undefined,
        }}
      >
        {isVtt && (
          <span className="cf-vtt-rail-glyph" aria-hidden>
            {TOOL_GLYPH[value]}
          </span>
        )}
        <span className={isVtt ? 'cf-vtt-rail-label' : undefined}>{label}</span>
      </button>
    </GatedControl>
  );

  /** Rail-only affordance: the same button shape as `modeBtn`, for one-shot actions. */
  const railBtn = (
    key: string,
    glyph: ReactNode,
    label: string,
    onClick: () => void,
    { disabled = false, hint }: { disabled?: boolean; hint?: string } = {},
  ) => (
    <button
      key={key}
      type="button"
      className="cf-map-tool cf-map-focusable"
      data-testid={`map-rail-${key}`}
      disabled={disabled}
      title={hint ?? label}
      onClick={onClick}
    >
      <span className="cf-vtt-rail-glyph" aria-hidden>
        {glyph}
      </span>
      <span className="cf-vtt-rail-label">{label}</span>
    </button>
  );

  return (
    <Card
      density="compact" elev={isCast || isVtt ? undefined : 'sm'}
      className={isCast ? 'cf-cast-battle-map' : isVtt ? `reading-exempt cf-vtt-map${mapImageUrl ? '' : ' cf-vtt-map--empty'}` : 'reading-exempt'}
      data-testid={isCast ? 'cf-cast-battle-map' : 'battle-map'}
      style={{
        padding: 0,
        overflow: isVtt ? undefined : 'hidden',
        ...(isCast ? { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } : {}),
      }}
    >
      {/* The cockpit puts the encounter name in the page header and the replace
          control in the floating aside, so this card header is card-layout only. */}
      {!isCast && !isVtt && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px 0', flexWrap: 'wrap' }}>
        <span className="card-kicker">Battle map</span>
        <div style={{ flex: 1 }} />
        {effectiveCanDmWrite && mapImageUrl && (
          <MapUploadButton
            campaignId={campaignId}
            hasMap
            uploading={uploading || busy}
            onPick={(file) => void uploadMapFile(file)}
            onRemove={() => void openMapRemoveDialog()}
          />
        )}
      </div>
      )}

      {mapDialog && (
        <MapReplaceDialog
          mode={mapDialog.mode}
          previewUrl={mapDialog.previewUrl}
          counts={{
            points: placed.length + hiddenByFog.length,
            grid: encounter.gridSize != null && encounter.gridSize > 0,
            fog: encounter.fog?.enabled === true,
            aoe: encounter.aoe?.length ?? 0,
          }}
          defaultAlignment={mapDialog.defaultAlignment}
          busy={uploading || busy}
          onChoice={async (alignment) => {
            const mode = mapDialog.mode;
            setMapDialog(null);
            if (mode === 'remove') {
              onSetMap(null, alignment);
            } else {
              await commitMapReplace(alignment);
            }
          }}
          onCancel={() => {
            setMapDialog(null);
          }}
        />
      )}

      {!isCast && effectiveCanDmWrite && !mapImageUrl && (
        <div style={{ padding: '8px 14px' }}>
          <MapConceptGlossary compact />
          <div style={{ marginTop: 8 }}>
            <MapPurposePreview purpose="encounter" surfacePurpose="encounter" mode="upload" />
          </div>
          <ImageUpload
            campaignId={campaignId}
            kind="map"
            shape="rect"
            label="Drop a battle map image, or click to choose"
            onUploaded={(a) => onSetMap(a.id)}
            onError={onError}
          />
          {/* Open, license-clean map sources (issue #303): generator links + One Page Dungeon
              (CC-BY-SA) import — plus the built-in procedural generator wizard (#306/#409),
              wired to the atomic generate-and-attach path via onGenerate. */}
          <GetAMapPanel
            campaignId={campaignId}
            surfacePurpose="encounter"
            onImported={(id) => (onImportMap ? onImportMap(id) : onSetMap(id))}
            onGenerate={onGenerateMap}
            onError={onError}
          />
        </div>
      )}

      {mapImageUrl && (
        <>
          {/* Toolbar: interaction mode + ping + (DM) AoE templates + grid & fog controls.
              Rendered first so the cockpit rail (which CSS lifts out of flow against the
              card root) is the map's first tab stop and never nests inside the floating
              aside below — an absolutely-positioned ancestor would re-anchor it. */}
          {!isCast && (
          <div
            className={isVtt ? 'cf-vtt-rail' : 'flex flex-wrap gap-2 items-center'}
            style={isVtt ? undefined : { padding: '8px 14px 0' }}
            data-testid="map-toolbar"
            role="toolbar"
            aria-orientation={isVtt ? 'vertical' : undefined}
            aria-label="Map tools"
          >
            {modeBtn('move', 'Move')}
            {effectiveCanDmWrite && modeBtn('token-select', 'Tokens', false, 'Drag a rectangle to select tokens; hold Alt to lasso; Shift, Ctrl, or Command adds.')}
            {modeBtn(
              'measure',
              'Measure',
              !canMeasure,
              canMeasure ? measureToolHelp(gridType) : undefined,
              canMeasure ? undefined : t('run.gate.measureNoGridScale'),
            )}
            {modeBtn('ping', 'Ping', false, 'Tap or activate the map to ping a spot for everyone')}
            {effectiveCanDmWrite && modeBtn('reveal', 'Reveal', undefined, 'Click-drag to reveal a fog region. Shift-click a grid cell when the grid is on.')}
            {effectiveCanDmWrite && modeBtn('erase', 'Erase', !fogOn, fogOn ? 'Click-drag to hide a fog region' : 'Enable fog first')}
            {effectiveCanDmWrite && modeBtn('select', 'Select', !fogOn, fogOn ? 'Select, drag, or delete a revealed region' : 'Enable fog first')}
            {/* Fog undo/redo and Calibrate are not rail tools in the cockpit. Undo/redo are
                viewport-level actions, so they sit in the viewport toolbar with pan/zoom;
                Calibrate only means anything once the grid is on, so it lives inside the
                Grid & fog panel that owns the grid. Both keep their rail slots in the card
                layout, which has no viewport toolbar and no floating panel. */}
            {!isVtt && effectiveCanDmWrite && fogOn && (
              <>
                <button
                  type="button"
                  className="cf-map-tool cf-map-focusable"
                  data-testid="map-fog-undo"
                  title="Undo last fog edit (Ctrl+Z)"
                  disabled={!fogUndoUi.canUndo}
                  onClick={undoFogEdit}
                >
                  <span>{t('encounters.map.fog.undo')}</span>
                </button>
                <button
                  type="button"
                  className="cf-map-tool cf-map-focusable"
                  data-testid="map-fog-redo"
                  title="Redo fog edit (Ctrl+Shift+Z)"
                  disabled={!fogUndoUi.canRedo}
                  onClick={redoFogEdit}
                >
                  <span>{t('encounters.map.fog.redo')}</span>
                </button>
              </>
            )}
            {!isVtt && effectiveCanDmWrite && modeBtn('calibrate', 'Calibrate', !canCalibrate, canCalibrate ? 'Drag the anchors to align the grid to the map' : 'Enable the grid first')}
            {effectiveCanDeclareAoe && canAoe && (
              <>
                {isVtt ? (
                  <>
                    <span className="cf-vtt-rail-sep" aria-hidden />
                    {railBtn('aoe-circle', '◯', 'Circle', () => addAoe('circle'), { hint: t('encounters.map.aoe.addCircle') })}
                    {railBtn('aoe-cone', '◭', 'Cone', () => addAoe('cone'), { hint: t('encounters.map.aoe.addCone') })}
                    {railBtn('aoe-line', '╱', 'Line', () => addAoe('line'), { hint: t('encounters.map.aoe.addLine') })}
                    {effectiveCanDmWrite && onClearPlayerAoe && (encounter.aoe ?? []).some((template) => template.declaredByUserId != null) &&
                      railBtn('aoe-clear', <UIIcon name="close" size="xs" />, t('encounters.map.aoe.clearPlayers'), onClearPlayerAoe, {
                        hint: t('encounters.map.aoe.clearPlayersHint'),
                      })}
                  </>
                ) : (
                  <>
                    <span className="text-muted" style={{ fontSize: 11, marginLeft: 4 }}>{t('encounters.map.aoe.label')}:</span>
                    <button type="button" className="cf-map-tool cf-map-focusable" title={t('encounters.map.aoe.addCircle')} onClick={() => addAoe('circle')}>+ Circle</button>
                    <button type="button" className="cf-map-tool cf-map-focusable" title={t('encounters.map.aoe.addCone')} onClick={() => addAoe('cone')}>+ Cone</button>
                    <button type="button" className="cf-map-tool cf-map-focusable" title={t('encounters.map.aoe.addLine')} onClick={() => addAoe('line')}>+ Line</button>
                    {effectiveCanDmWrite && onClearPlayerAoe && (encounter.aoe ?? []).some((template) => template.declaredByUserId != null) && (
                      <button type="button" className="cf-map-tool cf-map-focusable" title={t('encounters.map.aoe.clearPlayersHint')} onClick={onClearPlayerAoe}>{t('encounters.map.aoe.clearPlayers')}</button>
                    )}
                  </>
                )}
              </>
            )}
            <div style={{ flex: 1 }} />
            {/* Token-detail mode is a select, not a tool — the cockpit shows it in the
                floating aside instead, where a dropdown has room to open. */}
            {effectiveIsDm && !isVtt && (
              <label className="flex items-center gap-1 text-muted" style={{ fontSize: 11 }}>
                <span>{t('encounters.map.tokenDetails.label')}</span>
                <select
                  className="cf-map-tool"
                  data-testid="map-token-detail-mode"
                  aria-label={t('encounters.map.tokenDetails.label')}
                  value={dmTokenDetailMode}
                  onChange={(event) => setTokenDetailMode(event.target.value as TokenDetailMode)}
                  style={{ minWidth: 92, textTransform: 'none', letterSpacing: 0 }}
                >
                  <option value="full">{t('encounters.map.tokenDetails.full')}</option>
                  <option value="minimal">{t('encounters.map.tokenDetails.minimal')}</option>
                  <option value="off">{t('encounters.map.tokenDetails.off')}</option>
                </select>
              </label>
            )}
            {effectiveCanDmWrite && (
              <>
                {isVtt && <span className="cf-vtt-rail-sep" aria-hidden />}
                <button
                  type="button"
                  className="cf-map-tool cf-map-focusable"
                  {...gridDisclosure.buttonProps}
                  title="Grid & fog settings"
                  style={{ borderColor: gridPanelOpen ? 'var(--color-accent)' : isVtt ? 'transparent' : 'var(--color-divider)' }}
                >
                  {isVtt && <span className="cf-vtt-rail-glyph" aria-hidden>▦</span>}
                  <span className={isVtt ? 'cf-vtt-rail-label' : undefined}>
                    Grid &amp; fog
                  </span>
                </button>
              </>
            )}
            {isVtt && effectiveIsDm && (
              <button
                type="button"
                className="cf-map-tool cf-map-focusable"
                {...mapSetupDisclosure.buttonProps}
                data-testid="map-setup-toggle"
                title="Map setup — token detail and the map file"
                style={{ borderColor: mapSetupDisclosure.open ? 'var(--color-accent)' : 'transparent' }}
              >
                <span className="cf-vtt-rail-glyph" aria-hidden>▤</span>
                <span className="cf-vtt-rail-label">{t('encounters.map.setup')}</span>
              </button>
            )}
            {isVtt && effectiveIsDm && (
              <button
                type="button"
                className="cf-map-tool cf-map-focusable"
                {...selectionDisclosure.buttonProps}
                data-testid="map-selection-toggle"
                title="Manage tokens — select, arrange, and place"
                style={{ borderColor: selectionDisclosure.open ? 'var(--color-accent)' : 'transparent' }}
              >
                <span className="cf-vtt-rail-glyph" aria-hidden>⛶</span>
                <span className="cf-vtt-rail-label">{t('encounters.map.manage.title')}</span>
              </button>
            )}
          </div>
          )}

          {/* Everything between the rail and the canvas. In card layout this wrapper is
              `display: contents` and changes nothing; in the cockpit it becomes the
              floating aside over the map's top-left. */}
          <div
            className={isVtt ? 'cf-vtt-map-aside' : undefined}
            style={isVtt ? undefined : { display: 'contents' }}
          >
          {isVtt && effectiveIsDm && mapSetupDisclosure.open && (
            <div {...mapSetupDisclosure.regionProps} className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-muted" style={{ fontSize: 11 }}>
                <span>{t('encounters.map.tokenDetails.label')}</span>
                <select
                  className="cf-map-tool"
                  data-testid="map-token-detail-mode"
                  aria-label={t('encounters.map.tokenDetails.label')}
                  value={dmTokenDetailMode}
                  onChange={(event) => setTokenDetailMode(event.target.value as TokenDetailMode)}
                  style={{ minWidth: 92, textTransform: 'none', letterSpacing: 0 }}
                >
                  <option value="full">{t('encounters.map.tokenDetails.full')}</option>
                  <option value="minimal">{t('encounters.map.tokenDetails.minimal')}</option>
                  <option value="off">{t('encounters.map.tokenDetails.off')}</option>
                </select>
              </label>
              {effectiveCanDmWrite && (
                <div className="flex items-center gap-2 flex-wrap">
                  <MapUploadButton
                    campaignId={campaignId}
                    hasMap
                    uploading={uploading || busy}
                    onPick={(file) => void uploadMapFile(file)}
                    onRemove={() => void openMapRemoveDialog()}
                  />
                </div>
              )}
            </div>
          )}
          {/* Derivative lifecycle for the battle map (issue #604). The board always
              renders — this row only explains a heavy first load, flags a stale copy,
              or reports a generation failure. Everyone sees the explanation; only a
              DM-writer gets the regenerate button (it acts on the attachment). */}
          {(mapDerivatives.processing || mapDerivatives.stale || mapDerivatives.error) && (
            <div
              data-testid="battle-map-derivative-status"
              role="status"
              className="text-muted"
              style={{ padding: '8px 14px 0', fontSize: 'var(--type-meta)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
            >
              <span>
                {mapDerivatives.error
                  ? t('encounters:map.derivatives.failed')
                  : mapDerivatives.processing
                    ? t('encounters:map.derivatives.processing')
                    : t('encounters:map.derivatives.stale')}
              </span>
              {effectiveCanDmWrite && (mapDerivatives.error || mapDerivatives.stale) && (
                <button
                  type="button"
                  className="btn btn-ghost cf-density-xs"
                  disabled={mapDerivatives.retrying}
                  onClick={() => void mapDerivatives.retry()}
                >
                  {mapDerivatives.retrying ? t('encounters:map.derivatives.retrying') : t('encounters:map.derivatives.retry')}
                </button>
              )}
            </div>
          )}

          {/* Post-attach guidance (issue #409): after a generated map is attached it stays
              hidden (DM-only) with an aligned grid — walk the DM through the next steps so
              the map is table-ready. Dismissible; only shown right after an attach. */}
          {effectiveCanDmWrite && showGuidance && (
            <div
              data-testid="map-attach-guidance"
              className="cf-inset"
              style={{ margin: '8px 14px 0', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span className="card-kicker">Map attached — next steps</span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  aria-label="Dismiss map setup guidance"
                  onClick={onDismissGuidance}
                  className="btn btn-ghost"
                  style={{ minHeight: 20, padding: '0 6px' }}
                >
                  <UIIcon name="close" size="xs" />
                </button>
              </div>
              <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
                The map is saved DM-only (hidden from the player Handouts card) with its grid
                pre-aligned. To make it table-ready:
              </p>
              <ol className="text-muted" style={{ fontSize: 12, margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <li><strong>Check the grid</strong> — open <em>Grid &amp; fog</em> to confirm cell size and scale.</li>
                <li><strong>Set fog</strong> — toggle <em>Fog</em> on, then use the <em>Reveal</em> tool to show only what the party can see.</li>
                <li><strong>Place tokens</strong> — drop each combatant from the <em>Unplaced</em> tray onto the map.</li>
              </ol>
              <MapPurposePreview purpose="encounter" surfacePurpose="encounter" mode="preview" />
            </div>
          )}

          {/* Standing explanation, not a state readout — in the cockpit the same wording
              lives under Grid & fog rather than taking a permanent slot over the canvas. */}
          {!isCast && !isVtt && effectiveCanDmWrite && (
            <p
              className="text-muted"
              data-testid="map-player-preview-note"
              style={{ padding: '6px 14px 0', margin: 0, fontSize: 11 }}
            >
              Player preview: Cast and player map views use the player-safe fog projection; revealed handouts use the raw file instead.
            </p>
          )}

          {/* Selected token editor — numeric position/size controls for switch and voice users (issue #419). */}
          {!isCast && selectedToken && tool === 'move' && (
            <div className="flex flex-wrap gap-3 items-center" style={{ padding: '8px 14px 0', fontSize: 11 }} data-testid="selected-token-panel">
              <span className="text-muted" style={{ textTransform: 'capitalize' }}>{selectedToken.name}</span>
              <label className="flex items-center gap-1 text-muted">
                x%
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={tokenEdit?.x ?? (selectedToken.tokenX ?? 0)}
                  onChange={(e) =>
                    setTokenEdit((prev) =>
                      prev ? { ...prev, x: e.target.value } : { x: e.target.value, y: String(selectedToken.tokenY ?? 0) },
                    )
                  }
                  onBlur={(e) => {
                    const x = clampPercent(Number(e.target.value) || 0);
                    const yRaw = tokenEdit?.y != null && tokenEdit.y !== '' ? Number(tokenEdit.y) : selectedToken.tokenY ?? 0;
                    const y = clampPercent(Number.isFinite(yRaw) ? yRaw : selectedToken.tokenY ?? 0);
                    onMoveToken(selectedToken.id, x, y);
                    setTokenEdit({ x: String(x), y: String(y) });
                  }}
                  style={{ width: 56 }}
                />
              </label>
              <label className="flex items-center gap-1 text-muted">
                y%
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={tokenEdit?.y ?? (selectedToken.tokenY ?? 0)}
                  onChange={(e) =>
                    setTokenEdit((prev) =>
                      prev ? { ...prev, y: e.target.value } : { y: e.target.value, x: String(selectedToken.tokenX ?? 0) },
                    )
                  }
                  onBlur={(e) => {
                    const xRaw = tokenEdit?.x != null && tokenEdit.x !== '' ? Number(tokenEdit.x) : selectedToken.tokenX ?? 0;
                    const x = clampPercent(Number.isFinite(xRaw) ? xRaw : selectedToken.tokenX ?? 0);
                    const y = clampPercent(Number(e.target.value) || 0);
                    onMoveToken(selectedToken.id, x, y);
                    setTokenEdit({ x: String(x), y: String(y) });
                  }}
                  style={{ width: 56 }}
                />
              </label>
              {onSetTokenSize && (
                <select
                  aria-label={`Token size for ${selectedToken.name}`}
                  value={selectedToken.tokenSize}
                  onChange={(e) => onSetTokenSize(selectedToken.id, e.target.value as TokenSize)}
                  style={{ height: 24, borderRadius: 'var(--radius-md)', border: '1px solid var(--color-divider)', background: 'transparent', color: 'var(--color-text)', fontSize: 12, padding: '0 6px' }}
                >
                  {TOKEN_SIZE_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="cf-map-tool"
                style={{ color: 'var(--color-danger, #ef4444)' }}
                onClick={() => {
                  setSelectedTokenId(null);
                  onUnplaceToken(selectedToken.id);
                }}
              >
                Remove
              </button>
            </div>
          )}

          {/* Selected AoE editor: players only receive controls for their own templates. */}
          {!isCast && selectedAoe && canAoe && canEditAoe(selectedAoe) && (
            <div className="flex flex-wrap gap-3 items-center" style={{ padding: '8px 14px 0', fontSize: 11 }}>
              <span className="text-muted" style={{ textTransform: 'capitalize' }}>{selectedAoe.shape}</span>
              <label className="flex items-center gap-1 text-muted">
                x%
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={playerAoeDraft?.x ?? selectedAoe.x}
                  onFocus={() => setEditingAoeDraft(true)}
                  onChange={(e) => {
                    if (effectiveCanDmWrite) updateAoe(selectedAoe.id, { x: clampPercent(Number(e.target.value) || 0) });
                    else setAoeDraft((draft) => draft && { ...draft, x: e.target.value });
                  }}
                  onBlur={(e) => {
                    const x = clampPercent(Number(e.currentTarget.value) || 0);
                    if (!effectiveCanDmWrite) setAoeDraft((draft) => draft && { ...draft, x: String(x) });
                    pendingAoeDraftRef.current = selectedAoe.id;
                    setEditingAoeDraft(false);
                    if (!effectiveCanDmWrite) updatePlayerAoeFromDraft(selectedAoe.id, { x });
                  }}
                  style={{ width: 56 }}
                />
              </label>
              <label className="flex items-center gap-1 text-muted">
                y%
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={playerAoeDraft?.y ?? selectedAoe.y}
                  onFocus={() => setEditingAoeDraft(true)}
                  onChange={(e) => {
                    if (effectiveCanDmWrite) updateAoe(selectedAoe.id, { y: clampPercent(Number(e.target.value) || 0) });
                    else setAoeDraft((draft) => draft && { ...draft, y: e.target.value });
                  }}
                  onBlur={(e) => {
                    const y = clampPercent(Number(e.currentTarget.value) || 0);
                    if (!effectiveCanDmWrite) setAoeDraft((draft) => draft && { ...draft, y: String(y) });
                    pendingAoeDraftRef.current = selectedAoe.id;
                    setEditingAoeDraft(false);
                    if (!effectiveCanDmWrite) updatePlayerAoeFromDraft(selectedAoe.id, { y });
                  }}
                  style={{ width: 56 }}
                />
              </label>
              <label className="flex items-center gap-1 text-muted">
                {selectedAoe.shape === 'circle' ? 'radius' : 'length'}
                <input
                  type="number"
                  min={0}
                  step={gridScale ?? 5}
                  value={playerAoeDraft?.sizeFt ?? selectedAoe.sizeFt}
                  onFocus={() => setEditingAoeDraft(true)}
                  onChange={(e) => {
                    if (effectiveCanDmWrite) updateAoe(selectedAoe.id, { sizeFt: Math.max(1, Number(e.target.value) || 1) });
                    else setAoeDraft((draft) => draft && { ...draft, sizeFt: e.target.value });
                  }}
                  onBlur={(e) => {
                    const sizeFt = Math.max(1, Number(e.currentTarget.value) || 1);
                    if (!effectiveCanDmWrite) setAoeDraft((draft) => draft && { ...draft, sizeFt: String(sizeFt) });
                    pendingAoeDraftRef.current = selectedAoe.id;
                    setEditingAoeDraft(false);
                    if (!effectiveCanDmWrite) updatePlayerAoeFromDraft(selectedAoe.id, { sizeFt });
                  }}
                  style={{ width: 56 }}
                />
                {gridUnit}
              </label>
              {selectedAoe.shape !== 'circle' && (
                <label className="flex items-center gap-1 text-muted">
                  angle°
                  <input
                    type="number"
                    step={15}
                    value={playerAoeDraft?.angleDeg ?? selectedAoe.angleDeg}
                    onFocus={() => setEditingAoeDraft(true)}
                    onChange={(e) => {
                      if (effectiveCanDmWrite) updateAoe(selectedAoe.id, { angleDeg: Number(e.target.value) || 0 });
                      else setAoeDraft((draft) => draft && { ...draft, angleDeg: e.target.value });
                    }}
                    onBlur={(e) => {
                      const angleDeg = Number(e.currentTarget.value) || 0;
                      if (!effectiveCanDmWrite) setAoeDraft((draft) => draft && { ...draft, angleDeg: String(angleDeg) });
                      pendingAoeDraftRef.current = selectedAoe.id;
                      setEditingAoeDraft(false);
                      if (!effectiveCanDmWrite) updatePlayerAoeFromDraft(selectedAoe.id, { angleDeg });
                    }}
                    style={{ width: 56 }}
                  />
                </label>
              )}
              <button type="button" className="cf-map-tool" style={{ color: 'var(--color-danger, #ef4444)' }} onClick={() => removeAoe(selectedAoe.id)}>Remove</button>
            </div>
          )}

          {!isCast && effectiveCanDmWrite && gridPanelOpen && (
            <div
              {...gridDisclosure.regionProps}
              className="flex flex-wrap gap-3 items-center"
              style={{ padding: '10px 14px', margin: '8px 14px 0', border: '1px solid var(--color-divider)', borderRadius: 8, fontSize: 12 }}
            >
              {/* Calibrate belongs to the grid, so it lives with the grid rather than
                  holding a permanent rail slot for a tool that is inert until the grid
                  is switched on right here. */}
              {isVtt && effectiveCanDmWrite && (
                <button
                  type="button"
                  className="cf-map-tool cf-map-tool--compact cf-map-focusable"
                  data-testid="map-tool-calibrate"
                  disabled={!canCalibrate}
                  aria-pressed={tool === 'calibrate'}
                  title={canCalibrate ? 'Drag the anchors to align the grid to the map' : 'Enable the grid first'}
                  onClick={() => changeTool('calibrate')}
                  style={{
                    borderColor: tool === 'calibrate' ? 'var(--color-accent)' : 'var(--color-divider)',
                    color: tool === 'calibrate' ? 'var(--color-accent)' : undefined,
                  }}
                >
                  Calibrate
                </button>
              )}
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={gridOn}
                  onChange={(e) =>
                    onSetGrid(
                      e.target.checked
                        ? // Enabling the grid commits real scale/unit alongside the size so the
                          // shown defaults are never phantom and Measure is usable (issue #273a).
                          { gridSize: gridSize ?? 8, gridScale: gridScale ?? 5, gridUnit }
                        : { gridSize: null },
                    )
                  }
                />
                Grid
              </label>
              <label className="flex items-center gap-1 text-muted" title="How wide one grid cell is, as a percentage of the map's width. Larger = bigger cells.">
                Cell width %
                <input
                  type="number"
                  aria-label="Cell width (percent of map width)"
                  min={1}
                  max={100}
                  step={0.5}
                  disabled={!gridOn}
                  value={gridSize ?? 8}
                  onChange={(e) => onSetGrid({ gridSize: Math.min(100, Math.max(1, Number(e.target.value) || 8)) })}
                  style={{ width: 60 }}
                />
              </label>
              <label className="flex items-center gap-1 text-muted" title="Real-world size of one cell (with the unit below) — used by the ruler to read out distances.">
                scale
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={gridScale ?? 5}
                  onChange={(e) => onSetGrid({ gridScale: Math.max(0.5, Number(e.target.value) || 5) })}
                  style={{ width: 56 }}
                />
              </label>
              <label className="flex items-center gap-1 text-muted">
                unit
                <input
                  type="text"
                  maxLength={12}
                  value={gridUnit}
                  onChange={(e) => onSetGrid({ gridUnit: e.target.value })}
                  style={{ width: 48 }}
                />
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={encounter.gridSnap} onChange={(e) => onSetGrid({ gridSnap: e.target.checked })} />
                Snap
              </label>
              <label className="flex items-center gap-1 text-muted">
                type
                <select
                  value={gridType}
                  disabled={!gridOn}
                  onChange={(e) => onSetGrid({ gridType: e.target.value as GridType })}
                  style={{ fontSize: 12 }}
                >
                  <option value="square">square</option>
                  <option value="hex">hex</option>
                </select>
              </label>
              {gridOn && gridType === 'hex' && (
                <label className="flex items-center gap-1 text-muted" title="Pointy-top or flat-top hex orientation">
                  orientation
                  <select
                    value={hexOrientation}
                    onChange={(e) => onSetGrid({ hexOrientation: e.target.value as typeof hexOrientation })}
                    style={{ fontSize: 12 }}
                  >
                    <option value="pointy">pointy-top</option>
                    <option value="flat">flat-top</option>
                  </select>
                </label>
              )}

              {/* Grid calibration (issue #417) — human-readable alignment controls with a
                  keyboard/numeric alternative to the draggable anchors, plus help + reset. */}
              {gridOn && (
                <div
                  data-testid="grid-calibration-controls"
                  className="flex flex-wrap gap-3 items-center"
                  style={{ flexBasis: '100%', paddingTop: 4, borderTop: '1px solid var(--color-divider)', marginTop: 4 }}
                >
                  <p className="text-muted" style={{ flexBasis: '100%', margin: 0, fontSize: 11 }}>
                    Align the overlay to a map that already has a printed grid: use the{' '}
                    <strong>Calibrate</strong> tool to drag the anchors, or set these numbers. Origin
                    moves the grid&rsquo;s top-left corner; cell height differs from width for
                    non-square cells; rotation matches a skewed print; opacity fades the lines.
                  </p>
                  <label className="flex items-center gap-1 text-muted" title="Grid origin, horizontal offset from the map's left edge (percent of map width).">
                    Origin X %
                    <input
                      type="number"
                      aria-label="Grid origin X offset (percent of map width)"
                      min={-100}
                      max={100}
                      step={0.5}
                      value={roundTo(encounter.gridOffsetX ?? 0, 2)}
                      onChange={(e) => onSetGrid({ gridOffsetX: Math.max(-100, Math.min(100, Number(e.target.value) || 0)) })}
                      style={{ width: 60 }}
                    />
                  </label>
                  <label className="flex items-center gap-1 text-muted" title="Grid origin, vertical offset from the map's top edge (percent of map width).">
                    Origin Y %
                    <input
                      type="number"
                      aria-label="Grid origin Y offset (percent of map width)"
                      min={-100}
                      max={100}
                      step={0.5}
                      value={roundTo(encounter.gridOffsetY ?? 0, 2)}
                      onChange={(e) => onSetGrid({ gridOffsetY: Math.max(-100, Math.min(100, Number(e.target.value) || 0)) })}
                      style={{ width: 60 }}
                    />
                  </label>
                  <label className="flex items-center gap-1 text-muted" title="Cell height (percent of map width). Leave blank for square cells equal to the width.">
                    Cell height %
                    <input
                      type="number"
                      aria-label="Cell height (percent of map width); blank for square"
                      min={1}
                      max={100}
                      step={0.5}
                      placeholder="square"
                      value={encounter.gridCellHeight ?? ''}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        onSetGrid({ gridCellHeight: raw === '' ? null : Math.max(1, Math.min(100, Number(raw) || 1)) });
                      }}
                      style={{ width: 66 }}
                    />
                  </label>
                  <label className="flex items-center gap-1 text-muted" title="Rotate the grid to match a skewed printed grid (degrees, -45 to 45).">
                    Rotation°
                    <input
                      type="number"
                      aria-label="Grid rotation in degrees"
                      min={-45}
                      max={45}
                      step={0.5}
                      value={roundTo(encounter.gridRotation ?? 0, 2)}
                      onChange={(e) => onSetGrid({ gridRotation: Math.max(-45, Math.min(45, Number(e.target.value) || 0)) })}
                      style={{ width: 60 }}
                    />
                  </label>
                  <label className="flex items-center gap-1 text-muted" title="Overlay line opacity (0 = invisible, 100 = solid).">
                    Opacity %
                    <input
                      type="number"
                      aria-label="Grid overlay opacity (percent)"
                      min={0}
                      max={100}
                      step={5}
                      value={Math.round((encounter.gridOpacity ?? DEFAULT_GRID_OPACITY) * 100)}
                      onChange={(e) => onSetGrid({ gridOpacity: Math.max(0, Math.min(1, (Number(e.target.value) || 0) / 100)) })}
                      style={{ width: 60 }}
                    />
                  </label>
                  <button
                    type="button"
                    className="cf-map-tool"
                    data-testid="grid-calibration-reset"
                    title="Reset calibration to a top-left, square, unrotated grid"
                    onClick={() =>
                      onSetGrid({
                        gridOffsetX: 0,
                        gridOffsetY: 0,
                        gridCellHeight: null,
                        gridRotation: 0,
                        gridOpacity: DEFAULT_GRID_OPACITY,
                      })
                    }
                  >
                    Reset calibration
                  </button>
                </div>
              )}

              <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--color-divider)' }} />
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={fogOn}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    commitFogEdit(enabled ? { enabled: true, revealed: fog?.revealed ?? [] } : null);
                    if (enabled) {
                      setTool('reveal');
                    }
                  }}
                />
                Fog
              </label>
              <button
                type="button"
                className="cf-map-tool cf-map-tool--compact"
                disabled={!fogOn}
                onClick={() => commitFogEdit({ enabled: true, revealed: [{ x: 0, y: 0, w: 100, h: 100 }] })}
                style={{ cursor: fogOn ? 'pointer' : 'default', opacity: fogOn ? 1 : 0.5 }}
              >
                Reveal all
              </button>
              <button
                type="button"
                className="cf-map-tool cf-map-tool--compact"
                disabled={!fogOn || (fog?.revealed.length ?? 0) === 0}
                onClick={() => commitFogEdit({ enabled: true, revealed: [] })}
                style={{ cursor: fogOn && (fog?.revealed.length ?? 0) > 0 ? 'pointer' : 'default', opacity: fogOn && (fog?.revealed.length ?? 0) > 0 ? 1 : 0.5 }}
              >
                Hide all
              </button>
              <div
                data-testid="map-fog-player-preview"
                className="cf-inset"
                style={{ flexBasis: '100%', padding: '8px 10px', fontSize: 11 }}
              >
                <strong style={{ display: 'block', fontSize: 12 }}>Player fog preview</strong>
                <p className="text-muted" style={{ margin: '2px 0 0' }}>
                  {fogOn
                    ? `Cast/player view shows ${fog?.revealed.length ?? 0} revealed fog region${(fog?.revealed.length ?? 0) === 1 ? '' : 's'}; ${hiddenByFog.length} token${hiddenByFog.length === 1 ? '' : 's'} currently stay hidden by fog.`
                    : 'Fog is off: players and Cast see the full encounter map image with visible placed tokens.'}
                  {' '}
                  Handout reveal is different: it exposes the raw uploaded file with no fog layer.
                </p>
              </div>
            </div>
          )}

          </div>

          {/* Viewport navigation (issue #712) — separate from token/map play tools. */}
          <div
            className="flex flex-wrap gap-2 items-center"
            style={{ padding: isCast ? '0 0 8px' : '8px 14px 0' }}
            data-testid="map-viewport-toolbar"
            role="toolbar"
            aria-label="Map viewport navigation"
          >
            {/* Fog history, with the other viewport-level actions. Proper glyphs rather
                than the bare `↶`/`↷` arrows these carried in the rail. */}
            {isVtt && effectiveCanDmWrite && fogOn && (
              <>
                <button
                  type="button"
                  className="cf-map-tool cf-map-focusable"
                  data-testid="map-fog-undo"
                  title="Undo last fog edit (Ctrl+Z)"
                  aria-label="Undo last fog edit"
                  disabled={!fogUndoUi.canUndo}
                  onClick={undoFogEdit}
                >
                  <GameIcon slug="anticlockwise-rotation" size={14} />
                </button>
                <button
                  type="button"
                  className="cf-map-tool cf-map-focusable"
                  data-testid="map-fog-redo"
                  title="Redo fog edit (Ctrl+Shift+Z)"
                  aria-label="Redo fog edit"
                  disabled={!fogUndoUi.canRedo}
                  onClick={redoFogEdit}
                >
                  <GameIcon slug="clockwise-rotation" size={14} />
                </button>
                <span className="cf-map-toolbar-sep" aria-hidden />
              </>
            )}
            <button
              type="button"
              className="cf-map-tool cf-map-focusable"
              data-testid="map-viewport-pan"
              aria-pressed={viewportPan}
              title="Drag to pan the map (touch: one finger when Pan is on; two fingers to pinch-zoom)"
              onClick={() => setViewportPan((on) => !on)}
              style={{
                borderColor: viewportPan ? 'var(--color-accent)' : 'var(--color-divider)',
                color: viewportPan ? 'var(--color-accent)' : undefined,
              }}
            >
              Pan
            </button>
            <button
              type="button"
              className="cf-map-tool"
              data-testid="map-viewport-zoom-in"
              aria-label="Zoom in"
              title="Zoom in (+)"
              onClick={() => zoomViewportAt(MAP_VIEWPORT_ZOOM_STEP, surfaceW / 2, surfaceH / 2)}
            >
              +
            </button>
            <button
              type="button"
              className="cf-map-tool"
              data-testid="map-viewport-zoom-out"
              aria-label="Zoom out"
              title="Zoom out (−)"
              onClick={() => zoomViewportAt(1 / MAP_VIEWPORT_ZOOM_STEP, surfaceW / 2, surfaceH / 2)}
            >
              −
            </button>
            <button
              type="button"
              className="cf-map-tool"
              data-testid="map-viewport-fit"
              aria-label="Fit map to view"
              title="Fit map to view"
              onClick={() => setViewport(fitViewport())}
            >
              Fit
            </button>
            <button
              type="button"
              className="cf-map-tool"
              data-testid="map-viewport-reset"
              aria-label="Reset viewport"
              title="Reset zoom and pan (0)"
              onClick={() => setViewport(resetViewport())}
            >
              Reset
            </button>
            <span
              className="text-muted"
              data-testid="map-viewport-zoom-label"
              aria-live="polite"
              style={{ fontSize: 11, minWidth: 40 }}
            >
              {formatViewportZoomPercent(viewport.scale)}
            </span>
          </div>

          <div
            ref={surfaceRef}
            data-testid="battle-map-surface"
            className="relative overflow-hidden"
            role={tool === 'ping' ? 'button' : undefined}
            tabIndex={0}
            aria-label={
              tool === 'ping'
                ? // Issue #2047 review: the whole sentence resolves from one key rather than
                  // interpolating a translated hint into an English template. That template
                  // shape is the exact defect #2048 fixed one file over and #2053 tracks —
                  // an Arabic screen-reader user would otherwise hear an English label with
                  // a single Arabic sentence embedded in it.
                  t('encounters.map.ping.surfaceAriaLabel', { hint: t('encounters.map.ping.keyboardHint') })
                : 'Battle map viewport. +/− to zoom, 0 to reset, arrow keys to pan when zoomed.'
            }
            aria-describedby="map-keyboard-help"
            style={{
              // Cast and the cockpit both hand the surface a fixed box to fill, so the
              // 16:9 reservation the card layout needs would fight it.
              margin: isCast || isVtt ? 0 : '8px 14px',
              aspectRatio: isCast || isVtt ? undefined : '16 / 9',
              flex: isCast || isVtt ? '1 1 auto' : undefined,
              minHeight: isCast || isVtt ? 0 : undefined,
              touchAction:
                viewportPan || viewport.scale > 1
                  ? 'none'
                  : tool !== 'move' || draggingId != null || aoeDrag != null
                    ? 'none'
                    : undefined,
              userSelect: tool !== 'move' || draggingId != null || aoeDrag != null || viewportPan ? 'none' : undefined,
              cursor: viewportPan
                ? 'grab'
                : tool === 'measure'
                  ? 'crosshair'
                  : tool === 'reveal' || tool === 'erase'
                    ? 'cell'
                    : tool === 'select'
                      ? 'pointer'
                    : tool === 'ping'
                      ? 'pointer'
                      : undefined,
            }}
            onPointerDown={onSurfacePointerDown}
            onPointerMove={onSurfacePointerMove}
            onPointerUp={onSurfacePointerUp}
            onPointerCancel={onSurfacePointerCancel}
            onLostPointerCapture={onSurfaceLostPointerCapture}
            onKeyDown={onViewportKeyDown}
            onContextMenu={onSurfaceContextMenu}
            onDragStart={(e) => e.preventDefault()}
          >
            <div
              data-testid="battle-map-viewport"
              className="absolute inset-0"
              style={{
                transform: viewportTransformStyle(viewport),
                transformOrigin: '0 0',
              }}
            >
            <img
              src={mapImageUrl}
              srcSet={mapSrcSet}
              sizes={mapSrcSet ? '100vw' : undefined}
              alt="Battle map"
              draggable={false}
              className="absolute inset-0 w-full h-full object-contain"
              style={{ background: 'rgba(15,23,42,.4)' }}
              onLoad={(e) => setImgNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            />

            {/* Map layer (issue #464): every interactive/visual tool is positioned in the
                object-contain image rect. Percents are relative to this layer (matching the
                server fog renderer), so letterbox bands never receive tokens or grid ink. */}
            {mapRect && (
              <div
                data-testid="battle-map-layer"
                className="absolute overflow-hidden"
                style={{
                  left: mapRect.left,
                  top: mapRect.top,
                  width: mapRect.width,
                  height: mapRect.height,
                  // Surface owns pointer gestures; children opt in (tokens/AoE handles).
                  pointerEvents: 'none',
                }}
              >
                {/* Grid overlay (issue #40 / #238 / #417) — a calibrated square grid (origin
                    offset, independent cell w/h, rotation, opacity via an SVG pattern) or a
                    pointy-top hex SVG. The pattern honours the SAME calibration as snapping +
                    the ruler, so the overlay a player sees matches the DM's exactly. Extracted
                    into its own memoized component (issue #1917 stage 2) whose props are
                    geometry inputs only, so a token drag or an unrelated HP/roster update never
                    re-renders this subtree — see `gridOverlayOpacity` above for why that stays a
                    primitive derived value rather than reading `encounter` here. */}
                <GridOverlay
                  gridOn={gridOn}
                  gridType={gridType}
                  mapRect={mapRect}
                  calibrationPx={calibrationPx}
                  hexOrientation={hexOrientation}
                  hexCells={hexCells}
                  opacity={gridOverlayOpacity}
                  encounterId={encounter.id}
                />

                {/* Persistent map icons/set pieces (issue #1308) — read-only; place/move/label/
                    delete happen through the "Set pieces" DM panel, not by dragging this layer.
                    `encounter.mapObjects` is already server-redacted (a dmOnly object is dropped
                    wholesale for a non-DM before this component ever sees it).
                    `?? []` matches every other read of a `.default([])`-backed encounter list in
                    this file (see `encounter.aoe ?? []` at :1001/:2219/:2333/:2344) — a real
                    server response always sends the array, but a hand-built encounter object
                    (the Cast projection's `safeEncounterForCast`, or a test fixture) can predate
                    a newly added field and arrive without the key at all (review: PR #2174,
                    `player-display-cast-session.spec.ts` — a missing array threw inside this
                    overlay and took the whole map scene down with it, since BattleMap has no
                    error boundary of its own). */}
                <MapObjectsOverlay mapObjects={encounter.mapObjects ?? []} mapRect={mapRect} />

                {/* Calibration anchors (issue #417) — DM-only, only in the Calibrate tool.
                    Drag the origin anchor to a corner of the map's printed grid, then drag the
                    cell anchor to the opposite corner of ONE printed cell. The overlay previews
                    live off `calibration` (which already folds in the active drag). */}
                {effectiveCanDmWrite && tool === 'calibrate' && calibrationPx && (() => {
                  const rad = calibrationPx.rotationRad;
                  const cos = Math.cos(rad);
                  const sin = Math.sin(rad);
                  const originX = calibrationPx.originXpx;
                  const originY = calibrationPx.originYpx;
                  const cellX = originX + calibrationPx.cellWpx * cos - calibrationPx.cellHpx * sin;
                  const cellY = originY + calibrationPx.cellWpx * sin + calibrationPx.cellHpx * cos;
                  const anchor = (
                    key: CalibrateAnchor,
                    x: number,
                    y: number,
                    color: string,
                    label: string,
                  ) => (
                    <div
                      key={key}
                      data-testid={`grid-calibrate-anchor-${key}`}
                      role="button"
                      aria-label={label}
                      title={label}
                      className="absolute -translate-x-1/2 -translate-y-1/2"
                      style={{
                        left: x,
                        top: y,
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        background: color,
                        border: '2px solid rgba(15,23,42,.9)',
                        boxShadow: '0 1px 4px rgba(0,0,0,.6)',
                        pointerEvents: 'auto',
                        cursor: 'grab',
                        touchAction: 'none',
                        zIndex: 9,
                      }}
                      onPointerDown={(e) => onCalibrateAnchorPointerDown(e, key)}
                    />
                  );
                  return (
                    <>
                      {anchor('origin', originX, originY, 'var(--color-accent)', 'Grid origin anchor — drag to a printed grid corner')}
                      {anchor('cell', cellX, cellY, 'rgba(239,68,68,.95)', 'Grid cell anchor — drag to one cell away')}
                    </>
                  );
                })()}

                {targeting && (() => {
                  const actor = placed.find((combatant) => combatant.id === targeting.actorId);
                  if (!actor || actor.tokenX == null || actor.tokenY == null) return null;
                  const actorX = actor.tokenX;
                  const actorY = actor.tokenY;
                  return (
                    <svg data-testid="map-target-lines" className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ pointerEvents: 'none', zIndex: 1 }}>
                      {targeting.selectedIds.map((targetId) => {
                        const target = placed.find((combatant) => combatant.id === targetId);
                        if (!target || target.tokenX == null || target.tokenY == null) return null;
                        const targetX = target.tokenX;
                        const targetY = target.tokenY;
                        return <line key={targetId} data-testid={`map-target-line-${targetId}`} x1={actorX} y1={actorY} x2={targetX} y2={targetY} stroke="var(--color-accent)" strokeWidth={2} opacity="0.6" strokeDasharray={targeting.declared ? '1.2 0.8' : undefined} vectorEffect="non-scaling-stroke" />;
                      })}
                    </svg>
                  );
                })()}

                {placed.map((c) => {
                  const feedback = hpFeedbackByCombatant.get(c.id) ?? [];
                  const feedbackClass = feedback.some((event) => event.kind === 'down')
                    ? ' cf-hp-feedback-anchor--down'
                    : feedback.some((event) => event.kind === 'revive')
                      ? ' cf-hp-feedback-anchor--revive'
                      : feedback.some((event) => event.crit)
                        ? ' cf-hp-feedback-anchor--crit'
                        : '';
                  // Issue #1917 stage 3: `draggingId` and the live drag position are always set
                  // and cleared together in the same state update (see `onTokenPointerDown` /
                  // `clearGesturePreview`), so this stays exactly equivalent to the old
                  // `draggingId === c.id && dragPos != null` — but no longer reads the removed
                  // `dragPos` React state, which is what let it move into `MapTokenSlot` below.
                  const isDragging = draggingId === c.id;
                  const movable = tool === 'move' && !viewportPan && effectiveCanMoveToken(c);
                  const isCharacter = c.kind === 'character';
                  const sizePx =
                    gridOn && gridType === 'hex' && cellPx > 0
                      ? Math.round(tokenFootprintDiameterPx(c.tokenSize, cellPx, hexOrientation))
                      : tokenDiameterPx({
                          tokenSize: c.tokenSize,
                          cellPx,
                          gridType,
                        });
                  const selectedForBatch = selectedTokenIds.has(c.id);
                  const legalTarget = targeting?.legalIds.includes(c.id) ?? false;
                  const selectedTarget = targeting?.selectedIds.includes(c.id) ?? false;
                  const targetAvailable = selectedTarget || !targeting?.atCapacity;
                  // Map gestures retain precedence outside move mode, and movable tokens keep
                  // their drag behavior.
                  const targetClickable = legalTarget && targetAvailable && !targeting?.declared && tool === 'move' && !viewportPan && !movable;
                  const impactTarget = !reducedMotion && impactTargetIds.includes(c.id);
                  const tokenLabel = `${c.name}${c.tokenSize !== 'medium' ? ` (${c.tokenSize})` : ''}${isCharacter ? ', player character' : ''} token${selectedTarget ? ', target selected' : selectedForBatch ? ', selected' : ''}`;
                  const hpFraction = tokenHpFraction(c);
                  const hpTone = tokenHpTone(hpFraction);
                  const arc = tokenArcGeometry(sizePx);
                  const deathMarker = tokenDeathMarker(c);
                  const showTokenState = tokenDetailMode !== 'off';
                  const showExtendedTokenState = tokenDetailMode === 'full';
                  const conditionControlCapacity = Math.max(1, Math.min(3, Math.floor(sizePx / 18)));
                  const conditionBadges = showExtendedTokenState ? tokenConditionBadges(c.conditions, conditionControlCapacity) : { visible: [], overflow: 0 };
                  const conditionControlCount = conditionBadges.visible.length + (conditionBadges.overflow > 0 ? 1 : 0);
                  const conditionPlacements = tokenBadgePlacements(sizePx, conditionControlCount);
                  const conditionOverflowPlacement = conditionPlacements.at(-1);
                  // In map tools other than Move, the surface owns pointer gestures.
                  // The cast projection has no roster to focus, and a small token
                  // keeps its centre free for drag/selection instead of exposing a
                  // sub-18px detail control.
                  const conditionDetailsInteractive =
                    !isCast && tool === 'move' && !viewportPan && conditionPlacements.every((placement) => placement.targetSize >= 18);
                  const hasConcentration = showExtendedTokenState && !!c.turnState?.concentration;
                  const isCurrentTurn = showTokenState && encounter.status === 'running' && encounter.currentCombatantId === c.id;
                  return (
                    <MapTokenSlot
                      key={c.id}
                      combatantId={c.id}
                      isDragging={isDragging}
                      restLeft={c.tokenX ?? 0}
                      restTop={c.tokenY ?? 0}
                      restOpacity={targeting && (!legalTarget || !targetAvailable) ? 0.6 : 1}
                      dragPosStore={dragPosStore}
                      dataTestId={`map-token-${c.id}`}
                      role="button"
                      tabIndex={movable || targetClickable ? 0 : -1}
                      ariaLabel={tokenLabel}
                      ariaPressed={legalTarget ? selectedTarget : undefined}
                      ariaDisabled={legalTarget && !targetAvailable ? true : undefined}
                      ariaDescribedby="map-keyboard-help"
                      ariaKeyshortcuts={movable ? 'ArrowUp ArrowDown ArrowLeft ArrowRight Delete Backspace' : undefined}
                      className="absolute -translate-x-1/2 -translate-y-1/2 cf-map-focusable"
                      // In measure/reveal mode tokens must not eat the surface drag.
                      pointerEvents={movable || targetClickable ? 'auto' : 'none'}
                      cursor={movable ? 'grab' : 'default'}
                      outline={selectedTarget ? '3px solid var(--color-accent)' : legalTarget && targetAvailable && !targeting?.declared ? '2px solid white' : selectedForBatch ? '3px solid var(--color-accent)' : undefined}
                      onPointerDown={(e) => {
                        if (targetClickable && e.isPrimary) {
                          e.stopPropagation();
                          return;
                        }
                        onTokenPointerDown(e, c);
                      }}
                      onClick={(event) => {
                        const targetGesture = targetGestureRef.current;
                        if (targetGesture?.tokenId === c.id) {
                          targetGestureRef.current = null;
                          if (!targetGesture.moved && legalTarget && targetAvailable) {
                            event.stopPropagation();
                            targeting?.onToggle(c.id);
                          }
                          return;
                        }
                        if (targetClickable) event.stopPropagation();
                        // A drag ends with a click; only a stationary token tap may select.
                        if (targetClickable && !isDragging) targeting?.onToggle(c.id);
                      }}
                      onKeyDown={(e) => {
                        if (legalTarget && targetAvailable && !targeting?.declared && !e.repeat && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          e.stopPropagation();
                          targeting?.onToggle(c.id);
                          return;
                        }
                        if (movable) onTokenKeyDown(e, c);
                      }}
                      onFocus={(e) => {
                        if (movable) setSelectedTokenId(c.id);
                        e.currentTarget.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest', inline: 'nearest' });
                      }}
                    >
                      <div
                        className={`cf-hp-feedback-anchor${feedbackClass}`}
                        style={{ position: 'relative', width: sizePx, height: sizePx }}
                      >
                        <FloatingNumbers events={feedback} />
                        <span
                          style={{
                            display: 'grid', placeItems: 'center', width: sizePx, height: sizePx, borderRadius: '50%',
                            fontSize: Math.max(9, Math.round(sizePx * 0.34)), fontWeight: 700, color: '#fff',
                            background: tokenIdentityBackground(c), border: '2px solid rgba(15,23,42,.85)',
                            boxShadow: '0 1px 3px rgba(0,0,0,.5)',
                            filter: showTokenState && deathMarker === 'dead' ? 'grayscale(1)' : undefined,
                            opacity: showTokenState && deathMarker === 'dead' ? 0.58 : undefined, pointerEvents: 'none',
                          }}
                        >
                          {tokenInitials(c.name)}
                        </span>
                        {colorVisionAssist && (
                          <span
                            data-testid={`map-token-identity-shape-${c.id}`}
                            data-token-shape={tokenIdentityShape(c.id)}
                            aria-hidden="true"
                            style={{
                              position: 'absolute',
                              right: 0,
                              bottom: 0,
                              width: Math.max(6, Math.round(sizePx * 0.24)),
                              height: Math.max(6, Math.round(sizePx * 0.24)),
                              background: '#fff',
                              clipPath: TOKEN_IDENTITY_SHAPE_CLIP_PATH[tokenIdentityShape(c.id)],
                              boxShadow: '0 0 0 1px rgba(15,23,42,.85)',
                              pointerEvents: 'none',
                            }}
                          />
                        )}
                        {selectedTarget && <span aria-hidden="true" data-testid={`map-target-crosshair-${c.id}`} style={{ position: 'absolute', inset: -7, display: 'grid', placeItems: 'center', color: 'var(--color-accent)', fontSize: Math.max(14, Math.round(sizePx * .45)), pointerEvents: 'none' }}>⌖</span>}
                        {impactTarget && <span aria-hidden="true" data-testid={`map-target-impact-${c.id}`} className="cf-target-impact-ring" />}
                        {showTokenState && hpFraction != null && hpTone != null && (
                          <svg data-testid={`map-token-hp-arc-${c.id}`} width={sizePx} height={sizePx} viewBox={`0 0 ${sizePx} ${sizePx}`}
                            aria-label={t('encounters.map.tokenDetails.hp', { state: t(`encounters.map.tokenDetails.hpStates.${hpTone}`) })}
                            role="img" style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none', transform: 'rotate(-90deg)' }}>
                            <circle cx={sizePx / 2} cy={sizePx / 2} r={arc.radius} fill="none" stroke="rgba(15,23,42,.58)" strokeWidth={arc.strokeWidth} />
                            <circle cx={sizePx / 2} cy={sizePx / 2} r={arc.radius} fill="none"
                              stroke={hpTone === 'healthy' ? '#22c55e' : hpTone === 'bloodied' ? '#f59e0b' : '#ef4444'} strokeWidth={arc.strokeWidth}
                              strokeLinecap="round" strokeDasharray={arc.circumference} strokeDashoffset={arc.circumference * (1 - hpFraction)} />
                          </svg>
                        )}
                        {isCurrentTurn && (
                          <span data-testid={`map-token-current-turn-${c.id}`} aria-label={t('encounters.map.tokenDetails.currentTurn')} role="img"
                            className={reducedMotion ? undefined : 'cf-token-state-pulse'}
                            style={{ position: 'absolute', inset: -4, border: '2px solid var(--color-accent)', borderRadius: '50%', pointerEvents: 'none' }} />
                        )}
                        {isCurrentTurn && colorVisionAssist && (
                          <span
                            data-testid={`map-token-turn-chevron-${c.id}`}
                            aria-hidden="true"
                            style={{
                              position: 'absolute',
                              top: -14,
                              left: '50%',
                              transform: 'translateX(-50%)',
                              color: 'var(--color-accent)',
                              fontSize: Math.max(10, Math.round(sizePx * 0.3)),
                              lineHeight: 1,
                              pointerEvents: 'none',
                            }}
                          >
                            ▾
                          </span>
                        )}
                        {showTokenState && deathMarker && (
                          <span data-testid={`map-token-death-${c.id}`} aria-label={t(`encounters.map.tokenDetails.${deathMarker}`)} role="img"
                            className={deathMarker === 'dying' && !reducedMotion ? 'cf-token-state-pulse' : undefined}
                            style={{ position: 'absolute', inset: deathMarker === 'dying' ? -2 : 0, display: 'grid', placeItems: 'center', border: deathMarker === 'dying' ? '2px solid #ef4444' : undefined, borderRadius: '50%', color: '#fff', pointerEvents: 'none' }}>
                            <GameIcon slug="death-skull" size={Math.max(12, Math.round(sizePx * 0.42))} />
                          </span>
                        )}
                        {hasConcentration && (
                          <span data-testid={`map-token-concentration-${c.id}`} aria-label={t('encounters.map.tokenDetails.concentration', { effect: c.turnState?.concentration })} role="img"
                            style={{ position: 'absolute', left: -5, top: -5, display: 'grid', placeItems: 'center', width: Math.max(16, Math.round(sizePx * 0.42)), height: Math.max(16, Math.round(sizePx * 0.42)), borderRadius: '50%', background: 'rgba(49,46,129,.94)', color: '#fff', border: '1px solid rgba(255,255,255,.75)', pointerEvents: 'none' }}>
                            <GameIcon slug="spiral-shell" size={Math.max(12, Math.round(sizePx * 0.28))} />
                          </span>
                        )}
                        {(conditionBadges.visible.length > 0 || conditionBadges.overflow > 0) && (
                          <span style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1 }}>
                            {conditionBadges.visible.map((badge, index) => {
                              const placement = conditionPlacements[index];
                              if (!placement) return null;
                              // Issue #2053 — `badge.condition` is the adapter-declared condition
                              // name (or a DM-typed custom one); translate for display, falling
                              // back to the name itself when there's no catalog entry.
                              const conditionLabel = adapterConditionLabel(t, badge.condition);
                              return (
                                <button key={badge.condition} type="button" data-testid={`map-token-condition-${c.id}-${index}`}
                                  tabIndex={conditionDetailsInteractive ? 0 : -1}
                                  aria-label={t('encounters.map.tokenDetails.conditions', { name: c.name, conditions: conditionLabel })} title={conditionLabel}
                                  onPointerDown={conditionDetailsInteractive ? (event) => { event.preventDefault(); event.stopPropagation(); } : undefined}
                                  onKeyDown={(event) => event.stopPropagation()}
                                  onClick={(event) => { if (!conditionDetailsInteractive) return; event.stopPropagation(); focusTokenConditionDetails(c.id); }}
                                  style={{ position: 'absolute', left: `${placement.left}%`, top: `${placement.top}%`, transform: 'translate(-50%, -50%)', width: placement.targetSize, height: placement.targetSize, display: 'grid', placeItems: 'center', padding: 0, border: 0, background: 'transparent', color: '#fff', cursor: 'pointer', pointerEvents: conditionDetailsInteractive ? 'auto' : 'none' }}>
                                  <span aria-hidden="true" style={{ width: placement.visualSize, height: placement.visualSize, display: 'grid', placeItems: 'center', borderRadius: '50%', background: 'rgba(15,23,42,.92)', border: '1px solid rgba(255,255,255,.78)', fontSize: Math.max(9, Math.round(placement.visualSize * 0.72)), lineHeight: 1 }}>
                                    {badge.glyph ? <GameIcon slug={badge.glyph} size={Math.max(10, placement.visualSize - 3)} fallback={badge.fallback} /> : badge.fallback}
                                  </span>
                                </button>
                              );
                            })}
                            {conditionBadges.overflow > 0 && conditionOverflowPlacement && (
                              <button type="button" data-testid={`map-token-condition-overflow-${c.id}`} tabIndex={conditionDetailsInteractive ? 0 : -1}
                                aria-label={t('encounters.map.tokenDetails.moreConditions', { name: c.name, count: conditionBadges.overflow })} title={t('encounters.map.tokenDetails.moreConditions', { name: c.name, count: conditionBadges.overflow })}
                                onPointerDown={conditionDetailsInteractive ? (event) => { event.preventDefault(); event.stopPropagation(); } : undefined}
                                onKeyDown={(event) => event.stopPropagation()}
                                onClick={(event) => { if (!conditionDetailsInteractive) return; event.stopPropagation(); focusTokenConditionDetails(c.id); }}
                                style={{ position: 'absolute', left: `${conditionOverflowPlacement.left}%`, top: `${conditionOverflowPlacement.top}%`, transform: 'translate(-50%, -50%)', width: conditionOverflowPlacement.targetSize, height: conditionOverflowPlacement.targetSize, display: 'grid', placeItems: 'center', padding: 0, borderRadius: '50%', border: '1px solid rgba(255,255,255,.78)', background: 'rgba(15,23,42,.92)', color: '#fff', fontSize: 9, fontWeight: 700, cursor: 'pointer', pointerEvents: conditionDetailsInteractive ? 'auto' : 'none' }}>
                                +{conditionBadges.overflow}
                              </button>
                            )}
                          </span>
                        )}
                      </div>
                      {/* Unplace control (issue #271): remove the token from the board without
                          deleting the combatant. Only offered to whoever may move this token, and
                          only in move mode. stopPropagation on pointer-down so tapping it never
                          starts a token drag. */}
                      {movable && (
                        <button
                          type="button"
                          aria-label={`Remove ${c.name} from the map`}
                          title="Remove from map"
                          tabIndex={0}
                          disabled={busy}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedTokenId(null);
                            onUnplaceToken(c.id);
                          }}
                          onFocus={() => setSelectedTokenId(c.id)}
                          style={{
                            position: 'absolute',
                            top: -6,
                            right: -6,
                            width: 16,
                            height: 16,
                            display: 'grid',
                            placeItems: 'center',
                            padding: 0,
                            borderRadius: '50%',
                            border: '1px solid rgba(15,23,42,.85)',
                            background: 'var(--color-danger, #b91c1c)',
                            color: '#fff',
                            lineHeight: 1,
                            cursor: busy ? 'default' : 'pointer',
                            zIndex: 3,
                          }}
                        >
                          <UIIcon name="close" size="xs" />
                        </button>
                      )}
                    </MapTokenSlot>
                  );
                })}

                {/* Shared AoE templates (issue #238) — drawn in map-layer pixel space. */}
                {canAoe && aoeTemplates.length > 0 && (
                  <svg
                    className="absolute inset-0"
                    style={{ zIndex: 6 }}
                    width={mapRect.width}
                    height={mapRect.height}
                  >
                    {aoeTemplates.map((t) => {
                      const drag = aoeDrag && aoeDrag.id === t.id ? aoeDrag : null;
                      const { x: ox, y: oy } = mapPercentToLayerPx(
                        { x: drag ? drag.x : t.x, y: drag ? drag.y : t.y },
                        mapRect,
                      );
                      const lengthPx = (t.sizeFt / gridScale!) * cellPx;
                      if (lengthPx <= 0) return null;
                      const selected = t.id === selectedAoeId;
                      const playerDeclared = t.declaredByUserId != null;
                      const stroke = selected ? 'rgba(56,189,248,.95)' : playerDeclared ? 'rgba(99,102,241,.9)' : 'rgba(239,68,68,.8)';
                      const fill = selected ? 'rgba(56,189,248,.18)' : 'rgba(239,68,68,.20)';
                      if (t.shape === 'circle') {
                        if (gridType === 'hex' && calibrationPx) {
                          const radiusCells = t.sizeFt / gridScale!;
                          const hexPolys = hexAoeCirclePolygons({ x: ox, y: oy }, radiusCells, calibrationPx, hexOrientation);
                          return (
                            <g key={t.id}>
                              {hexPolys.map((pts, i) => (
                                <polygon key={i} points={pts} fill={fill} stroke={stroke} strokeWidth={2} strokeDasharray={playerDeclared ? '6 4' : undefined} />
                              ))}
                            </g>
                          );
                        }
                        return <circle key={t.id} data-testid={`map-aoe-shape-${t.id}`} cx={ox} cy={oy} r={lengthPx} fill={fill} stroke={stroke} strokeWidth={2} strokeDasharray={playerDeclared ? '6 4' : undefined} />;
                      }
                      const pts = aoePolygonPoints(t.shape, ox, oy, lengthPx, (t.angleDeg * Math.PI) / 180, cellPx);
                      return <polygon key={t.id} data-testid={`map-aoe-shape-${t.id}`} points={pts} fill={fill} stroke={stroke} strokeWidth={2} strokeDasharray={playerDeclared ? '6 4' : undefined} />;
                    })}
                  </svg>
                )}
                {(effectiveCanDmWrite || effectiveCanDeclareAoe) && canAoe &&
                  aoeTemplates.filter((template) => canEditAoe(template)).map((template) => {
                    const drag = aoeDrag && aoeDrag.id === template.id ? aoeDrag : null;
                    const x = drag ? drag.x : template.x;
                    const y = drag ? drag.y : template.y;
                    const declarerName = template.declaredByUserId == null ? null : (aoeDeclarerNames.get(template.declaredByUserId) ?? template.declaredByUserId);
                    const aoeLabel = `${template.shape} template · ${template.sizeFt} ${gridUnit}${template.shape !== 'circle' ? ` · ${template.angleDeg}°` : ''}${declarerName ? ` · ${t('encounters.map.aoe.declaredBy', { name: declarerName })}` : ''}`;
                    return (
                      <div
                        key={template.id}
                        data-testid={`map-aoe-${template.id}`}
                        role="button"
                        tabIndex={tool === 'move' && canEditAoe(template) ? 0 : -1}
                        aria-label={aoeLabel}
                        aria-describedby="map-keyboard-help"
                        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Delete Backspace"
                        className="absolute -translate-x-1/2 -translate-y-1/2 cf-map-focusable"
                        style={{
                          left: `${x}%`,
                          top: `${y}%`,
                          width: 14,
                          height: 14,
                          borderRadius: '50%',
                          background: template.id === selectedAoeId ? 'var(--color-accent)' : 'rgba(239,68,68,.9)',
                          border: '2px solid rgba(15,23,42,.85)',
                          // Only grab the pointer in move mode, so reveal/measure drags pass through.
                          pointerEvents: tool === 'move' && !viewportPan && canEditAoe(template) ? 'auto' : 'none',
                          cursor: 'grab',
                          touchAction: 'none',
                          zIndex: 7,
                        }}
                        onPointerDown={(e) => onAoeHandlePointerDown(e, template)}
                        onKeyDown={(e) => onAoeHandleKeyDown(e, template)}
                        onFocus={() => setSelectedAoeId(template.id)}
                        title={`${aoeLabel} — drag to move, click to edit`}
                      />
                    );
                  })}

                {/* Fog of war (issue #40). Percents match the image / server fog renderer. */}
                {fogOn && (
                  <svg
                    className="absolute inset-0 w-full h-full"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    style={{ zIndex: 4 }}
                  >
                    <defs>
                      <mask id={`fogmask-${encounter.id}`}>
                        <rect x={0} y={0} width={100} height={100} fill="#fff" />
                        {(displayedFogRects ?? []).map((r, i) => (
                          <rect key={r.id ?? i} x={r.x} y={r.y} width={r.w} height={r.h} fill="#000" />
                        ))}
                      </mask>
                    </defs>
                    <rect x={0} y={0} width={100} height={100} fill="#0b1120" opacity={effectiveIsDm ? 0.45 : 0.97} mask={`url(#fogmask-${encounter.id})`} />
                  </svg>
                )}

                {/* In-progress reveal/erase rectangle (DM). */}
                {revealPreview && (
                  <div
                    className="absolute"
                    data-testid="map-fog-preview"
                    style={{
                      left: `${revealPreview.x}%`,
                      top: `${revealPreview.y}%`,
                      width: `${revealPreview.w}%`,
                      height: `${revealPreview.h}%`,
                      border: `2px dashed ${fogBrushMode === 'erase' ? 'var(--color-danger, #f87171)' : 'var(--color-accent)'}`,
                      background: fogBrushMode === 'erase' ? 'rgba(248,113,113,.12)' : 'rgba(56,189,248,.12)',
                      zIndex: 8,
                    }}
                  />
                )}
                {tokenSelectionRect && (() => {
                  const left = Math.min(tokenSelectionRect.start.x, tokenSelectionRect.end.x);
                  const top = Math.min(tokenSelectionRect.start.y, tokenSelectionRect.end.y);
                  return <div data-testid="map-token-selection-rect" className="absolute" style={{ left: `${left}%`, top: `${top}%`, width: `${Math.abs(tokenSelectionRect.end.x - tokenSelectionRect.start.x)}%`, height: `${Math.abs(tokenSelectionRect.end.y - tokenSelectionRect.start.y)}%`, border: '2px dashed var(--color-accent)', background: 'rgba(56,189,248,.12)', pointerEvents: 'none', zIndex: 11 }} />;
                })()}
                {tokenLasso && tokenLasso.length > 1 && <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ pointerEvents: 'none', zIndex: 11 }}><polyline data-testid="map-token-selection-lasso" points={tokenLasso.map(p => `${p.x},${p.y}`).join(' ')} fill="rgba(56,189,248,.12)" stroke="var(--color-accent)" strokeWidth="0.35" vectorEffect="non-scaling-stroke" /></svg>}

                {selectedFogRegionId && fogOn && (
                  (() => {
                    const r = displayedFogRects.find((rect) => rect.id === selectedFogRegionId);
                    if (!r) return null;
                    return (
                      <div
                        className="absolute"
                        data-testid="map-fog-region-selected"
                        style={{
                          left: `${r.x}%`,
                          top: `${r.y}%`,
                          width: `${r.w}%`,
                          height: `${r.h}%`,
                          border: '2px solid var(--color-accent)',
                          boxShadow: '0 0 0 1px rgba(15,23,42,.6)',
                          pointerEvents: 'none',
                          zIndex: 8,
                        }}
                      />
                    );
                  })()
                )}

                {/* Measurement ruler (issue #40). */}
                {ruler && canMeasure && (
                  <>
                    <svg className="absolute inset-0 w-full h-full" style={{ zIndex: 7 }}>
                      <line
                        data-testid="map-ruler-line"
                        x1={`${ruler.start.x}%`}
                        y1={`${ruler.start.y}%`}
                        x2={`${ruler.end.x}%`}
                        y2={`${ruler.end.y}%`}
                        stroke="var(--color-accent)"
                        strokeWidth={2}
                        strokeDasharray="5 4"
                      />
                    </svg>
                    {rulerReadout && (
                      <div
                        className="absolute"
                        style={{
                          left: `${ruler.end.x}%`,
                          top: `${ruler.end.y}%`,
                          transform: 'translate(8px, 8px)',
                          background: 'rgba(15,23,42,.9)',
                          color: '#fff',
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '2px 6px',
                          borderRadius: 4,
                          whiteSpace: 'nowrap',
                          zIndex: 9,
                        }}
                      >
                        {formatRulerReadout(
                          {
                            cells: rulerReadout.cells,
                            scale: gridScale ?? 0,
                            gridUnit,
                            gridType,
                          },
                          'display',
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* Live token-drag distance readout (issue #1911): same measurement path as the
                    ruler above, plus the current actor's movement budget when the viewer may see
                    it. Extracted (issue #1917 stage 3) so its own `useSyncExternalStore`
                    subscription to `dragPosStore` re-renders only this overlay per drag frame. */}
                <DragDistanceOverlay
                  dragPosStore={dragPosStore}
                  draggingId={draggingId}
                  keyboardDrag={keyboardDrag}
                  combatants={encounter.combatants}
                  canMeasure={canMeasure}
                  mapRect={mapRect}
                  cellPx={cellPx}
                  gridType={gridType}
                  calibration={calibration}
                  hexOrientation={hexOrientation}
                  gridDistanceRule={gridDistanceRule}
                  gridScale={gridScale}
                  gridUnit={gridUnit}
                  currentTurnMovementMaxFt={currentTurnMovementMaxFt}
                  encounterStatus={encounter.status}
                  currentTurnCombatantId={currentTurnCombatantId}
                />

                {/* Live pings (issue #238) — a short expanding pulse everyone at the table sees. */}
                {pings.map((p) => {
                  const isReduced = prefersReducedMotion();
                  const color = p.color || 'var(--color-accent)';
                  // Issue #1937: an intent-labeled ping (chosen from the long-press/right-click
                  // menu) shows its icon + label above the ripple for the ping's whole lifetime.
                  const intentIcon = pingIntentIconForLabel(p.label);
                  return (
                    <div
                      key={p.key}
                      className="absolute z-10 flex flex-col items-center justify-center pointer-events-none"
                      style={{
                        left: `${p.x}%`,
                        top: `${p.y}%`,
                        transform: 'translate(-50%, -50%)',
                      }}
                    >
                      {p.label && (
                        <div
                          className="mb-1 px-1.5 py-0.5 rounded text-xs whitespace-nowrap bg-surface-raised font-semibold shadow-sm flex items-center gap-1"
                          style={{ color: 'var(--color-text)', border: `1px solid ${color}` }}
                        >
                          {intentIcon && <GameIcon slug={intentIcon} size={UI_ICON_SIZE.xs} />}
                          <span>{p.label}</span>
                        </div>
                      )}
                      <div className="relative flex items-center justify-center" style={{ width: 24, height: 24 }}>
                        {!isReduced && (
                          <div
                            className="absolute inset-0"
                            style={{
                              borderRadius: '50%',
                              border: `3px solid ${color}`,
                              animation: 'cfPing 2.4s ease-out forwards',
                            }}
                          />
                        )}
                        <div
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: '50%',
                            backgroundColor: color,
                            boxShadow: '0 0 4px rgba(0,0,0,0.5)',
                            border: '1px solid white', // high contrast
                          }}
                        />
                      </div>
                      {p.senderName && (
                        <div className="mt-1 px-1 rounded text-xs whitespace-nowrap bg-surface-raised font-semibold shadow-sm" style={{ color: 'var(--color-text)', border: `1px solid ${color}` }}>
                          {p.senderName}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Ping Log */}
            {pings.length > 0 && (
              <div className="absolute top-2 left-2 flex flex-col gap-1 z-20 pointer-events-none" style={{ maxWidth: 200 }}>
                {pings.slice().reverse().map((p) => {
                  const intentIcon = pingIntentIconForLabel(p.label);
                  const senderName = p.senderName || t('encounters.map.ping.log.unknownSender');
                  return (
                    <div key={p.key} className="bg-surface border py-1 px-2 text-xs rounded shadow-sm flex items-center justify-between pointer-events-auto" style={{ borderColor: p.color || 'var(--color-accent)' }}>
                      <span className="truncate mr-2 font-medium flex items-center gap-1">
                        {intentIcon && <GameIcon slug={intentIcon} size={UI_ICON_SIZE.xs} />}
                        {p.label
                          ? t('encounters.map.ping.log.labeled', { name: senderName, label: p.label })
                          : t('encounters.map.ping.log.plain', { name: senderName })}
                      </span>
                      <button type="button" className="text-muted hover:text-default flex-none" onClick={(e) => { e.stopPropagation(); onDismissPing(p.key); }} aria-label="Dismiss ping">
                        <GameIcon slug="cross-mark" size={UI_ICON_SIZE.xs} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            </div>
            <style>{'@keyframes cfPing{0%{transform:scale(.4);opacity:.9}70%{opacity:.55}100%{transform:scale(3);opacity:0}}'}</style>
          </div>

          {/* Ping intent menu (issue #1937) — long-press or right-click with Ping armed. */}
          {pingIntentMenu && createPortal(
            <div
              role="menu"
              aria-label={t('encounters.map.ping.menuLabel')}
              data-testid="map-ping-intent-menu"
              className="cf-popover"
              style={{
                position: 'fixed',
                left: pingIntentMenu.clientX,
                top: pingIntentMenu.clientY,
                zIndex: 10000,
                background: 'var(--color-bg-elevated, #ffffff)',
                border: '1px solid var(--color-border, #e5e5e5)',
                borderRadius: 6,
                padding: 4,
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                minWidth: 160,
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {PING_INTENTS.map((intent, index) => (
                <button
                  key={intent.key}
                  ref={index === 0 ? pingIntentFirstItemRef : undefined}
                  type="button"
                  role="menuitem"
                  className="cf-menu-item"
                  data-testid={`map-ping-intent-${intent.key}`}
                  onClick={() => choosePingIntent(intent.key)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <GameIcon slug={intent.icon} size={UI_ICON_SIZE.xs} />
                  <span>{pingIntentLabel(intent.key)}</span>
                </button>
              ))}
            </div>,
            document.body,
          )}

          {/* Token tray + keyboard/tool help. In the cockpit these float over the canvas
              on the right instead of stacking under it, so the map keeps the full height. */}
          <div
            className={isVtt ? 'cf-vtt-map-tray' : undefined}
            style={isVtt ? undefined : { display: 'contents' }}
          >
          {/* In the cockpit this tray is behind the rail's "Manage tokens" tool (see
              `selectionDisclosure`); in the card layout it is always in flow, where it
              covers nothing.

              The disclosure gate applies to DMs ONLY, because the button that opens it
              is itself DM-gated. Applying it to everyone hid the Unplaced list — the one
              way a player puts their own character on the board — behind a control no
              player can see, so in the cockpit a player simply could not place their
              token and had to ask the DM to do it. Players keep the tray in flow, as
              they had it before the disclosure existed. */}
          {!isCast && (!isVtt || !effectiveIsDm || selectionDisclosure.open) && (unplaced.length > 0 || hiddenByFog.length > 0 || (effectiveIsDm && placed.length > 0)) && (
            <div
              className="flex flex-col gap-2"
              style={{ padding: '0 14px 10px' }}
              data-testid="map-token-trays"
              {...(isVtt && effectiveIsDm ? selectionDisclosure.regionProps : {})}
            >
              {/* Three labelled groups, not one flat run of buttons: what you are
                  selecting, what to do with the selection, and saved formations. The
                  unlabelled pile gave "Select party", "Cluster" and "Save formation"
                  identical weight, so nothing signalled that the middle group acts ON
                  the first group's result. */}
              {effectiveIsDm && (
                <div className="cf-token-manage" aria-label={t('encounters.map.manage.title')}>
                  <div className="cf-token-manage__status" aria-live="polite">
                    {selectedTokenIds.size} token{selectedTokenIds.size === 1 ? '' : 's'} selected
                  </div>
                  <div className="cf-token-manage__group" role="group" aria-label={t('encounters.map.manage.select')}>
                    <span className="cf-token-manage__label">{t('encounters.map.manage.select')}</span>
                  <button type="button" className="cf-map-tool cf-map-tool--compact" onClick={() => setSelectedTokenIds(new Set())}>Clear selection</button>
                  <button type="button" className="cf-map-tool cf-map-tool--compact" onClick={() => setSelectedTokenIds(selectBy(placed, c => c.kind === 'character'))}>Select party</button>
                  <button type="button" className="cf-map-tool cf-map-tool--compact" onClick={() => setSelectedTokenIds(selectBy(placed, c => c.kind !== 'character'))}>Select enemies</button>
                  <button type="button" className="cf-map-tool cf-map-tool--compact" onClick={() => setSelectedTokenIds(selectBy(placed, c => c.kind === 'monster'))}>Select monsters</button>
                  <button type="button" className="cf-map-tool cf-map-tool--compact" onClick={() => setSelectedTokenIds(selectBy(placed, c => c.kind === 'npc'))}>Select NPCs</button>
                  <details>
                    <summary className="cf-map-tool cf-map-tool--compact" style={{ cursor: 'pointer' }}>{t('encounters.map.manage.selectedTokens')}</summary>
                    <div role="group" aria-label={t('encounters.map.manage.selectedTokenList')} className="flex flex-col gap-1" style={{ maxHeight: 150, overflow: 'auto', padding: 6 }}>
                      {placed.map(c => <label key={c.id}><input type="checkbox" checked={selectedTokenIds.has(c.id)} onChange={() => setSelectedTokenIds(current => toggleTokenSelection(current, c.id, true))} /> {c.name}</label>)}
                    </div>
                  </details>
                  </div>
                  <div className="cf-token-manage__group" role="group" aria-label={t('encounters.map.manage.arrange')}>
                    <span className="cf-token-manage__label">{t('encounters.map.manage.arrange')}</span>
                  {(['line', 'cluster', 'sides'] as const).map(kind => <button key={kind} type="button" className="cf-map-tool cf-map-tool--compact" disabled={!tokenPlanningReady || selectedTokenIds.size === 0 || !onBatchTokens} onClick={() => {
                    const chosen = placed.filter(c => selectedTokenIds.has(c.id));
                    let plan: Array<{ combatantId: number; x: number; y: number }>;
                    try { plan = planFormationPlacement(encounter.combatants, selectedTokenIds, kind, { x: 50, y: 50 }, gridOn ? Math.max(1, gridSize ?? 5) : 5, gridOn && gridType === 'hex' ? 'hex' : 'square', tokenPlanningAspect, calibration, mapRect).map(p => ({ combatantId: p.id, x: p.x, y: p.y })); }
                    catch (error) { onError(error instanceof Error ? error.message : 'Unable to plan formation'); return; }
                    if (!onBatchTokens) return;
                    if (!window.confirm(`Preview ${kind} formation: ${plan.length} included, ${chosen.length - plan.length} omitted. Apply this atomic placement?`)) return;
                    void onBatchTokens(plan, tokenPlanningAspect).then(result => { beginTokenBatchUndo(result.undoToken); announce(`${kind} formation preview applied: ${plan.length} included`); }).catch(error => onError(error instanceof Error ? error.message : 'Unable to place formation'));
                  }}>{kind === 'sides' ? 'Party / enemy sides' : `${kind[0].toUpperCase()}${kind.slice(1)}`}</button>)}
                  </div>
                  <div className="cf-token-manage__group" role="group" aria-label={t('encounters.map.manage.formations')}>
                    <span className="cf-token-manage__label">{t('encounters.map.manage.formations')}</span>
                  {/* Grows to the tray's width: at the old fixed 130px the placeholder
                      itself was clipped to "Formation nan", which reads as a bug. */}
                  <TextInput aria-label="Saved formation name" value={formationName} onChange={(e) => setFormationName(e.target.value)} placeholder="Formation name" style={{ flex: '1 1 11rem', minWidth: '9rem' }} />
                  <button type="button" className="cf-map-tool cf-map-tool--compact" disabled={!tokenPlanningReady || !formationName.trim() || selectedTokenIds.size === 0} onClick={() => {
                    const chosen = placed.filter(c => selectedTokenIds.has(c.id));
                    const anchor = chosen[0]; if (!anchor || anchor.tokenX == null || anchor.tokenY == null) return;
                    void api.post(`${API}/campaigns/${campaignId}/encounters/token-formations`, { name: formationName, slots: chosen.map(c => ({ side: c.kind === 'character' ? 'party' : 'enemy', kind: c.kind, x: (c.tokenX ?? anchor.tokenX!) - anchor.tokenX!, y: (c.tokenY ?? anchor.tokenY!) - anchor.tokenY! })) }).then(() => {
                      setFormationName(''); void formationsQuery.refetch(); announce('Formation saved');
                    }).catch(error => onError(error instanceof Error ? error.message : 'Unable to save formation'));
                  }}>Save formation</button>
                  {(formationsQuery.data ?? []).map(formation => <span key={formation.id} className="flex gap-1 items-center"><button type="button" className="cf-map-tool cf-map-tool--compact" disabled={!tokenPlanningReady} onClick={() => {
                    try {
                      const slots = JSON.parse(formation.layoutJson) as Array<{ side: 'party' | 'enemy' | 'any'; kind?: string; x: number; y: number }>;
                      const remaining = [...placed.filter(c => selectedTokenIds.size === 0 || selectedTokenIds.has(c.id))];
                      const assigned = slots.flatMap(slot => {
                        const index = remaining.findIndex(c => (slot.side === 'any' || (slot.side === 'party') === (c.kind === 'character')) && (!slot.kind || c.kind === slot.kind));
                        if (index < 0) return []; const [c] = remaining.splice(index, 1); return [{ token: c, desired: { x: 50 + slot.x, y: 50 + slot.y } }];
                      });
                      const plan = resolveDesiredFormation(encounter.combatants, assigned, gridOn ? Math.max(1, gridSize ?? 5) : 5, gridOn && gridType === 'hex' ? 'hex' : 'square', tokenPlanningAspect, calibration, mapRect).map(p => ({ combatantId: p.id, x: p.x, y: p.y }));
                      if (!plan.length) throw new Error('No selected tokens match this formation');
                      if (!onBatchTokens) return;
                      if (!window.confirm(`Preview ${formation.name}: ${plan.length} included, ${remaining.length} omitted. Apply this atomic placement?`)) return;
                      void onBatchTokens(plan, tokenPlanningAspect).then(result => { beginTokenBatchUndo(result.undoToken); announce(`${formation.name} placed`); }).catch(error => onError(error instanceof Error ? error.message : 'Unable to place formation'));
                    } catch (error) { onError(error instanceof Error ? error.message : 'Invalid saved formation'); }
                  }}>{formation.name}</button><button type="button" aria-label={`Delete ${formation.name} formation`} className="cf-map-tool cf-map-tool--compact" onClick={() => void api.delete(`${API}/campaigns/${campaignId}/encounters/token-formations/${formation.id}`).then(() => void formationsQuery.refetch())}><UIIcon name="close" size="xs" /></button></span>)}
                  </div>
                </div>
              )}
              {unplaced.length > 0 && (
                <div className="flex flex-wrap gap-2 items-center">
                  <span className="text-muted" style={{ fontSize: 11 }}>Unplaced:</span>
                  {effectiveIsDm && (
                    <button
                      type="button"
                      className="cf-map-tool cf-map-tool--compact"
                      data-testid="map-token-place-all"
                      disabled={!tokenPlanningReady || busy}
                      onClick={() => {
                        try {
                          // Planning completes before the first write, so an impossible map
                          // never quietly places only a prefix of the tray.
                          const plan = planCollisionFreePlacement(encounter.combatants, { x: 50, y: 50 }, gridOn ? Math.max(1, gridSize ?? 5) : 5, gridOn && gridType === 'hex' ? 'hex' : 'square', tokenPlanningAspect, calibration, mapRect);
                          if (!onBatchTokens) return;
                          void onBatchTokens(plan.map(item => ({ combatantId: item.id, x: item.x, y: item.y })), tokenPlanningAspect).then(result => {
                            beginTokenBatchUndo(result.undoToken); announce(`${plan.length} tokens placed with collision-free spacing`);
                          }).catch(error => onError(error instanceof Error ? error.message : 'Unable to place all tokens'));
                        } catch (error) {
                          onError(error instanceof Error ? error.message : 'Unable to find collision-free positions');
                        }
                      }}
                    >Place all</button>
                  )}
                  {unplaced.map((c) => {
                    const movable = effectiveCanMoveToken(c);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className="cf-map-tool cf-map-tool--compact"
                        data-testid={`map-token-unplaced-${c.id}`}
                        disabled={!movable || busy}
                        onClick={() => onMoveToken(c.id, 50, 50)}
                        title={movable ? 'Place token at center' : 'You can only move your own token'}
                        style={{ cursor: movable && !busy ? 'pointer' : 'default', border: '1px dashed var(--color-divider)' }}
                      >
                        {tokenInitials(c.name)} · {c.name}
                      </button>
                    );
                  })}
                </div>
              )}
              {hiddenByFog.length > 0 && (
                <div className="flex flex-wrap gap-2 items-center" data-testid="map-token-fog-hidden">
                  <span className="text-muted" style={{ fontSize: 11 }}>{FOG_HIDDEN_TOKEN_LABEL}:</span>
                  {hiddenByFog.map((c) => (
                    <span
                      key={c.id}
                      className="cf-chip"
                      data-testid={`map-token-fog-hidden-${c.id}`}
                      title="The DM placed this token outside the revealed fog. It will appear when that area is revealed."
                      style={{ border: '1px solid var(--color-divider)', cursor: 'default', opacity: 0.85 }}
                    >
                      {tokenInitials(c.name)} · {c.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {!isCast && (
          <>
          <div id="map-keyboard-help" className="sr-only">
            Use Tab to focus a token or area-of-effect handle. Arrow keys nudge one grid cell, Shift plus Arrow moves five. Delete or Backspace removes a selected fog region in Select mode. Number keys 1 to 7 switch tools. In measure, reveal, or erase mode, press Enter to start at the map center, arrows to adjust, Enter to finish, Escape to cancel. Ctrl+Z undoes the last fog edit; Ctrl+Shift+Z redoes. Press plus, minus, or zero to zoom, and arrow keys to pan when zoomed.
          </div>
          <div
            className="text-muted"
            style={{ padding: '8px 14px', borderTop: '1px solid var(--color-divider)', fontSize: 11 }}
            aria-hidden="true"
          >
            {tool === 'measure'
              ? `Click-drag or press Enter to start measuring in ${gridCellUnitPlural(gridType)} at the map center, then arrow keys to aim and Enter to finish. Escape cancels.`
              : tool === 'reveal'
                ? 'Click-drag or Shift-click a grid cell to reveal. Press Enter to start a reveal rectangle at the map center, arrow keys to resize, Enter to commit. Escape cancels. Ctrl+Z undoes fog edits.'
                : tool === 'erase'
                  ? 'Click-drag or press Enter to erase a revealed region. Escape cancels. Ctrl+Z undoes fog edits.'
                  : tool === 'select'
                    ? 'Click a revealed region to select it, drag to move, Delete to remove. Escape deselects when a region is focused.'
                    : tool === 'ping'
                  ? t('encounters.map.ping.toolHelp', { hint: t('encounters.map.ping.keyboardHint') })
                  : viewportPan
                    ? 'Drag to pan the map. Pinch with two fingers to zoom on touch devices.'
                    : effectiveIsDm
                      ? 'Drag a token to move it, or Tab to focus it and use arrow keys. Drag an AoE handle to move a template, or Tab to focus it. Use the viewport toolbar to zoom and pan.'
                      : 'Drag your own token to move it, or Tab to focus it and use arrow keys. Use the viewport toolbar to zoom and pan.'}
          </div>
          </>
          )}
          </div>
        </>
      )}
      {tokenBatchUndo && (
        <UndoSnackbar
          key={tokenBatchUndo}
          message="Token batch applied."
          successMessage="Token batch undone."
          onUndo={async () => {
            await (onUndoTokenBatch?.(tokenBatchUndo) ?? Promise.resolve());
            setTokenBatchUndo(null);
          }}
          onExpire={() => setTokenBatchUndo(null)}
        />
      )}
      {dragMoveUndo && (
        <UndoSnackbar
          key={`${dragMoveUndo.combatantId}-${dragMoveUndo.moveFt}`}
          message={t('encounters.map.dragDistance.movedMessage', { feet: dragMoveUndo.moveFt, unit: gridUnit })}
          successMessage={t('encounters.map.dragDistance.undoneMessage')}
          onUndo={async () => {
            onMoveToken(dragMoveUndo.combatantId, dragMoveUndo.origin.x, dragMoveUndo.origin.y);
            onMoveFt(dragMoveUndo.combatantId, -dragMoveUndo.moveFt);
            setDragMoveUndo(null);
          }}
          onExpire={() => setDragMoveUndo(null)}
        />
      )}
    </Card>
  );
});

// ---------------------------------------------------------------------------

/**
 * One-tap "apply rolled damage" bar (issue: wire actions → dice → damage). Appears
 * when a character card rolls damage; the user picks Damage/Heal and taps a target
 * combatant to apply it via the same HP path as the ± steppers. Targets are limited
 * to combatants the viewer can edit (the DM: everyone; a player: their own character),
 * so it never lets a player edit HP the server would reject anyway.
 */
export type ApplyDamageBarProps = {
  amount: number;
  label: string;
  diceTotal?: number;
  ruleSystem?: string | null;
  customMechanicsProfile?: CustomMechanicsProfile | null;
  targets: Combatant[];
  aoeTemplates?: AoeTemplate[];
  aoeHitContext?: AoeHitTestContext | null;
  isStarfinder?: boolean;
  applyDisabled?: boolean;
  onApply: (combatantId: number, delta: number, damage: DirectDamageMetadata) => void;
  onApplyToAll: (applications: TargetDamageApplication[], delta: number) => void;
  onDismiss: () => void;
};

export const ApplyDamageBar = memo(function ApplyDamageBar({
  amount,
  label,
  diceTotal,
  ruleSystem,
  customMechanicsProfile,
  targets,
  aoeTemplates = [],
  aoeHitContext,
  isStarfinder = false,
  applyDisabled = false,
  onApply,
  onApplyToAll,
  onDismiss,
}: ApplyDamageBarProps) {
  const [mode, setMode] = useState<'damage' | 'heal'>('damage');
  const [targetAc, setTargetAc] = useState<'KAC' | 'EAC'>('KAC');
  const [damageType, setDamageType] = useState('');
  const [saveOutcome, setSaveOutcome] = useState<DamageSaveOutcome>('full');
  const [aoeSaveOutcomes, setAoeSaveOutcomes] = useState<Partial<Record<number, DamageSaveOutcome>>>({});
  const [isCrit, setIsCrit] = useState(false);
  const delta = mode === 'heal' ? amount : -amount;
  const mapAdapter = ruleSystemAdapter(ruleSystem, customMechanicsProfile);
  const damageTypes = mapAdapter.damageTypes ?? [];
  const supportsDamageRules = mapAdapter.supportsDirectDamageRules === true;
  const damage = mode === 'damage' && supportsDamageRules
    ? {
        damageType: normalizeDirectDamageType(damageType),
        saveOutcome: saveOutcome === 'half' ? ('half' as const) : undefined,
        isCrit: isCrit && diceTotal !== undefined ? true : undefined,
        damageDice: isCrit && diceTotal !== undefined ? diceTotal : undefined,
      }
    : {};
  const ref = useRef<HTMLDivElement>(null);
  const announce = useAnnounce();
  useEffect(() => {
    // Retried across frames rather than taken once. In the encounter cockpit this bar can
    // mount inside a COLLAPSED side panel — a damage roll from the still-reachable dice
    // tray does exactly that — and a browser refuses `focus()` anywhere inside a hidden
    // subtree. The panel reopens a moment later without remounting this bar, so a single
    // attempt left the keyboard back in the dice controls with the target picker never
    // reached. Keep asking until it is accepted, then scroll it into view.
    let frame = 0;
    let attemptsLeft = 40;
    const settle = () => {
      frame = 0;
      const node = ref.current;
      if (!node) return;
      node.focus({ preventScroll: true });
      if (document.activeElement === node) {
        node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      if (attemptsLeft-- > 0) frame = requestAnimationFrame(settle);
    };
    frame = requestAnimationFrame(settle);
    announce(`Apply ${amount} ${label}. Pick a target.`);
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [amount, label, announce]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="cf-inset"
      role="group"
      aria-label={`Apply ${amount} rolled ${label}`}
      data-testid="apply-damage-bar"
      style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px' }}
    >
      <span style={{ fontSize: 12.5 }}>
        <span className="text-muted">Rolled </span>
        <span style={{ fontWeight: 700, color: 'var(--color-text)' }}>{amount}</span>
        <span className="text-muted"> — {label}</span>
      </span>
      <div className="seg inline-flex" role="group" aria-label="Apply as" style={{ gap: 4 }}>
        {(['damage', 'heal'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className="cf-target-44"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            style={{
              padding: '0 12px',
              fontSize: 12,
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
              color: mode === m ? 'var(--color-accent)' : 'var(--color-neutral-500)',
              boxShadow: mode === m ? 'inset 0 0 0 1px var(--color-accent)' : 'none',
            }}
          >
            {m === 'damage' ? 'Damage' : 'Heal'}
          </button>
        ))}
      </div>
      {mode === 'damage' && supportsDamageRules && (
        <div className="flex items-center gap-2 flex-wrap" aria-label="Damage modifiers">
          <label className="text-muted" style={{ fontSize: 11.5 }}>
            Type{' '}
            {damageTypes.length > 0 ? (
              <select className="input cf-target-44" style={{ width: 'auto' }} value={damageType} onChange={(event) => setDamageType(event.target.value)} aria-label="Damage type">
                <option value="">untyped</option>
                {damageTypes.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            ) : (
              <input className="input cf-target-44" style={{ width: 'auto' }} value={damageType} onChange={(event) => setDamageType(event.target.value)} aria-label="Damage type" placeholder="untyped" maxLength={24} />
            )}
          </label>
          <label className="text-muted" style={{ fontSize: 11.5 }}>
            Save{' '}
            <select className="input cf-target-44" style={{ width: 'auto' }} value={saveOutcome} onChange={(event) => setSaveOutcome(event.target.value as DamageSaveOutcome)} aria-label="Save outcome">
              <option value="full">full damage</option>
              <option value="half">saved — half</option>
            </select>
          </label>
          <button type="button" className="btn btn-ghost cf-target-44" aria-pressed={isCrit} disabled={diceTotal === undefined} onClick={() => setIsCrit((value) => !value)} title={diceTotal === undefined ? 'Critical damage requires a dice roll breakdown' : 'Double rolled dice, not flat modifiers'}>
            Critical{isCrit ? ' × dice' : ''}
          </button>
          {(damageType || saveOutcome === 'half' || isCrit) && <span className="text-muted" style={{ fontSize: 11.5 }}>Rules modifiers apply per target.</span>}
        </div>
      )}
      {isStarfinder && (
        <div className="seg inline-flex" role="group" aria-label="Target AC" style={{ gap: 4 }}>
          {(['KAC', 'EAC'] as const).map((ac) => (
            <button
              key={ac}
              type="button"
              className="cf-target-44"
              aria-pressed={targetAc === ac}
              onClick={() => setTargetAc(ac)}
              style={{
                padding: '0 12px',
                fontSize: 12,
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                color: targetAc === ac ? 'var(--color-accent)' : 'var(--color-neutral-500)',
                boxShadow: targetAc === ac ? 'inset 0 0 0 1px var(--color-accent)' : 'none',
              }}
            >
              Target {ac}
            </button>
          ))}
        </div>
      )}
      <span className="text-muted" style={{ fontSize: 11.5 }}>
        {mode === 'heal' ? 'Heal' : 'Apply to'}:
      </span>
      {targets.length === 0 ? (
        <span className="text-muted" style={{ fontSize: 11.5 }}>no editable targets</span>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {targets.map((c) => {
            const acVal = targetAc === 'EAC' ? (c.eac ?? '—') : (c.kac ?? '—');
            const acLabel = isStarfinder ? ` (${targetAc} ${acVal})` : '';
            return (
              <button
                key={c.id}
                type="button"
                className="btn btn-secondary cf-target-44"
                style={{ fontSize: 12, padding: '0 12px' }}
                title={`${mode === 'heal' ? 'Heal' : 'Deal'} ${amount} to ${c.name}${acLabel}`}
                disabled={applyDisabled}
                data-testid={`apply-damage-target-${c.id}`}
                onClick={() => onApply(c.id, delta, damage)}
              >
                {c.name}{acLabel}
              </button>
            );
          })}
        </div>
      )}
      {aoeHitContext && aoeTemplates.length > 0 && (
        <>
          <span className="text-muted" style={{ fontSize: 11.5, width: '100%' }}>
            AoE templates:
          </span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', width: '100%' }}>
            {aoeTemplates.map((t) => {
              const affectedCombatants = combatantsInAoe(targets, t, aoeHitContext);
              const buttonLabel = `Apply to all in ${t.shape} (${t.sizeFt} ft)`;
              const applications = mode === 'damage' && supportsDamageRules
                ? buildAoeDamageApplications(
                    affectedCombatants.map((c) => c.id),
                    damage,
                    saveOutcome,
                    aoeSaveOutcomes,
                  )
                : affectedCombatants.map((c) => ({ combatantId: c.id, damage: {} }));
              return (
                <div key={t.id} className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    className="btn btn-secondary cf-target-44"
                    style={{ fontSize: 12, padding: '0 12px' }}
                    disabled={applyDisabled || affectedCombatants.length === 0}
                    title={
                      affectedCombatants.length === 0
                        ? `No editable targets inside this ${t.shape} template`
                        : `${mode === 'heal' ? 'Heal' : 'Deal'} ${amount} to ${affectedCombatants.map((c) => c.name).join(', ')}`
                    }
                    data-testid={`apply-damage-aoe-${t.id}`}
                    onClick={() => onApplyToAll(applications, delta)}
                  >
                    {buttonLabel}
                    {affectedCombatants.length > 0 ? ` (${affectedCombatants.length})` : ''}
                  </button>
                  {mode === 'damage' && supportsDamageRules && affectedCombatants.map((c) => (
                    <label key={c.id} className="text-muted" style={{ fontSize: 11.5 }}>
                      {c.name}{' '}
                      <select
                        className="input cf-target-44"
                        style={{ width: 'auto' }}
                        value={aoeSaveOutcomes[c.id] ?? saveOutcome}
                        onChange={(event) => {
                          const outcome = event.target.value as DamageSaveOutcome;
                          setAoeSaveOutcomes((current) => ({ ...current, [c.id]: outcome }));
                        }}
                        aria-label={`Save outcome for ${c.name} in ${t.shape} template`}
                        data-testid={`aoe-save-outcome-${t.id}-${c.id}`}
                      >
                        <option value="full">full damage</option>
                        <option value="half">saved — half</option>
                      </select>
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}
      <button
        type="button"
        aria-label={`Dismiss apply ${amount} ${label} bar`}
        onClick={onDismiss}
        className="cf-dismiss-target"
        style={{ marginLeft: 'auto' }}
        data-testid="apply-damage-dismiss"
      >
        <UIIcon name="close" size="sm" />
      </button>
    </div>
  );
});
