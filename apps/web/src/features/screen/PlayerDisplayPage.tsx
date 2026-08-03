/**
 * Player Display — the cast-to-TV / "present" mode (issue #60).
 *
 * A read-only, full-bleed, secret-free view a DM can throw on a TV at the table.
 * Authenticated DMs can preview it from /c/:campaignId/screen. Shared devices use
 * /cast/:campaignId/:token, which fetches only server-redacted cast endpoints with
 * cookies omitted, so unredacted DM payloads never reach the cast client.
 *
 * Route: /c/:campaignId/screen — mounted OUTSIDE the app chrome (Layout) so it
 * fills the screen with no sidebar/tabbar, but INSIDE AuthedLayout (members only).
 *
 * Live: refetches on encounter SSE events (issue #4) for snappy combat, plus a
 * slow poll to catch location/quest/party edits that don't emit an event.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type {
  CampaignSummary,
  CastSafetyState,
  Encounter,
  EncounterWithCombatants,
  HpBand,
  PartyCharacter,
} from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useCampaignEvents, type CampaignEventsStatus } from '../../lib/useCampaignEvents';
import { usePollWhileVisible } from '../../lib/usePollWhileVisible';
import {
  fingerprintDedupeParts,
  formatGroupedAnnouncement,
  formatGroupedCombatantAnnouncement,
  useAnnounce,
} from '../../components/Announcer';
import { GameIcon } from '../../components/GameIcon';
import { UIIcon } from '../../components/UIIcon';
import { useDialog } from '../../components/useDialog';
import { SafetyHoldDisplayOverlay, SafetyHoldOverlayView } from '../../components/SafetyHoldBar';
import { NpcDispositionBadge, QuestStatusBadge } from '../../components/EntitySemanticBadges';
import { BattleMap } from '../encounters/RunSessionPage';
import { useAuth } from '../../app/auth';
import { prefersReducedMotion } from '../../lib/prefersReducedMotion';
import { useAiDmLiveActivityState } from '../ai-dm/useAiDmLiveActivity';
import { STATUS_LABEL } from '../characters/status';
import { initials } from '../../lib/avatarText';
import {
  safeCombatants,
  safeEncounterForCast,
  safeLocation,
  safeNpcs,
  safeParty,
  safeQuests,
  type SafeCombatant,
  type SafeNpc,
  type SafeQuest,
} from './playerSafe';
import {
  CastSafetyPoller,
  PlayerDisplayLoadSequencer,
  playerDisplaySyncMessage,
  playerDisplaySyncState,
  projectionAfterLoadFailure,
  runCastSafetyPoll,
  runPlayerDisplayLoad,
  shouldApplyCastSafetyResult,
  type PlayerDisplayFetchers,
  type PlayerDisplayProjection,
} from './playerDisplayLoad';
import { useWakeLock } from './useWakeLock';
import { loginHrefWithReturn } from '../../lib/safeInternalPath';
import { CAST_DISPLAY_CHANNEL, CAST_WINDOW_NAME, type CastDisplayStatus } from './castWindow';
import {
  DEFAULT_SCENE,
  initiativeWindow,
  isSceneId,
  nextActorIndex,
  pageCount as pageCountFor,
  readStoredScene,
  rotateWindow,
  SCENE_IDS,
  SCENE_LABEL,
  sceneStorageKey,
  writeStoredScene,
  hiddenCount,
  type SceneId,
} from './playerDisplayScene';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

/** Fixed-aspect stage budgets. Chosen so a full page comfortably fits the 16:9
 * safe area from 720p up to 4K without a scrollbar; overflow past these paginates
 * (issue #823) rather than falling below the fold. */
const INIT_PAGE_SIZE = 8;
const PARTY_PAGE_SIZE = 8;
const QUEST_PAGE_SIZE = 4;
const NPC_PAGE_SIZE = 6;
const MAX_ROW_CONDITIONS = 4;
/** Auto-rotate cadence for paged scenes. A producer can also step pages by hand. */
const SCENE_ROTATE_MS = 8_000;

type StageAspect = '16:9' | '4:3';
const ASPECT_RATIO: Record<StageAspect, { w: number; h: number }> = {
  '16:9': { w: 16, h: 9 },
  '4:3': { w: 4, h: 3 },
};

/** Party/quest/status edits have no SSE. Keep Cast aligned with PartyPage's
 * visible-tab poll cadence (see PartyPage / usePollWhileVisible) so retirement
 * and death land promptly without a steeper custom interval (issue #824). */
const POLL_MS = 5_000;

const NO_PARTICIPATING_IDS: number[] | null = null;

function participatingIdsFromEncounter(
  encounter: EncounterWithCombatants | null,
): number[] | null {
  if (!encounter || encounter.status !== 'running') return NO_PARTICIPATING_IDS;
  const ids: number[] = [];
  for (const c of encounter.combatants) {
    if (c.kind === 'character' && c.characterId != null) ids.push(c.characterId);
  }
  return ids;
}
const CONTROLS_HIDE_MS = 3_500;

const HP_BAND_LABEL: Record<HpBand, string> = {
  healthy: 'Healthy',
  bloodied: 'Bloodied',
  critical: 'Critical',
  down: 'Down',
};
const HP_BAND_PCT: Record<HpBand, number> = { healthy: 100, bloodied: 50, critical: 20, down: 0 };
const HP_BAND_TONE: Record<HpBand, string> = { healthy: '', bloodied: 'low', critical: 'crit', down: 'crit' };

type FullscreenNotice = { kind: 'info' | 'error'; message: string };

const FULLSCREEN_UNSUPPORTED =
  "Fullscreen isn't available in this browser. Use the browser's presentation or cast controls, or share this window instead.";

function fullscreenAvailable(): boolean {
  try {
    return (
      document.fullscreenEnabled === true &&
      typeof document.documentElement.requestFullscreen === 'function' &&
      typeof document.exitFullscreen === 'function'
    );
  } catch {
    return false;
  }
}

function fullscreenActive(): boolean {
  try {
    return document.fullscreenElement != null;
  } catch {
    return false;
  }
}

function fullscreenFailure(action: 'enter' | 'exit', error: unknown): string {
  if (action === 'exit') {
    return "Couldn't exit fullscreen. Press Escape, then try the control again.";
  }
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Fullscreen was blocked. Allow fullscreen for this site in your browser settings, keep this tab active, then try again.';
  }
  if (error instanceof DOMException && error.name === 'InvalidStateError') {
    return "Fullscreen couldn't start because the display is not ready. Keep this tab active, then try again.";
  }
  const detail = error instanceof Error && error.message.trim() ? ` (${error.message.trim()})` : '';
  return `Fullscreen couldn't start${detail}. Keep this tab active, allow fullscreen for this site, then try again.`;
}

const displayFetchers: PlayerDisplayFetchers = {
  getSummary: (campaignId, signal) =>
    api.get<CampaignSummary>(`${API}/campaigns/${campaignId}/summary`, { signal }),
  getRunningEncounters: (campaignId, signal) =>
    api.get<Encounter[]>(`${API}/campaigns/${campaignId}/encounters?status=running`, { signal }),
  getEncounter: (encounterId, signal) =>
    api.get<EncounterWithCombatants>(`${API}/encounters/${encounterId}`, { signal }),
};

async function castRequest<T>(token: string, path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init?.json !== undefined) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, {
    ...init,
    credentials: 'omit',
    headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = Array.isArray(body.message) ? body.message.join('; ') : (body.message ?? message);
    } catch {
      /* non-json error body */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204 || res.status === 205 || res.headers.get('Content-Length') === '0') {
    return undefined as T;
  }
  const text = await res.text();
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

export default function PlayerDisplayPage() {
  const { campaignId, token: castToken } = useParams<{ campaignId: string; token?: string }>();
  const cid = Number(campaignId);
  const navigate = useNavigate();
  const announce = useAnnounce();
  const { roleIn, staleIdentity } = useAuth();
  const isCastMode = typeof castToken === 'string' && castToken.length > 0;
  const isManagedCastWindow = typeof window !== 'undefined' && window.name === CAST_WINDOW_NAME && isCastMode;
  const role = isCastMode ? null : roleIn(cid);

  // Minimal AI-DM narration ticker (#344 point 5 — optional/cuttable, kept lightweight).
  // This page renders OUTSIDE app/Layout.tsx (issue #60's no-chrome cast view), so it
  // can't reach that mounted subscription's context; it opens its own, gated the same
  // way (Driver mode only). Since /screen and the campaign-chrome routes are siblings —
  // never both mounted in the same tab — this never creates a second live connection.
  const liveActivity = useAiDmLiveActivityState(Number.isFinite(cid) && !isCastMode ? cid : undefined);

  // Key projection/failure by campaignId so a client-side :campaignId swap cannot
  // flash the prior campaign's (secret-free but still wrong) cast state.
  const [projection, setProjection] = useState<PlayerDisplayProjection | null>(null);
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  const [failure, setFailure] = useState<{ campaignId: number; message: string } | null>(null);
  const [displayStale, setDisplayStale] = useState(false);
  const [eventStatus, setEventStatus] = useState<CampaignEventsStatus>('connecting');
  const [loading, setLoading] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [fullscreenSupported, setFullscreenSupported] = useState(fullscreenAvailable);
  const [isFullscreen, setIsFullscreen] = useState(fullscreenActive);
  const [fullscreenPending, setFullscreenPending] = useState(false);
  const [fullscreenNotice, setFullscreenNotice] = useState<FullscreenNotice | null>(null);
  const [exitPromptOpen, setExitPromptOpen] = useState(false);
  const [exitPin, setExitPin] = useState('');
  const [exitError, setExitError] = useState<string | null>(null);
  const [exitPending, setExitPending] = useState(false);
  /** Producer opt-in: show dead/retired/inactive PCs under Party with status labels (#824). */
  const [includeAlumni, setIncludeAlumni] = useState(false);
  /** Active broadcast scene (issue #823) — the DM cockpit selects it; the public
   * stage follows. Seeded from a prior selection so a reload/second tab lands on
   * the same scene. */
  const [scene, setScene] = useState<SceneId>(() =>
    Number.isFinite(cid) ? readStoredScene(cid) ?? DEFAULT_SCENE : DEFAULT_SCENE,
  );
  const [aspect, setAspect] = useState<StageAspect>('16:9');
  /** Monotonic paging/rotation cursor. A timer advances it for large lists; the
   * cockpit's page buttons step it by hand. Kept as plain state so tests can drive
   * paging deterministically. */
  const [sceneTick, setSceneTick] = useState(0);
  /** Transient battle-map pings mirrored from the live encounter (issue #484). */
  const [mapPings, setMapPings] = useState<Array<{ key: number; x: number; y: number; senderName: string | null; color: string | null }>>([]);
  const mapPingSeq = useRef(0);
  const fullscreenActiveRef = useRef(isFullscreen);
  /** A popup gets one best-effort fullscreen request. Browser activation rules
   * commonly reject it after the capability fetch; retrying would trap Escape. */
  const autoFullscreenAttemptedRef = useRef(false);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const loadSequencerRef = useRef(new PlayerDisplayLoadSequencer());

  const activeFetchers = useMemo<PlayerDisplayFetchers>(() => {
    if (!isCastMode || !castToken) return displayFetchers;
    return {
      getSummary: (_campaignId, signal) =>
        castRequest<CampaignSummary>(castToken, `${API}/cast/${castToken}/summary`, { signal }),
      getRunningEncounters: (_campaignId, signal) =>
        castRequest<Encounter[]>(castToken, `${API}/cast/${castToken}/encounters?status=running`, { signal }),
      getEncounter: (encounterId, signal) =>
        castRequest<EncounterWithCombatants>(castToken, `${API}/cast/${castToken}/encounters/${encounterId}`, { signal }),
    };
  }, [castToken, isCastMode]);

  const summary = projection?.campaignId === cid ? projection.summary : null;
  const encounter = projection?.campaignId === cid ? projection.encounter : null;
  const error = failure?.campaignId === cid ? failure.message : null;

  // Wake lock: keep the screen awake while fullscreen/presentation is active (#826).
  const wakeLock = useWakeLock(isFullscreen);

  const load = useCallback(async () => {
    if (!Number.isFinite(cid)) return;
    const hadProjection = projectionRef.current?.campaignId === cid;
    const result = await runPlayerDisplayLoad(loadSequencerRef.current, cid, activeFetchers, {
      hadProjection,
    });
    if (result.kind === 'ignored') return;
    if (result.kind === 'ok') {
      setProjection(result.projection);
      setFailure((current) => (current?.campaignId === cid ? null : current));
      setDisplayStale(false);
      setLoading(false);
      return;
    }
    // Transient blip with last-known paint: keep the rail, surface stale/reconnect.
    if (result.keepLastKnown) {
      setDisplayStale(true);
      setLoading(false);
      return;
    }
    // Persistent failure (404/403/…): drop the initiative rail. When this load
    // already fetched a summary, keep the cast painted and surface a rail-scoped
    // error — do not wipe the whole Player Display to a full-screen failure.
    setProjection((current) =>
      projectionAfterLoadFailure(current, cid, {
        keepLastKnown: false,
        summary: result.summary,
      }),
    );
    setFailure({ campaignId: cid, message: result.message });
    setDisplayStale(false);
    setLoading(false);
  }, [activeFetchers, cid]);

  useEffect(() => {
    const sequencer = loadSequencerRef.current;
    if (!Number.isFinite(cid)) {
      setLoading(false);
      // Teardown-only invalidation: React runs this cleanup before the next
      // effect on cid change, so a single bump covers unmount and campaign swap.
      return () => {
        sequencer.invalidate();
      };
    }
    // Prior effect cleanup already aborted in-flight work for the old cid.
    // Reset sync chrome, then begin a fresh load for this identity.
    setEventStatus('connecting');
    setDisplayStale(false);
    setLoading(true);
    setIncludeAlumni(false);
    void load();
    return () => {
      sequencer.invalidate();
    };
  }, [cid, load]);

  // Slow poll — catches location/quest/party edits (no SSE event) without hammering.
  // Pauses while the cast tab is hidden; refetches immediately on becoming visible
  // so a status change made in another tab lands promptly when Cast is watched again.
  usePollWhileVisible(() => void load(), POLL_MS, Number.isFinite(cid));

  /**
   * X-Card state for the cast-token route (issue #1908).
   *
   * A cast client has no member identity and cannot call the member-scoped
   * `GET /campaigns/:id/safety` that backs the authed overlay, so it polls the
   * anonymous `/cast/:token/safety` capability on the same visible-tab cadence as
   * the rest of this page — comfortably inside the 15s bound raising a hold must
   * blank the display within.
   *
   * `runCastSafetyPoll`/`CastSafetyPoller` (see that module's doc for the
   * full history, including the nine-round comparison-based scheme this
   * replaced) allows at most one request in flight at a time — a tick that
   * fires while one is still outstanding is simply skipped. Because there is
   * never a second, differently-ordered response to reconcile against,
   * out-of-order application is structurally impossible rather than merely
   * checked-for: whichever response arrives IS the most recent observation,
   * unconditionally. The trade this accepts is explicit and bounded: a hung
   * request now delays the NEXT observation, up to
   * `CAST_SAFETY_POLL_TIMEOUT_MS`, which is sized (with the poll interval)
   * to stay inside the 15s bound even in that worst case — see that
   * constant's doc. Fail safe throughout: an ignored tick and a genuine
   * failure on the current request all leave the last-known hold state
   * alone rather than guessing a new value — it can never clear an active
   * curtain. The regular projection poll already surfaces a hard failure
   * (expired/revoked token) for the page as a whole.
   *
   * `castSafetyKnown` tracks whether a poll has EVER actually succeeded,
   * separately from the last-known `active` value: "no hold" and "never
   * successfully checked" are different states, and only the former may
   * render as an open display. Until the first `ok`, the overlay renders as
   * if a hold were active — the same fail-safe bias as everywhere else in
   * this poll, applied to its own unconfirmed starting state. Both reset to
   * "unknown" whenever the cast identity (token) changes — a route
   * transition between two `/cast/:campaignId/:token` URLs reuses this
   * component, and carrying over the PRIOR campaign's last-known state would
   * let a display that last confirmed "no hold" there render the NEW
   * campaign open, even if its hold is already active, until its own poll
   * happens to succeed.
   *
   * That reset happens DURING RENDER, not in a `useEffect` — React's
   * documented pattern for resetting derived state when an identity changes
   * ("adjusting state when a prop changes"), not a workaround. `useEffect`
   * runs as a passive effect after the browser may already have painted, so
   * an effect-based reset can let the OLD identity's last-known state paint
   * for one real frame before the reset catches up. Comparing against a ref
   * and calling the setters inline (guarded so it fires at most once per
   * identity, not every render) closes that window entirely: React re-runs
   * the component with the reset state before anything commits to the
   * screen.
   *
   * That still leaves a narrower window open on the COMMIT side: the render-
   * time reset and `poller.invalidate()` (which runs in the OLD effect's
   * passive cleanup, strictly after commit) are not the same instant. If the
   * old identity's in-flight request resolves in between — after the render-
   * time reset has already committed the new identity's "unknown" state, but
   * before `invalidate()` has aborted it — `runCastSafetyPoll` has no way to
   * know a component-level identity change is pending; it still sees an
   * ordinary in-flight request and can legitimately resolve `ok`. Applying
   * that result would use the OLD identity's value to set the NEW identity's
   * state. No poller design closes this on its own: it operates within one
   * identity, not across the identity boundary the component owns. So the
   * commit site itself re-checks the identity this specific call was
   * actually made for (captured once, at the top of `loadCastSafety`, before
   * any `await`) against `castSafetyIdentityRef.current` — which by the time
   * this promise resolves already reflects whatever the LATEST render
   * committed — and only applies the result when they still match. A
   * mismatch means some later identity change has already superseded this
   * call; the result is silently dropped rather than applied, exactly like
   * an ordinary ignored poll result.
   */
  const [castSafetyActive, setCastSafetyActive] = useState(false);
  const [castSafetyKnown, setCastSafetyKnown] = useState(false);
  const castSafetyPollerRef = useRef(new CastSafetyPoller());
  const castSafetyIdentityRef = useRef<string | null>(null);
  const castSafetyIdentity = isCastMode && castToken ? castToken : null;
  if (castSafetyIdentityRef.current !== castSafetyIdentity) {
    castSafetyIdentityRef.current = castSafetyIdentity;
    setCastSafetyActive(false);
    setCastSafetyKnown(false);
  }
  const loadCastSafety = useCallback(async () => {
    if (!isCastMode || !castToken) return;
    // Capture the identity this call is FOR, before the `await` — the ref it
    // is compared against below can change while this request is in flight
    // (an SPA transition to a new cast token). See the doc above for why the
    // poller's own single-writer/invalidate machinery cannot substitute for
    // this check.
    const requestIdentity = castToken;
    const result = await runCastSafetyPoll(castSafetyPollerRef.current, (signal) =>
      castRequest<CastSafetyState>(castToken, `${API}/cast/${castToken}/safety`, { signal }),
    );
    if (shouldApplyCastSafetyResult(result, requestIdentity, castSafetyIdentityRef.current)) {
      setCastSafetyActive(result.active);
      setCastSafetyKnown(true);
    }
    // 'ignored' (skipped while busy, aborted, or unmount/identity-change) and
    // a 'failed' (transient) result, or an 'ok' result whose captured
    // identity no longer matches the live one (superseded by a later
    // identity change), all leave castSafetyActive/castSafetyKnown untouched
    // — see fail-safe note above.
  }, [castToken, isCastMode]);

  useEffect(() => {
    const poller = castSafetyPollerRef.current;
    if (isCastMode) void loadCastSafety();
    // Abort the in-flight poll (if any) on unmount or when the cast identity
    // (token) changes, so a late response never calls setState past that
    // point.
    return () => {
      poller.invalidate();
    };
  }, [isCastMode, loadCastSafety]);

  usePollWhileVisible(() => void loadCastSafety(), POLL_MS, isCastMode);

  const addMapPing = useCallback((ping: { x: number; y: number; senderName?: string | null; color?: string | null }) => {
    const key = ++mapPingSeq.current;
    if (ping.senderName) {
      announce(`${ping.senderName} pinged the map`);
    } else {
      announce('A map ping arrived');
    }
    setMapPings((prev) => {
      const next = [...prev, { key, x: ping.x, y: ping.y, senderName: ping.senderName || null, color: ping.color || null }];
      return next.slice(-10);
    });
    window.setTimeout(() => {
      setMapPings((prev) => prev.filter((p) => p.key !== key));
    }, 10000);
  }, [announce]);

  const dismissMapPing = useCallback((key: number) => {
    setMapPings((prev) => prev.filter((p) => p.key !== key));
  }, []);

  // Snappy combat updates: refetch the moment the DM starts/advances/ends an encounter.
  // Poll + SSE share the same sequencer, so overlapping bursts cannot reorder commits.
  // Ping events render locally without a full refetch (issue #484).
  useCampaignEvents(Number.isFinite(cid) && !isCastMode ? cid : undefined, {
    onEvent: useCallback(
      (event) => {
        if (event.type === 'player-display-scene') {
          if (isSceneId(event.scene)) {
            setScene(event.scene);
            if (Number.isFinite(cid)) writeStoredScene(cid, event.scene);
          }
          return;
        }
        if (
          event.type === 'encounter.ping' &&
          event.ping &&
          projectionRef.current?.encounter?.id === event.encounterId
        ) {
          addMapPing(event.ping);
          return;
        }
        void load();
      },
      [load, addMapPing],
    ),
    onReconnect: useCallback(() => void load(), [load]),
    onStatusChange: useCallback((status: CampaignEventsStatus) => setEventStatus(status), []),
    onStreamRecovery: useCallback(() => void load(), [load]),
  });

  // Re-seed the active scene when the campaign changes so a client-side :campaignId
  // swap does not carry the prior campaign's scene onto a different table.
  useEffect(() => {
    if (Number.isFinite(cid)) setScene(readStoredScene(cid) ?? DEFAULT_SCENE);
  }, [cid]);

  // Cross-tab producer control: a private DM cockpit tab writes the scene to
  // localStorage; a separate public display tab (mirrored TV / OBS source on the
  // same origin) follows via the standard `storage` event. Same-tab selection
  // just updates React state below — the write does not echo back to its own tab.
  useEffect(() => {
    if (!Number.isFinite(cid) || typeof window === 'undefined') return;
    const key = sceneStorageKey(cid);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return;
      if (isSceneId(event.newValue)) setScene(event.newValue);
      else setScene(DEFAULT_SCENE);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [cid]);

  // A fresh scene starts on its anchor page (current actor for Initiative).
  useEffect(() => {
    setSceneTick(0);
  }, [scene]);

  const selectScene = useCallback(
    (next: SceneId) => {
      setScene(next);
      if (Number.isFinite(cid)) {
        writeStoredScene(cid, next);
        void api.post(`${API}/campaigns/${cid}/cast-sessions/scene`, { scene: next }).catch(() => {
          // ignore errors, fallback to local storage
        });
      }
    },
    [cid],
  );

  // Player-safe scene projection — derived once so the stage render and the
  // auto-rotate decision below agree on what is on screen (issue #823).
  const view = useMemo(() => {
    if (!summary) return null;
    const location = safeLocation(summary.currentLocation);
    // During a live fight, prefer PCs seated as combatants over the full active
    // roster (issue #824); monster-only fights fall back to active-only.
    const participatingCharacterIds = participatingIdsFromEncounter(encounter);
    const party = safeParty(summary.party, { includeAlumni, participatingCharacterIds });
    const quests = safeQuests(summary.quests);
    const npcs = safeNpcs(summary.npcs);
    const combatants = encounter ? safeCombatants(encounter.combatants) : [];
    const currentId =
      encounter && encounter.status === 'running' ? encounter.currentCombatantId ?? null : null;
    const currentIndex = currentId != null ? combatants.findIndex((c) => c.id === currentId) : -1;
    const nextIndex = nextActorIndex(combatants.length, currentIndex);
    return { location, party, quests, npcs, combatants, currentId, currentIndex, nextIndex };
  }, [summary, encounter, includeAlumni]);

  // A scene auto-rotates only when its content spills past a single stage page —
  // then the timer surfaces the off-screen rows instead of clipping them.
  const rotating = useMemo(() => {
    if (!view) return false;
    if (scene === 'initiative') return pageCountFor(view.combatants.length, INIT_PAGE_SIZE) > 1;
    if (scene === 'party') return view.party.length > PARTY_PAGE_SIZE;
    if (scene === 'quests')
      return view.quests.length > QUEST_PAGE_SIZE || view.npcs.length > NPC_PAGE_SIZE;
    return false;
  }, [view, scene]);

  useEffect(() => {
    if (!rotating || prefersReducedMotion()) return;
    const timer = setInterval(() => setSceneTick((tick) => tick + 1), SCENE_ROTATE_MS);
    return () => clearInterval(timer);
  }, [rotating]);

  const syncState = playerDisplaySyncState({ staleIdentity: isCastMode ? false : staleIdentity, displayStale, eventStatus });
  const syncMessage = summary ? playerDisplaySyncMessage(syncState) : null;

  // The ARIA live region is a single node mounted at the app root (Announcer),
  // so it survives client-side navigation. The DM's run-session tracker announces
  // EXACT monster HP ("Ash Cultist: 22 of 22 hit points", issue #93) into it; if
  // the DM then opens this cast view that stale, secret-leaking text would linger
  // in the DOM / be read by assistive tech on the shared screen (issue #232).
  // Wipe it on mount so nothing exact carries over onto this secret-free surface.
  useEffect(() => {
    announce('');
  }, [announce]);

  // Announce combat changes for assistive tech on the cast device — but from the
  // PLAYER-SAFE projection: characters keep exact HP (shared table info), monsters
  // are announced as a coarse band only ("Ash Cultist: Bloodied"), mirroring the
  // #43 API redaction. Never announce a monster's exact 'N of M hit points'.
  const prevAnnounceRef = useRef<{ hp: Map<number, string>; turnKey: string } | null>(null);
  useEffect(() => {
    if (!encounter) {
      prevAnnounceRef.current = null;
      return;
    }
    const safe = safeCombatants(encounter.combatants);
    const currentId = encounter.status === 'running' ? encounter.currentCombatantId ?? null : null;
    const turnKey =
      encounter.status === 'running' ? `${encounter.round}:${currentId}` : encounter.status;
    // Player-safe HP signature per combatant: band for monsters, exact for characters.
    const sig = (c: SafeCombatant): string =>
      c.hpBand != null
        ? `band:${c.hpBand}`
        : c.hpCurrent != null && c.hpMax != null
          ? `hp:${c.hpCurrent}/${c.hpMax}`
          : '';
    const hp = new Map(safe.map((c) => [c.id, sig(c)]));
    const prev = prevAnnounceRef.current;

    if (prev) {
      const parts: string[] = [];
      if (turnKey !== prev.turnKey) {
        if (encounter.status === 'running') {
          const current = safe.find((c) => c.id === currentId);
          parts.push(`Round ${encounter.round}${current ? ` — ${current.name}'s turn` : ''}`);
        } else if (encounter.status === 'ended') {
          parts.push('Encounter ended');
        }
      }
      const combatantUpdates: string[] = [];
      for (const c of safe) {
        const before = prev.hp.get(c.id);
        const now = hp.get(c.id);
        if (before == null || now == null || now === '' || before === now) continue;
        if (c.hpBand != null) {
          // Monster — band label only, never the exact numbers.
          combatantUpdates.push(`${c.name}: ${HP_BAND_LABEL[c.hpBand]}`);
        } else if (c.hpCurrent != null && c.hpMax != null) {
          // Character — exact HP is shared table info.
          combatantUpdates.push(`${c.name}: ${c.hpCurrent} of ${c.hpMax} hit points`);
        }
      }
      const combatantMessage = formatGroupedCombatantAnnouncement(combatantUpdates);
      if (combatantMessage) parts.push(combatantMessage);
      // One atomic announce keeps turn + bulk HP/condition updates from racing
      // the shared live region; dedupeKey suppresses identical reconnect refetches.
      // Fingerprint + count keep the key bounded (avoid joining full update text).
      const message = formatGroupedAnnouncement(parts);
      if (message) {
        announce(message, {
          dedupeKey: `screen:${cid}:${encounter.id}:${turnKey}:${combatantUpdates.length}:${fingerprintDedupeParts(combatantUpdates)}`,
        });
      }
    }
    prevAnnounceRef.current = { hp, turnKey };
  }, [cid, encounter, announce]);

  // Map-scene a11y: announce token moves and AoE changes from the player-safe projection.
  const prevMapAnnounceRef = useRef<{ tokens: Map<number, string>; aoe: string } | null>(null);
  useEffect(() => {
    if (!encounter || scene !== 'map') {
      prevMapAnnounceRef.current = null;
      return;
    }
    const safe = safeEncounterForCast(encounter);
    const tokenSig = new Map(
      safe.combatants
        .filter((c) => c.tokenX != null && c.tokenY != null)
        .map((c) => [c.id, `${c.tokenX},${c.tokenY}`] as const),
    );
    const aoeSig = (safe.aoe ?? []).map((t) => `${t.id}:${t.x},${t.y},${t.sizeFt}`).join('|');
    const prev = prevMapAnnounceRef.current;
    if (prev) {
      const parts: string[] = [];
      for (const c of safe.combatants) {
        const before = prev.tokens.get(c.id);
        const now = tokenSig.get(c.id);
        if (before != null && now != null && before !== now) {
          parts.push(`${c.name} moved on the map`);
        } else if (before == null && now != null) {
          parts.push(`${c.name} placed on the map`);
        }
      }
      if (aoeSig !== prev.aoe) {
        const count = safe.aoe?.length ?? 0;
        if (count > 0) {
          parts.push(count === 1 ? 'Area effect updated on the map' : `${count} area effects on the map`);
        }
      }
      const message = formatGroupedAnnouncement(parts);
      if (message) {
        announce(message, {
          dedupeKey: `screen-map:${cid}:${encounter.id}:${aoeSig}:${[...tokenSig.values()].join('|')}`,
        });
      }
    }
    prevMapAnnounceRef.current = { tokens: tokenSig, aoe: aoeSig };
  }, [cid, encounter, scene, announce]);

  // Fullscreen can end without this control being used (Escape, browser chrome,
  // or another caller), so the browser events — not the request promise — own
  // the displayed state. fullscreenerror also catches failures that are not
  // accompanied by a useful rejected value.
  const syncFullscreen = useCallback(() => {
    const next = fullscreenActive();
    const previous = fullscreenActiveRef.current;
    fullscreenActiveRef.current = next;
    setIsFullscreen(next);
    setFullscreenSupported(fullscreenAvailable());
    if (previous && !next) {
      setFullscreenNotice({
        kind: 'info',
        message: 'Fullscreen ended. Select Enter fullscreen to start it again.',
      });
    } else if (!previous && next) {
      setFullscreenNotice(null);
    }
  }, []);

  useEffect(() => {
    const handleFullscreenError = () => {
      setFullscreenSupported(fullscreenAvailable());
      setFullscreenNotice((prev) =>
        prev?.kind === 'error'
          ? prev
          : {
              kind: 'error',
              message:
                'Fullscreen failed. Keep this tab active, allow fullscreen for this site, and try again. You can also use the browser presentation controls.',
            },
      );
    };

    document.addEventListener('fullscreenchange', syncFullscreen);
    document.addEventListener('fullscreenerror', handleFullscreenError);
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreen);
      document.removeEventListener('fullscreenerror', handleFullscreenError);
    };
  }, [syncFullscreen]);

  // Auto-hide the exit/fullscreen controls after a few idle seconds so the cast
  // is clean. Pointer, touch, keyboard, and focus activity all bring them back;
  // focused controls and recovery guidance remain visible.
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let active = true;

    function clearHideTimer() {
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }

    function scheduleHide() {
      clearHideTimer();
      hideTimer.current = setTimeout(() => {
        hideTimer.current = null;
        if (!controlsRef.current?.contains(document.activeElement)) setControlsVisible(false);
      }, CONTROLS_HIDE_MS);
    }

    function ping(event?: Event) {
      setControlsVisible(true);
      if (
        event?.type === 'focusin' &&
        event.target instanceof Node &&
        controlsRef.current?.contains(event.target)
      ) {
        clearHideTimer();
      } else {
        scheduleHide();
      }
    }

    function reportFullscreenExitFailure(error: unknown) {
      if (!active) return;
      setFullscreenSupported(fullscreenAvailable());
      setFullscreenNotice({ kind: 'error', message: fullscreenFailure('exit', error) });
    }

    function handleKeyDown(event: KeyboardEvent) {
      // Drop inert synchronously so this same Tab keystroke can land on Exit /
      // Fullscreen before React re-renders visibility (issue #595).
      controlsRef.current?.removeAttribute('inert');
      ping(event);
      if (event.key !== 'Escape' || event.defaultPrevented || event.repeat) return;

      event.preventDefault();
      if (fullscreenActive()) {
        // Handle this ourselves so fullscreen state is sampled before a browser
        // (or test double) processes its own Escape behavior. This guarantees
        // the same keypress cannot both leave fullscreen and navigate away.
        try {
          // fullscreenchange is the authoritative state transition. Avoid a
          // promise continuation that can outlive this route after a second
          // Escape navigates away.
          void document.exitFullscreen().catch(reportFullscreenExitFailure);
        } catch (fullscreenError) {
          reportFullscreenExitFailure(fullscreenError);
        }
        return;
      }

      if (isCastMode) {
        setExitPromptOpen(true);
        setExitError(null);
      } else {
        navigate(Number.isFinite(cid) ? `/c/${cid}` : '/');
      }
    }

    window.addEventListener('pointermove', ping, { passive: true });
    window.addEventListener('pointerdown', ping, { passive: true });
    // Capture is intentional: the browser may leave fullscreen before a bubble-
    // phase listener runs, which would make one Escape also exit this route.
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('focusin', ping);
    window.addEventListener('focusout', ping);
    ping();
    return () => {
      active = false;
      window.removeEventListener('pointermove', ping);
      window.removeEventListener('pointerdown', ping);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('focusin', ping);
      window.removeEventListener('focusout', ping);
      clearHideTimer();
    };
  }, [cid, isCastMode, navigate]);

  const toggleFullscreen = useCallback(async () => {
    if (!fullscreenAvailable()) {
      setFullscreenSupported(false);
      // Unsupported fullscreen is derived as an informational notice below. Do
      // not retain a second error notice that could resurface if capability is
      // later restored by the browser or display environment.
      setFullscreenNotice(null);
      return;
    }

    const action = fullscreenActive() ? 'exit' : 'enter';
    setFullscreenPending(true);
    setFullscreenNotice(null);
    try {
      if (action === 'exit') {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
      // Standards-compliant browsers dispatch fullscreenchange before resolving,
      // but synchronizing here also handles implementations that resolve first.
      syncFullscreen();
    } catch (fullscreenError) {
      setFullscreenSupported(fullscreenAvailable());
      setFullscreenNotice({ kind: 'error', message: fullscreenFailure(action, fullscreenError) });
    } finally {
      // The async browser operation — not fullscreenchange/fullscreenerror — owns
      // pending state. Browsers may dispatch either event before the promise
      // settles, and the control must remain busy/disabled until it actually does.
      setFullscreenPending(false);
    }
  }, [syncFullscreen]);

  // On SPA exit the document remains alive, so pagehide alone cannot notify the
  // cockpit. Publish a close from the component's actual unmount path as well.
  // This effect keys only on campaign identity: normal encounter refreshes must
  // not briefly report the display as closed. Only the managed cast popup should
  // report status; other `/screen` previews or `/cast` links must stay silent.
  useEffect(() => {
    if (!isManagedCastWindow) return;
    return () => {
      const closed: CastDisplayStatus = { type: 'closed', campaignId: cid };
      try {
        window.opener?.postMessage(closed, window.location.origin);
      } catch {
        /* opener closed while the display unmounted */
      }
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel(CAST_DISPLAY_CHANNEL);
        channel.postMessage(closed);
        channel.close();
      }
    };
  }, [cid, isManagedCastWindow]);

  // The separate window reports only operational state back to the cockpit.
  // In particular, neither the cast URL nor its bearer token is ever sent over
  // postMessage/BroadcastChannel (the URL itself is the #547 credential).
  // Only the managed cast popup publishes status; other tabs must stay silent.
  useEffect(() => {
    if (!Number.isFinite(cid) || !isManagedCastWindow) return;
    // The encounter name has already crossed the server's player-safe projection
    // boundary. It is status metadata, not a cast credential or DM-only detail.
    const status = (): CastDisplayStatus => ({
      type: 'ready',
      campaignId: cid,
      encounterId: encounter?.id ?? null,
      encounterName: encounter?.name ?? null,
    });
    const publish = (message: CastDisplayStatus) => {
      try {
        window.opener?.postMessage(message, window.location.origin);
      } catch {
        // An opener can disappear while the display navigates; BroadcastChannel
        // and the on-screen controls remain independent recovery paths.
      }
    };
    publish(status());
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CAST_DISPLAY_CHANNEL);
    channel?.postMessage(status());
    const onPageHide = () => {
      const closed: CastDisplayStatus = { type: 'closed', campaignId: cid };
      publish(closed);
      channel?.postMessage(closed);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      channel?.close();
    };
  }, [cid, encounter?.id, encounter?.name, isManagedCastWindow]);

  // A popup opened by the DM is allowed to *ask* for fullscreen in its own
  // browsing context. Browsers that require an additional activation reject it;
  // toggleFullscreen turns that into the existing explicit, recoverable notice.
  // Direct `/cast` links and normal `/screen` previews keep their manual control.
  useEffect(() => {
    if (window.name !== CAST_WINDOW_NAME || !isCastMode || autoFullscreenAttemptedRef.current) return;
    autoFullscreenAttemptedRef.current = true;
    void toggleFullscreen();
  }, [isCastMode, toggleFullscreen]);

  const displayedFullscreenNotice = fullscreenSupported
    ? fullscreenNotice
    : ({ kind: 'info', message: FULLSCREEN_UNSUPPORTED } satisfies FullscreenNotice);
  const keepControlsVisible = controlsVisible || displayedFullscreenNotice != null;
  // Auto-hidden controls must leave the sequential focus / a11y tree until a
  // keyboard or pointer reveal — opacity alone left Exit/Fullscreen tabbable
  // while invisible (issue #595). Fullscreen notices force visibility so
  // recovery guidance stays reachable.
  useLayoutEffect(() => {
    const node = controlsRef.current;
    if (!node) return;
    if (keepControlsVisible) node.removeAttribute('inert');
    else node.setAttribute('inert', '');
  }, [keepControlsVisible]);
  const [searchParams] = useSearchParams();
  const fromPath = searchParams.get('from');
  const exitPath = fromPath ? fromPath : Number.isFinite(cid) ? `/c/${cid}` : '/';
  const requestExit = useCallback(() => {
    if (isCastMode) {
      setExitPromptOpen(true);
      setExitError(null);
      return;
    }
    navigate(exitPath);
  }, [exitPath, isCastMode, navigate]);
  const verifyCastExit = useCallback(async () => {
    if (!castToken) return;
    setExitPending(true);
    setExitError(null);
    try {
      await castRequest<{ ok: true }>(castToken, `${API}/cast/${castToken}/exit`, {
        method: 'POST',
        json: { pin: exitPin },
      });
      navigate(loginHrefWithReturn(exitPath));
    } catch (err) {
      setExitError(err instanceof ApiError ? err.message : "Couldn't verify the cast exit PIN.");
    } finally {
      setExitPending(false);
    }
  }, [castToken, exitPath, exitPin, navigate]);
  const operatorControls = (
    <div
      ref={controlsRef}
      className="cf-screen-control-stack"
      data-visible={keepControlsVisible ? 'true' : 'false'}
    >
      <div className="cf-screen-controls">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={requestExit}
          aria-label={isCastMode ? 'Exit kiosk' : 'Exit player display'}
          title={isCastMode ? 'Exit kiosk' : 'Exit the display'}
        >
          <UIIcon name="close" size="xs" /> {isCastMode ? 'Exit kiosk' : 'Exit'}
        </button>
        {role === 'dm' && scene === 'party' && (
          <label className="cf-screen-alumni-toggle" title="Show dead, retired, and inactive PCs on the Party scene">
            <input
              type="checkbox"
              checked={includeAlumni}
              onChange={(event) => setIncludeAlumni(event.target.checked)}
            />
            <span>Include alumni / inactive</span>
          </label>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void toggleFullscreen()}
          disabled={!fullscreenSupported || fullscreenPending}
          aria-pressed={isFullscreen}
          aria-busy={fullscreenPending}
          aria-describedby={displayedFullscreenNotice ? 'cf-screen-fullscreen-notice' : undefined}
          title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          <span aria-hidden="true">⛶</span> {isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        </button>
      </div>
      {role === 'dm' && (
        <div className="cf-cockpit" data-testid="cf-cockpit">
          <div className="cf-scene-picker" role="group" aria-label="Broadcast scene" data-testid="cf-scene-picker">
            {SCENE_IDS.map((id) => (
              <button
                key={id}
                type="button"
                className={`btn btn-ghost cf-scene-btn${scene === id ? ' active' : ''}`}
                data-testid={`cf-scene-btn-${id}`}
                aria-pressed={scene === id}
                onClick={() => selectScene(id)}
              >
                {SCENE_LABEL[id]}
              </button>
            ))}
          </div>
          <div className="cf-cockpit-row">
            <div className="cf-aspect-toggle" role="group" aria-label="Stage aspect ratio">
              {(['16:9', '4:3'] as const).map((ratio) => (
                <button
                  key={ratio}
                  type="button"
                  className={`btn btn-ghost cf-aspect-btn${aspect === ratio ? ' active' : ''}`}
                  data-testid={`cf-aspect-btn-${ratio === '16:9' ? '16-9' : '4-3'}`}
                  aria-pressed={aspect === ratio}
                  onClick={() => setAspect(ratio)}
                >
                  {ratio}
                </button>
              ))}
            </div>
            {rotating && (
              <div className="cf-page-controls" role="group" aria-label="Page through off-screen entries">
                <button
                  type="button"
                  className="btn btn-ghost"
                  data-testid="cf-scene-prev-page"
                  onClick={() => setSceneTick((tick) => tick - 1)}
                  title="Show the previous set"
                  aria-label="Previous page"
                >
                  <span aria-hidden="true">‹</span> Prev
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  data-testid="cf-scene-next-page"
                  onClick={() => setSceneTick((tick) => tick + 1)}
                  title="Show the next set"
                  aria-label="Next page"
                >
                  Next <span aria-hidden="true">›</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {displayedFullscreenNotice && (
        <p
          id="cf-screen-fullscreen-notice"
          className={`cf-screen-fullscreen-notice ${displayedFullscreenNotice.kind === 'error' ? 'error' : ''}`}
          role={displayedFullscreenNotice.kind === 'error' ? 'alert' : 'status'}
        >
          {displayedFullscreenNotice.message}
        </p>
      )}
      {(wakeLock.status === 'unavailable' || wakeLock.status === 'error') && wakeLock.message && (
        <p
          className="cf-screen-wakelock-notice"
          role="status"
          aria-live="polite"
        >
          {wakeLock.message}
        </p>
      )}
    </div>
  );
  const renderScreen = (content: ReactNode, centered = false) => (
    // Issue #1685: `.cf-screen` on THIS <main> is what most selectors in SCREEN_CSS
    // are ancestor-scoped to (`.cf-screen .whatever { … }`, see SCREEN_CSS below). A
    // <style> element applies document-wide regardless of its position in the DOM tree,
    // so nesting it inside <main> alone provided no scoping — the ancestor class on each
    // non-portalled selector is what actually confines those rules to this subtree.
    <main className={`cf-screen${centered ? ' centered' : ''}`}>
      <style>{SCREEN_CSS}</style>
      {operatorControls}
      {content}
      {exitPromptOpen && isCastMode && (
        <CastExitPinDialog
          pin={exitPin}
          onPinChange={setExitPin}
          error={exitError}
          pending={exitPending}
          onCancel={() => setExitPromptOpen(false)}
          onSubmit={() => void verifyCastExit()}
        />
      )}
    </main>
  );

  if (!Number.isFinite(cid)) {
    return renderScreen(<CenteredMessage icon="tv" title="No campaign selected." />, true);
  }
  if (!isCastMode && role == null && !loading) {
    return renderScreen(
      <CenteredMessage icon="padlock" title="You don't have access to this campaign.">
        <Link to="/" className="btn btn-primary" style={{ marginTop: 12 }}>
          Back to your campaigns
        </Link>
      </CenteredMessage>,
      true,
    );
  }
  if (loading && !summary) {
    return renderScreen(<CenteredMessage icon="campfire" title="Loading display…" pulse />, true);
  }
  if (error && !summary) {
    return renderScreen(
      <CenteredMessage icon="hazard-sign" title={error}>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => void load()}>
          Retry
        </button>
      </CenteredMessage>,
      true,
    );
  }
  if (!summary || !view) return null;

  const { location, party, quests, npcs, combatants, currentId, currentIndex, nextIndex } = view;
  const isRunning = encounter?.status === 'running';
  const currentActor = currentIndex >= 0 ? combatants[currentIndex] ?? null : null;
  const nextActor = nextIndex >= 0 ? combatants[nextIndex] ?? null : null;
  const ratio = ASPECT_RATIO[aspect];
  const stageStyle = {
    '--cf-ar-w': String(ratio.w),
    '--cf-ar-h': String(ratio.h),
  } as CSSProperties;

  // Persistent status band — encounter/round/current+next actor stay put across
  // every scene swap (issue #823). Kept OUTSIDE the swappable scene body.
  const statusBand = (
    <header className="cf-status-band" data-testid="cf-status-band">
      <div className="cf-status-lead">
        <h1 className="cf-status-campaign" title={summary.campaign.name}>
          {summary.campaign.name}
        </h1>
        {location ? (
          <span className="cf-screen-chip cf-screen-chip-accent cf-status-location">
            {location.isCurrent ? (
              <GameIcon slug="position-marker" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />
            ) : null}
            <span className="cf-clamp-1">{location.name}</span>
          </span>
        ) : (
          <span className="cf-screen-chip">Location unset</span>
        )}
      </div>
      <div className="cf-status-combat" data-testid="cf-status-combat">
        {isRunning ? (
          <>
            <span className="cf-status-enc cf-clamp-1" data-testid="cf-status-encounter" title={encounter.name}>
              {encounter.name}
            </span>
            <span className="cf-status-round" data-testid="cf-status-round">
              Round {encounter.round}
            </span>
            <span className="cf-status-turn" data-testid="cf-status-current">
              <span className="cf-status-turn-label">Now</span>
              <span className="cf-status-turn-name cf-clamp-1">{currentActor?.name ?? '—'}</span>
            </span>
            <span className="cf-status-turn cf-status-next" data-testid="cf-status-next">
              <span className="cf-status-turn-label">Next</span>
              <span className="cf-status-turn-name cf-clamp-1">{nextActor?.name ?? '—'}</span>
            </span>
          </>
        ) : (
          <span className="cf-status-idle" data-testid="cf-status-idle">
            No live encounter
          </span>
        )}
      </div>
      {syncMessage && (
        <p
          role="status"
          aria-live="polite"
          className={`cf-screen-sync ${syncState === 'offline' ? 'offline' : ''}`}
        >
          {syncMessage}
        </p>
      )}
      {liveActivity.mode === 'driver' && liveActivity.lastNarration && (
        <p className="cf-ai-ticker">
          <GameIcon slug="robot-golem" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />
          <span className="cf-clamp-2">{liveActivity.lastNarration}</span>
        </p>
      )}
    </header>
  );

  let sceneContent: ReactNode;
  switch (scene) {
    case 'map':
      sceneContent =
        encounter?.mapAttachmentId != null ? (
          <section className="cf-scene cf-scene-map" data-testid="cf-scene-map-body" aria-label="Map">
            <BattleMap
              projection="cast"
              castToken={isCastMode ? castToken : null}
              encounter={safeEncounterForCast(encounter)}
              campaignId={cid}
              isDm={false}
              viewerUserId={null}
              canDmWrite={false}
              busy={false}
              canMoveToken={() => false}
              onSetMap={() => {}}
              onMoveToken={() => {}}
              onUnplaceToken={() => {}}
              onSetGrid={() => {}}
              onSetFog={() => {}}
              onSetAoe={() => {}}
              onPing={() => {}}
              pings={mapPings}
              onDismissPing={dismissMapPing}
              onError={() => {}}
              ruleSystem={summary.campaign.ruleSystem ?? null}
            />
          </section>
        ) : (
          <MapScene locationName={location?.name ?? null} />
        );
      break;
    case 'party':
      sceneContent = <PartyScene party={party} includeAlumni={includeAlumni} tick={sceneTick} />;
      break;
    case 'quests':
      sceneContent = <QuestsScene quests={quests} npcs={npcs} tick={sceneTick} />;
      break;
    case 'intermission':
      sceneContent = (
        <IntermissionScene campaignName={summary.campaign.name} locationName={location?.name ?? null} />
      );
      break;
    case 'blackout':
      sceneContent = <BlackoutScene />;
      break;
    case 'initiative':
    default:
      sceneContent = (
        <InitiativeScene
          combatants={combatants}
          currentId={currentId}
          currentIndex={currentIndex}
          tick={sceneTick}
          railError={error}
          onRetry={() => void load()}
        />
      );
      break;
  }

  return renderScreen(
    <div className="cf-stage-wrap">
      <div
        className="cf-stage"
        data-testid="cf-stage"
        data-scene={scene}
        data-aspect={aspect}
        style={stageStyle}
      >
        {scene !== 'blackout' && statusBand}
        <div className="cf-scene-body" data-testid={`cf-scene-${scene}`} data-scene={scene}>
          {sceneContent}
        </div>
        {/* #599 / #1908 — the shared display's half of the safety hold. A TV in the corner of
            the room cannot raise a hold (on the /cast token route it has no member identity at
            all), but it absolutely must stop showing the fight when one is raised: a monitor
            still rendering initiative order through a safety stop is the loudest possible way
            for this feature to fail. The cast-token client cannot read the member-scoped safety
            endpoint, so it polls the anonymous `/cast/:token/safety` capability instead
            (`loadCastSafety` above) and renders the same overlay markup via
            `SafetyHoldOverlayView`. Renders active until the first poll actually succeeds
            (`!castSafetyKnown`) — "no hold" and "never successfully checked" must not look
            the same as an open display. */}
        {isCastMode ? (
          <SafetyHoldOverlayView active={castSafetyActive || !castSafetyKnown} />
        ) : (
          <SafetyHoldDisplayOverlay campaignId={cid} />
        )}
      </div>
    </div>,
  );
}

/**
 * Kiosk-exit PIN prompt (issue #547).
 *
 * Portalled to <body> rather than rendered inside `.cf-screen-control-stack`: that
 * container auto-hides after CONTROLS_HIDE_MS (opacity:0 + pointer-events:none, plus
 * an `inert` attribute), so a dialog nested in it could be stranded invisible and
 * non-interactive the moment focus left the input — e.g. after a backdrop click.
 * Goes through useDialog for the app-standard Escape-to-close, focus trap, focus
 * restore, and inert background.
 */
function CastExitPinDialog({
  pin,
  onPinChange,
  error,
  pending,
  onCancel,
  onSubmit,
}: {
  pin: string;
  onPinChange: (value: string) => void;
  error: string | null;
  pending: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialog<HTMLDivElement>({
    onClose: onCancel,
    disabled: pending,
    inertBackground: true,
    initialFocusRef: inputRef,
  });
  return createPortal(
    <div
      ref={dialogRef}
      className="cf-exit-pin"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cf-exit-pin-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <h2 id="cf-exit-pin-title">Exit kiosk mode?</h2>
        <p>Enter the cast exit PIN, then sign in again before returning to DM controls.</p>
        <label htmlFor="cf-exit-pin-input">Exit PIN</label>
        <input
          id="cf-exit-pin-input"
          ref={inputRef}
          className="input"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(event) => onPinChange(event.target.value)}
        />
        {error && <p role="alert" className="cf-exit-pin-error">{error}</p>}
        <div className="cf-exit-pin-actions">
          <button type="button" className="btn btn-ghost" disabled={pending} onClick={onCancel}>
            Stay on display
          </button>
          <button type="submit" className="btn btn-primary" disabled={pending || pin.trim().length === 0} aria-busy={pending}>
            Verify and sign in
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Scenes. Each fills the fixed stage body (flex column, overflow hidden). Long
// lists paginate/rotate via playerDisplayScene so nothing falls below the fold.

function SceneEmpty({ icon, title, subtitle }: { icon: string; title: string; subtitle?: string }) {
  return (
    <div className="cf-scene-empty" role="status">
      <GameIcon slug={icon} size={72} reserveSpace />
      <p className="cf-scene-empty-title">{title}</p>
      {subtitle && <p className="cf-scene-empty-sub">{subtitle}</p>}
    </div>
  );
}

function MapScene({ locationName }: { locationName: string | null }) {
  return (
    <section className="cf-scene cf-scene-map" data-testid="cf-scene-map-body" aria-label="Map">
      <SceneEmpty
        icon="treasure-map"
        title={locationName ?? 'No map to display'}
        subtitle="Upload a battle map to the live encounter to project it here."
      />
    </section>
  );
}

function InitiativeScene({
  combatants,
  currentId,
  currentIndex,
  tick,
  railError,
  onRetry,
}: {
  combatants: SafeCombatant[];
  currentId: number | null;
  currentIndex: number;
  tick: number;
  railError: string | null;
  onRetry: () => void;
}) {
  if (combatants.length === 0) {
    return (
      <section className="cf-scene cf-scene-initiative" aria-label="Initiative">
        <h2 className="cf-scene-title">Initiative</h2>
        {railError ? (
          <>
            <p className="cf-scene-empty-title" role="alert">
              {railError}
            </p>
            <button className="btn btn-primary cf-rail-retry" onClick={onRetry}>
              Retry
            </button>
          </>
        ) : (
          <SceneEmpty icon="crossed-swords" title="No combat in progress" subtitle="Start an encounter to show the turn order." />
        )}
      </section>
    );
  }

  const win = initiativeWindow(combatants.length, INIT_PAGE_SIZE, currentIndex, tick);
  const page = combatants.slice(win.start, win.end);
  return (
    <section className="cf-scene cf-scene-initiative" aria-label="Initiative">
      <h2 className="cf-scene-title">
        Initiative
        {win.pageCount > 1 && (
          <span className="cf-scene-pageflag" data-testid="cf-init-page">
            Turns {win.start + 1}–{win.end} of {combatants.length}
          </span>
        )}
      </h2>
      <ol className="cf-init-list">
        {page.map((c) => (
          <InitiativeRow key={c.id} combatant={c} isCurrent={c.id === currentId} tick={tick} />
        ))}
      </ol>
    </section>
  );
}

function PartyScene({
  party,
  includeAlumni,
  tick,
}: {
  party: PartyCharacter[];
  includeAlumni: boolean;
  tick: number;
}) {
  const page = rotateWindow(party, PARTY_PAGE_SIZE, tick);
  const overflow = hiddenCount(party.length, PARTY_PAGE_SIZE);
  return (
    <section className="cf-scene cf-scene-party" aria-label="Party">
      <h2 className="cf-scene-title">
        Party
        {overflow > 0 && (
          <span className="cf-scene-pageflag" data-testid="cf-party-page">
            Showing {page.length} of {party.length}
          </span>
        )}
      </h2>
      {party.length === 0 ? (
        <SceneEmpty
          icon="backpack"
          title={includeAlumni ? 'No characters yet.' : 'No active party members.'}
        />
      ) : (
        <div className="cf-party">
          {page.map((c) => {
            const pct = c.hpMax > 0 ? Math.max(0, Math.min(100, (c.hpCurrent / c.hpMax) * 100)) : 0;
            const tone = pct <= 25 ? 'crit' : pct <= 50 ? 'low' : '';
            const isActive = c.status === 'active';
            return (
              <div
                key={c.id}
                className={`cf-party-card${isActive ? '' : ' alumni'}`}
                data-character-status={c.status}
              >
                <div className="cf-party-top">
                  <span className="cf-party-name">
                    {c.portraitUrl ? (
                      <img
                        src={c.portraitUrl}
                        alt=""
                        style={{ width: '3.2cqh', height: '3.2cqh', borderRadius: '50%', objectFit: 'cover' }}
                      />
                    ) : (
                      <span
                        style={{
                          width: '3.2cqh',
                          height: '3.2cqh',
                          borderRadius: '50%',
                          background: 'var(--color-accent-900)',
                          color: 'var(--color-accent-200)',
                          display: 'grid',
                          placeItems: 'center',
                          fontSize: '1.6cqh',
                          fontWeight: 500,
                        }}
                      >
                        {initials(c.name)}
                      </span>
                    )}
                    <span className="cf-clamp-1" title={c.name}>
                      {c.name}
                    </span>
                    {!isActive && (
                      <span className="cf-screen-chip cf-screen-chip-sm cf-party-status">{STATUS_LABEL[c.status]}</span>
                    )}
                  </span>
                  {c.ac != null && <span className="cf-screen-chip cf-screen-chip-sm">AC {c.ac}</span>}
                </div>
                <div className="cf-party-sub">
                  {[c.species, c.className && `${c.className} ${c.level}`].filter(Boolean).join(' · ') ||
                    `Level ${c.level}`}
                </div>
                <div className="cf-hp-row">
                  <div className={`cf-screen-hp ${tone}`}>
                    <div style={{ width: `${pct}%` }} />
                  </div>
                  <span className="cf-hp-num">
                    {c.hpCurrent}/{c.hpMax}
                  </span>
                </div>
                <ConditionChips conditions={c.conditions} tick={tick} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function QuestsScene({
  quests,
  npcs,
  tick,
}: {
  quests: SafeQuest[];
  npcs: SafeNpc[];
  tick: number;
}) {
  const questPage = rotateWindow(quests, QUEST_PAGE_SIZE, tick);
  const questOverflow = hiddenCount(quests.length, QUEST_PAGE_SIZE);
  const npcPage = rotateWindow(npcs, NPC_PAGE_SIZE, tick);
  const npcOverflow = hiddenCount(npcs.length, NPC_PAGE_SIZE);
  return (
    <section className="cf-scene cf-scene-quests" aria-label="Quests">
      <h2 className="cf-scene-title">
        Quests
        {questOverflow > 0 && (
          <span className="cf-scene-pageflag" data-testid="cf-quests-page">
            Showing {questPage.length} of {quests.length}
          </span>
        )}
      </h2>
      {quests.length === 0 ? (
        <SceneEmpty icon="scroll-quill" title="No active quests." />
      ) : (
        <div className="cf-quests">
          {questPage.map((q) => {
            // Objectives rotate through a bounded window so a long list never hides
            // an item for good — it just takes turns on screen (issue #823).
            const objPage = rotateWindow(q.objectives, 4, tick);
            return (
              <div key={q.id} className="cf-quest">
                <div className="cf-quest-top">
                  <span className="cf-quest-title cf-clamp-1" title={q.title}>
                    {q.title}
                  </span>
                  <QuestStatusBadge status={q.status} className="cf-screen-chip cf-screen-chip-sm" iconSize={14} />
                </div>
                {q.objectives.length > 0 && (
                  <ul className="cf-objs">
                    {objPage.map((o) => (
                      <li key={o.id} className={o.done ? 'done' : ''}>
                        <span className="cf-obj-mark">{o.done ? '✓' : '○'}</span>
                        <span className="cf-obj-text cf-clamp-2">{o.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
      {npcs.length > 0 && (
        <>
          <h3 className="cf-npc-head">
            Faces you know
            {npcOverflow > 0 && (
              <span className="cf-scene-pageflag" data-testid="cf-npcs-page">
                {' '}
                Showing {npcPage.length} of {npcs.length}
              </span>
            )}
          </h3>
          <div className="cf-npcs">
            {npcPage.map((n) => (
              <div key={n.id} className="cf-npc">
                <span className="cf-npc-name cf-clamp-1" title={n.name}>
                  {n.name}
                </span>
                {n.role && <span className="cf-npc-role cf-clamp-1">{n.role}</span>}
                <NpcDispositionBadge
                  disposition={n.disposition}
                  className="cf-screen-chip cf-screen-chip-sm cf-npc-disposition"
                  iconSize={14}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function IntermissionScene({
  campaignName,
  locationName,
}: {
  campaignName: string;
  locationName: string | null;
}) {
  return (
    <section className="cf-scene cf-scene-intermission cf-intermission" aria-label="Intermission">
      <GameIcon slug="campfire" size={96} reserveSpace />
      <h2>We'll be right back</h2>
      <p>{campaignName}</p>
      {locationName && <p className="cf-intermission-loc">{locationName}</p>}
    </section>
  );
}

function BlackoutScene() {
  return (
    <section
      className="cf-blackout"
      data-testid="cf-scene-blackout-body"
      role="status"
      aria-label="Display paused"
    />
  );
}

/** Conditions clamp to a rotating window with a "+N" count so none is lost. */
function ConditionChips({ conditions, tick }: { conditions: string[]; tick: number }) {
  if (conditions.length === 0) return null;
  const shown = rotateWindow(conditions, MAX_ROW_CONDITIONS, tick);
  const extra = hiddenCount(conditions.length, MAX_ROW_CONDITIONS);
  return (
    <div className="cf-conds">
      {shown.map((cond) => (
        <span key={cond} className="cf-cond" title={cond}>
          {cond}
        </span>
      ))}
      {extra > 0 && <span className="cf-cond-more">+{extra}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function InitiativeRow({
  combatant,
  isCurrent,
  tick,
}: {
  combatant: SafeCombatant;
  isCurrent: boolean;
  tick: number;
}) {
  // Non-character combatants (monsters AND DM-controlled NPCs) show a coarse HP band,
  // not exact numbers — safeCombatant redacts both, so treat both the same here.
  const isMonster = combatant.kind !== 'character';
  const bandPct = combatant.hpBand ? HP_BAND_PCT[combatant.hpBand] : 0;
  const bandTone = combatant.hpBand ? HP_BAND_TONE[combatant.hpBand] : '';
  const charPct =
    combatant.hpCurrent != null && combatant.hpMax != null && combatant.hpMax > 0
      ? Math.max(0, Math.min(100, (combatant.hpCurrent / combatant.hpMax) * 100))
      : 0;
  const charTone = charPct <= 25 ? 'crit' : charPct <= 50 ? 'low' : '';

  return (
    <li
      className={`cf-init ${isCurrent ? 'current' : ''}`}
      style={{
        opacity: combatant.down ? 0.55 : 1,
        filter: combatant.down ? 'grayscale(0.75)' : 'none',
      }}
    >
      <span className="cf-init-num">{combatant.initiative ?? '–'}</span>
      <div className="cf-init-main">
        <div className="cf-init-name">
          <span
            className="cf-clamp-1"
            title={combatant.name}
            style={combatant.down ? { textDecoration: 'line-through' } : undefined}
          >
            {combatant.down && (
              <GameIcon slug="death-skull" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1.5" />
            )}
            {combatant.name}
          </span>
          <span className={`cf-screen-chip cf-screen-chip-sm ${isMonster ? '' : 'cf-screen-chip-accent'}`}>{combatant.kind === 'npc' ? 'NPC' : combatant.kind}</span>
        </div>
        <ConditionChips conditions={combatant.conditions} tick={tick} />
      </div>
      <div className="cf-init-hp">
        {isMonster ? (
          <>
            <span className="cf-hp-num">{combatant.hpBand ? HP_BAND_LABEL[combatant.hpBand] : '—'}</span>
            <div className={`cf-screen-hp ${bandTone}`}>
              <div style={{ width: `${bandPct}%` }} />
            </div>
          </>
        ) : (
          <>
            <span className="cf-hp-num">
              {combatant.hpCurrent}/{combatant.hpMax}
            </span>
            <div className={`cf-screen-hp ${charTone}`}>
              <div style={{ width: `${charPct}%` }} />
            </div>
          </>
        )}
      </div>
    </li>
  );
}

function CenteredMessage({
  icon,
  title,
  children,
  pulse,
}: {
  icon: string;
  title: string;
  children?: ReactNode;
  pulse?: boolean;
}) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        background: 'var(--color-bg)',
        textAlign: 'center',
        padding: 24,
      }}
    >
      <span className={pulse ? 'animate-pulse' : ''} style={{ display: 'flex', color: 'var(--color-neutral-400)' }}>
        <GameIcon slug={icon} size={56} reserveSpace />
      </span>
      <p style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', margin: 0 }}>{title}</p>
      {children}
    </div>
  );
}

// Cast is a FIXED broadcast stage (issue #823), not a scrolling document. The
// root fills the viewport with overflow hidden; a letterboxed, aspect-locked
// .cf-stage is a size container, so scene typography/spacing use cqh/cqw and
// scale identically at 720p, 1080p, 4K, and 200% zoom. Colors come from the
// shared Nocturne tokens.
//
// Issue #1685: every non-portalled selector below (other than the
// `.cf-screen`/`.cf-screen.centered` root rule itself) is prefixed with the `.cf-screen `
// ancestor — a plain descendant combinator, not `@scope` (this is a TV/cast surface,
// plausibly reached by more unusual browser environments than the rest of the app, and
// a descendant combinator has zero extra browser-support risk vs. the container-query
// units this file already depends on). `.cf-screen` is the outer <main> this stylesheet
// renders inside (see renderScreen above), so this is real, load-bearing scoping — a bare
// `<style>` tag has none of its own from where it sits in the DOM. The kiosk-exit PIN
// dialog is the lone exception because it is portalled to <body>; its unique
// `.cf-exit-pin` selectors must match there. This is IN ADDITION TO, not instead of,
// giving the two previously-colliding families (`cf-chip`→`cf-screen-chip`,
// `cf-hp`→`cf-screen-hp`) unique names: the ancestor prefix confines every rule
// (including ones whose name doesn't currently collide with anything, e.g. `.cf-init`,
// `.cf-cond`) so a future addition anywhere else in the app can never be silently
// reskinned just by sharing a class name with something in here.
const SCREEN_CSS = `
.cf-screen {
  position: relative;
  height: 100vh;
  overflow: hidden;
  background: #000;
  color: var(--color-text);
  font-family: var(--font-body);
}
.cf-screen.centered { display: flex; align-items: center; justify-content: center; }

/* Operator control stack (issue #595 wiring preserved verbatim). z-index sits
   ABOVE --cf-layer-dialog (issue #1908): the safety curtain (.cf-safety-display,
   same tier as every other dialog) is now also this page's fail-safe DEFAULT before
   the first /safety poll succeeds, and can persist indefinitely if that poll keeps
   failing. On the cast/kiosk route the "Exit kiosk" button here is the ONLY affordance
   a touch-only shared TV has -- a curtain that outranks it would strand the device with
   no way to leave kiosk mode without a second device. .cf-exit-pin (the PIN dialog
   this stack opens) sits one tier higher still, so it in turn is never trapped under
   this stack once open. */
.cf-screen .cf-screen-control-stack {
  position: fixed;
  top: 14px;
  right: 14px;
  width: min(460px, calc(100vw - 28px));
  z-index: calc(var(--cf-layer-dialog, 50) + 1);
  opacity: 1;
  pointer-events: auto;
  transition: opacity 0.4s ease;
}
/* Hide only when idle AND focus is not inside — :focus-within keeps a keyboard
   reveal painted even before React flips data-visible (issue #595). */
.cf-screen .cf-screen-control-stack[data-visible="false"]:not(:focus-within) {
  opacity: 0;
  pointer-events: none;
}
.cf-screen .cf-screen-controls {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.cf-screen .cf-screen-alumni-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-surface) 94%, transparent);
  color: var(--color-neutral-200);
  padding: 7px 12px;
  font-size: 13px;
  line-height: 1.3;
  cursor: pointer;
  user-select: none;
}
.cf-screen .cf-screen-alumni-toggle input {
  margin: 0;
  accent-color: var(--color-accent);
}
/* Strong focus ring for cast controls at high zoom / shared-TV distances. */
.cf-screen .cf-screen-controls .btn:focus-visible {
  outline: 3px solid var(--color-accent-2, var(--color-accent));
  outline-offset: 4px;
}

/* DM cockpit — the private scene picker + paging controls (issue #823). Lives in
   the auto-hiding control stack, so it never burns into the public broadcast. */
.cf-screen .cf-cockpit {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
}
.cf-screen .cf-scene-picker,
.cf-screen .cf-cockpit-row,
.cf-screen .cf-aspect-toggle,
.cf-screen .cf-page-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
  align-items: center;
}
.cf-screen .cf-cockpit-row { gap: 10px; }
.cf-screen .cf-cockpit .btn {
  padding: 6px 12px;
  font-size: 13px;
  line-height: 1.2;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-surface) 92%, transparent);
  color: var(--color-neutral-200);
}
.cf-screen .cf-scene-btn.active,
.cf-screen .cf-aspect-btn.active {
  border-color: color-mix(in srgb, var(--color-accent) 60%, transparent);
  background: color-mix(in srgb, var(--color-accent) 20%, transparent);
  color: var(--color-accent-2);
}
.cf-screen .cf-cockpit .btn:focus-visible {
  outline: 3px solid var(--color-accent-2, var(--color-accent));
  outline-offset: 3px;
}

.cf-screen .cf-screen-fullscreen-notice {
  margin: 8px 0 0 auto;
  width: fit-content;
  max-width: 38ch;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-surface) 94%, transparent);
  color: var(--color-neutral-200);
  padding: 9px 12px;
  font-size: 13px;
  line-height: 1.4;
  box-shadow: 0 8px 24px color-mix(in srgb, #000 38%, transparent);
}
.cf-screen .cf-screen-fullscreen-notice.error {
  /* Issue #1685: dropped this custom property's inline hex fallback — it names an
     unconditional :root token (index.css/nocturne.css), never runtime-optional like
     the accent tokens, so the fallback was dead and could only ever drift silently. */
  border-color: color-mix(in srgb, var(--color-danger) 58%, transparent);
  color: #fff;
}
.cf-screen .cf-screen-wakelock-notice {
  margin: 8px 0 0 auto;
  width: fit-content;
  max-width: 38ch;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-surface) 94%, transparent);
  color: var(--color-neutral-200);
  padding: 9px 12px;
  font-size: 13px;
  line-height: 1.4;
  box-shadow: 0 8px 24px color-mix(in srgb, #000 38%, transparent);
}
.cf-exit-pin {
  position: fixed;
  inset: 0;
  /* Above both the safety curtain (--cf-layer-dialog) and the control stack
     that opens this dialog (issue #1908) — this dialog must never be
     strandable under either, matching the control-stack comment above. */
  z-index: calc(var(--cf-layer-dialog, 50) + 2);
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, #000 72%, transparent);
}
.cf-exit-pin form {
  width: min(420px, 100%);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-lg, 16px);
  background: var(--color-surface);
  color: var(--color-text);
  padding: 20px;
  box-shadow: 0 18px 48px color-mix(in srgb, #000 55%, transparent);
}
.cf-exit-pin h2 { margin: 0 0 8px; font-family: var(--font-heading); font-size: 22px; }
.cf-exit-pin p { margin: 0 0 14px; color: var(--color-neutral-300); font-size: 14px; }
.cf-exit-pin label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 700; }
.cf-exit-pin input { width: 100%; margin-bottom: 12px; }
.cf-exit-pin-error { color: #fca5a5 !important; }
.cf-exit-pin-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }

/* Fixed-aspect letterboxed stage. */
.cf-screen .cf-stage-wrap {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  overflow: hidden;
}
.cf-screen .cf-stage {
  --cf-ar-w: 16;
  --cf-ar-h: 9;
  position: relative;
  aspect-ratio: var(--cf-ar-w, 16) / var(--cf-ar-h, 9);
  width: min(100vw, calc(100vh * var(--cf-ar-w, 16) / var(--cf-ar-h, 9)));
  height: min(100vh, calc(100vw * var(--cf-ar-h, 9) / var(--cf-ar-w, 16)));
  container-type: size;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 2cqh;
  /* Safe-area budget so nothing crowds a TV's overscan edge. */
  padding: 4cqh 4cqw;
  background: radial-gradient(120% 120% at 50% -10%, #1c1f31 0%, var(--color-bg) 60%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #fff 5%, transparent);
}

/* Clamp helpers — ellipsis (single line) / line clamp (multi-line). Paired with
   paging/rotation so clamped content is never lost, just taking turns. */
.cf-screen .cf-clamp-1 {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
.cf-screen .cf-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Persistent status band (kept across every scene). */
.cf-screen .cf-status-band { flex: none; display: flex; flex-direction: column; gap: 1cqh; }
.cf-screen .cf-status-lead { display: flex; align-items: baseline; gap: 2cqw; flex-wrap: wrap; min-width: 0; }
.cf-screen .cf-status-campaign {
  margin: 0;
  font-family: var(--font-heading);
  font-weight: 800;
  color: #fff;
  font-size: max(15px, 5cqh);
  line-height: 1.05;
  max-width: 68cqw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cf-screen .cf-status-location { max-width: 30cqw; }
.cf-screen .cf-status-combat {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2.4cqw;
  font-size: max(15px, 2.7cqh);
  color: var(--color-neutral-200);
}
.cf-screen .cf-status-enc { font-weight: 700; color: var(--color-accent-2); max-width: 30cqw; }
.cf-screen .cf-status-round { font-weight: 600; }
.cf-screen .cf-status-turn { display: inline-flex; align-items: baseline; gap: 0.8cqw; min-width: 0; }
.cf-screen .cf-status-turn-label {
  font-size: max(15px, 1.9cqh);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-neutral-400);
}
.cf-screen .cf-status-turn-name { font-weight: 700; color: #fff; max-width: 24cqw; }
.cf-screen .cf-status-next .cf-status-turn-label { color: var(--color-neutral-500); }
.cf-screen .cf-status-next .cf-status-turn-name { color: var(--color-neutral-200); }
.cf-screen .cf-status-idle { color: var(--color-neutral-400); font-size: max(15px, 2.5cqh); }

/* Issue #1685: named cf-screen-chip*, NOT the app-wide .cf-chip (index.css) —
   reusing the bare .cf-chip name here silently overrode every .cf-chip in the
   app for as long as this route was mounted. Non-portalled selectors in this
   stylesheet are now ALSO prefixed with the .cf-screen ancestor (the <main>
   this <style> tag renders inside, see the render call below) — a <style>
   element has no scoping of its own from where it sits in the DOM, so the
   ancestor prefix is real, load-bearing scoping, not the unique name alone.
   The larger/higher-contrast cqh/cqw sizing below IS a deliberate choice for
   this across-the-room TV surface — kept as an override, just confined to
   this route and under a name that also cannot collide with anything else. */
.cf-screen .cf-screen-chip {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--color-divider);
  border-radius: 999px;
  padding: 0.5cqh 1.4cqw;
  font-size: max(15px, 2cqh);
  white-space: nowrap;
  max-width: 100%;
}
.cf-screen .cf-screen-chip-sm { padding: 0.3cqh 1cqw; font-size: max(15px, 1.7cqh); text-transform: capitalize; }
.cf-screen .cf-screen-chip-accent {
  border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
  background: color-mix(in srgb, var(--color-accent) 16%, transparent);
  color: var(--color-accent-2);
}
.cf-screen .cf-screen-sync {
  margin: 1cqh 0 0;
  width: fit-content;
  max-width: 60cqw;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-surface) 88%, transparent);
  color: var(--color-neutral-200);
  padding: 0.8cqh 1.4cqw;
  font-size: max(15px, 2cqh);
  line-height: 1.35;
}
.cf-screen .cf-screen-sync.offline {
  border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
}
.cf-screen .cf-ai-ticker {
  margin: 1cqh 0 0;
  font-size: max(15px, 2.2cqh);
  color: var(--color-accent-2, var(--color-accent));
  opacity: 0.9;
  max-width: 90cqw;
}

/* Scene body — fills remaining stage, never scrolls. */
.cf-screen .cf-scene-body { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.cf-screen .cf-scene { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.cf-screen .cf-scene-title {
  margin: 0 0 1.6cqh;
  font-family: var(--font-heading);
  font-weight: 700;
  color: #fff;
  font-size: max(15px, 3.4cqh);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 2cqw;
}
.cf-screen .cf-scene-pageflag {
  font-size: max(15px, 2cqh);
  color: var(--color-neutral-400);
  font-weight: 600;
  letter-spacing: normal;
  text-transform: none;
}
.cf-screen .cf-scene-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.5cqh;
  color: var(--color-neutral-400);
  text-align: center;
}
.cf-screen .cf-scene-empty-title { margin: 0; font-size: max(15px, 3.2cqh); font-weight: 700; color: var(--color-text); }
.cf-screen .cf-scene-empty-sub { margin: 0; font-size: max(15px, 2.2cqh); color: var(--color-neutral-500); max-width: 60cqw; }
.cf-screen .cf-rail-retry { margin-top: 1.5cqh; align-self: center; }

/* Initiative */
.cf-screen .cf-init-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1.2cqh; flex: 1 1 auto; min-height: 0; }
.cf-screen .cf-init {
  display: flex;
  align-items: center;
  gap: 2cqw;
  padding: 1.2cqh 2cqw;
  border-radius: var(--radius-md);
  border-left: 0.5cqh solid transparent;
  background: color-mix(in srgb, var(--color-bg) 40%, transparent);
}
.cf-screen .cf-init.current {
  border-left-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent) 35%, transparent);
}
.cf-screen .cf-init-num {
  flex: none;
  width: 6cqw;
  text-align: center;
  font-family: var(--font-heading);
  font-weight: 800;
  font-size: max(15px, 4cqh);
  color: var(--color-accent-2);
}
.cf-screen .cf-init.current .cf-init-num { color: var(--color-accent); }
.cf-screen .cf-init-main { flex: 1; min-width: 0; }
.cf-screen .cf-init-name {
  display: flex;
  align-items: center;
  gap: 1.5cqw;
  font-weight: 600;
  color: #fff;
  font-size: max(15px, 3cqh);
  min-width: 0;
}
.cf-screen .cf-init-name .cf-clamp-1 { max-width: 34cqw; }
.cf-screen .cf-init-hp { flex: none; width: 22cqw; text-align: right; }

/* HP bars — same colours as the app's .cf-hp (index.css), issue #1685: this
   used to hardcode its own hex (#5bd18b/#e5c15b/#e5735b) that had drifted
   from the token values, so the SAME bar rendered a different colour on the
   TV display than in the session runner, and neither followed accent
   theming. Now reads the identical tokens as index.css's .cf-hp, so the two
   surfaces can never disagree again and both re-theme together. Renamed
   cf-hp -> cf-screen-hp (see the .cf-screen-chip comment above) — the taller
   1.4cqh bar height is a deliberate TV-legibility override kept here, not
   removed; only the colour source changed. */
.cf-screen .cf-screen-hp {
  height: 1.4cqh;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text) 12%, transparent);
  overflow: hidden;
  margin-top: 0.6cqh;
}
.cf-screen .cf-screen-hp > div { height: 100%; background: var(--cf-success); border-radius: 999px; transition: width 0.4s ease; }
.cf-screen .cf-screen-hp.low > div { background: var(--color-accent); }
.cf-screen .cf-screen-hp.crit > div { background: var(--cf-danger); }
.cf-screen .cf-hp-num { font-size: max(15px, 2.3cqh); font-variant-numeric: tabular-nums; color: var(--color-neutral-300); }
.cf-screen .cf-hp-row { display: flex; align-items: center; gap: 1.5cqw; margin-top: 0.8cqh; }
.cf-screen .cf-hp-row .cf-screen-hp { flex: 1; margin-top: 0; }

/* Party */
.cf-screen .cf-party { display: grid; grid-template-columns: repeat(auto-fill, minmax(24cqw, 1fr)); gap: 1.5cqw; align-content: start; overflow: hidden; }
.cf-screen .cf-party-card { border: 1px solid var(--color-divider); border-radius: var(--radius-md); padding: 1.4cqh 1.6cqw; min-width: 0; }
.cf-screen .cf-party-card.alumni { opacity: 0.62; }
.cf-screen .cf-party-top { display: flex; align-items: center; justify-content: space-between; gap: 1cqw; }
.cf-screen .cf-party-name {
  display: inline-flex;
  align-items: center;
  gap: 1cqw;
  font-weight: 700;
  color: #fff;
  font-size: max(15px, 2.6cqh);
  min-width: 0;
}
.cf-screen .cf-party-name .cf-clamp-1 { max-width: 15cqw; }
.cf-screen .cf-party-status {
  text-transform: none;
  color: var(--color-neutral-300);
  border-color: color-mix(in srgb, var(--color-neutral-400) 45%, transparent);
}
.cf-screen .cf-party-sub { color: var(--color-neutral-400); font-size: max(15px, 2cqh); margin-top: 0.4cqh; text-transform: capitalize; }

/* Conditions */
.cf-screen .cf-conds { display: flex; flex-wrap: wrap; gap: 0.6cqw; margin-top: 0.8cqh; align-items: center; }
.cf-screen .cf-cond {
  border: 1px solid var(--color-divider);
  border-radius: 999px;
  padding: 0.3cqh 1cqw;
  font-size: max(15px, 1.8cqh);
  color: var(--color-accent-2);
  max-width: 20cqw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cf-screen .cf-cond-more { color: var(--color-neutral-400); font-size: max(15px, 1.8cqh); }

/* Quests */
.cf-screen .cf-quests { display: flex; flex-direction: column; gap: 1.5cqh; overflow: hidden; }
.cf-screen .cf-quest-top { display: flex; align-items: center; justify-content: space-between; gap: 1.5cqw; min-width: 0; }
.cf-screen .cf-quest-title { font-weight: 700; color: #fff; font-size: max(15px, 2.8cqh); max-width: 70cqw; }
.cf-screen .cf-objs { list-style: none; margin: 0.8cqh 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.6cqh; }
.cf-screen .cf-objs li {
  display: flex;
  gap: 1.2cqw;
  align-items: baseline;
  color: var(--color-neutral-200);
  font-size: max(15px, 2.2cqh);
  min-width: 0;
}
.cf-screen .cf-objs li.done { color: var(--color-neutral-500); text-decoration: line-through; }
.cf-screen .cf-obj-mark { color: var(--color-accent); flex: none; }
.cf-screen .cf-obj-text { min-width: 0; }
.cf-screen .cf-objs li.done .cf-obj-mark { color: var(--color-text-decorative); }

/* NPCs */
.cf-screen .cf-npc-head {
  margin: 2cqh 0 1cqh;
  font-family: var(--font-heading);
  font-weight: 700;
  color: #fff;
  font-size: max(15px, 2.6cqh);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.cf-screen .cf-npcs { display: grid; grid-template-columns: repeat(auto-fill, minmax(22cqw, 1fr)); gap: 1.2cqw; }
.cf-screen .cf-npc { border: 1px solid var(--color-divider); border-radius: var(--radius-md); padding: 1cqh 1.3cqw; min-width: 0; }
.cf-screen .cf-npc-name { display: block; font-weight: 600; color: #fff; font-size: max(15px, 2.3cqh); }
.cf-screen .cf-npc-role { display: block; color: var(--color-neutral-400); font-size: max(15px, 1.9cqh); }
.cf-screen .cf-npc-disposition { margin-top: 0.8cqh; }

/* Map */
.cf-screen .cf-scene-map { align-items: stretch; justify-content: stretch; }
.cf-screen .cf-cast-battle-map { width: 100%; height: 100%; min-height: 0; }
.cf-screen .cf-map-img { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; border-radius: var(--radius-md); }

/* Intermission */
.cf-screen .cf-intermission { align-items: center; justify-content: center; text-align: center; gap: 2cqh; color: var(--color-neutral-300); }
.cf-screen .cf-intermission h2 { margin: 0; font-family: var(--font-heading); font-size: max(15px, 6cqh); color: #fff; }
.cf-screen .cf-intermission p { margin: 0; font-size: max(15px, 3cqh); }
.cf-screen .cf-intermission-loc { font-size: max(15px, 2.4cqh); color: var(--color-neutral-400); }

/* Blackout */
.cf-screen .cf-blackout { position: absolute; inset: 0; background: #000; }

@media (prefers-reduced-motion: reduce) {
  .cf-screen .cf-screen-control-stack,
  .cf-screen .cf-screen-hp > div {
    transition: none;
  }
}
`;
