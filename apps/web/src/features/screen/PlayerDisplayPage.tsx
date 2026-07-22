/**
 * Player Display — the cast-to-TV / "present" mode (issue #60).
 *
 * A read-only, full-bleed, secret-free view a DM can throw on a TV at the table.
 * It reuses the DM's normal authenticated reads (campaign summary + the live
 * encounter) but runs every payload through features/screen/playerSafe.ts, which
 * re-derives the *player* projection on the client — dropping dmSecret bodies,
 * `hidden` prep entities (issue #42), `unexplored` locations, and exact monster
 * HP (banded per issue #43). Nothing DM-only is ever rendered here.
 *
 * Route: /c/:campaignId/screen — mounted OUTSIDE the app chrome (Layout) so it
 * fills the screen with no sidebar/tabbar, but INSIDE AuthedLayout (members only).
 *
 * Live: refetches on encounter SSE events (issue #4) for snappy combat, plus a
 * slow poll to catch location/quest/party edits that don't emit an event.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  CampaignSummary,
  Encounter,
  EncounterWithCombatants,
  HpBand,
} from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useCampaignEvents } from '../../lib/useCampaignEvents';
import { useAnnounce } from '../../components/Announcer';
import { GameIcon } from '../../components/GameIcon';
import { useAuth } from '../../app/auth';
import { useAiDmLiveActivityState } from '../ai-dm/useAiDmLiveActivity';
import {
  safeCombatants,
  safeLocation,
  safeNpcs,
  safeParty,
  safeQuests,
  type SafeCombatant,
} from './playerSafe';

const POLL_MS = 12_000;

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

export default function PlayerDisplayPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const navigate = useNavigate();
  const announce = useAnnounce();
  const { roleIn } = useAuth();
  const role = roleIn(cid);

  // Minimal AI-DM narration ticker (#344 point 5 — optional/cuttable, kept lightweight).
  // This page renders OUTSIDE app/Layout.tsx (issue #60's no-chrome cast view), so it
  // can't reach that mounted subscription's context; it opens its own, gated the same
  // way (Driver mode only). Since /screen and the campaign-chrome routes are siblings —
  // never both mounted in the same tab — this never creates a second live connection.
  const liveActivity = useAiDmLiveActivityState(Number.isFinite(cid) ? cid : undefined);

  const [summary, setSummary] = useState<CampaignSummary | null>(null);
  const [encounter, setEncounter] = useState<EncounterWithCombatants | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [fullscreenSupported, setFullscreenSupported] = useState(fullscreenAvailable);
  const [isFullscreen, setIsFullscreen] = useState(fullscreenActive);
  const [fullscreenPending, setFullscreenPending] = useState(false);
  const [fullscreenNotice, setFullscreenNotice] = useState<FullscreenNotice | null>(null);
  const fullscreenActiveRef = useRef(isFullscreen);
  const controlsRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!Number.isFinite(cid)) return;
    try {
      const data = await api.get<CampaignSummary>(`${API}/campaigns/${cid}/summary`);
      setSummary(data);
      setError(null);
      // Find the live encounter (if any) and pull its combatants for the initiative rail.
      try {
        const running = await api.get<Encounter[]>(`${API}/campaigns/${cid}/encounters?status=running`);
        const live = running[0];
        if (live) {
          const full = await api.get<EncounterWithCombatants>(`${API}/encounters/${live.id}`);
          setEncounter(full);
        } else {
          setEncounter(null);
        }
      } catch {
        setEncounter(null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load the display.");
    } finally {
      setLoading(false);
    }
  }, [cid]);

  useEffect(() => {
    if (Number.isFinite(cid)) void load();
  }, [cid, load]);

  // Slow poll — catches location/quest/party edits (no SSE event) without hammering.
  useEffect(() => {
    if (!Number.isFinite(cid)) return;
    const handle = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(handle);
  }, [cid, load]);

  // Snappy combat updates: refetch the moment the DM starts/advances/ends an encounter.
  useCampaignEvents(Number.isFinite(cid) ? cid : undefined, {
    onEvent: useCallback(() => void load(), [load]),
    onReconnect: useCallback(() => void load(), [load]),
  });

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
      if (turnKey !== prev.turnKey) {
        if (encounter.status === 'running') {
          const current = safe.find((c) => c.id === currentId);
          announce(`Round ${encounter.round}${current ? ` — ${current.name}'s turn` : ''}`);
        } else if (encounter.status === 'ended') {
          announce('Encounter ended');
        }
      }
      for (const c of safe) {
        const before = prev.hp.get(c.id);
        const now = hp.get(c.id);
        if (before == null || now == null || now === '' || before === now) continue;
        if (c.hpBand != null) {
          // Monster — band label only, never the exact numbers.
          announce(`${c.name}: ${HP_BAND_LABEL[c.hpBand]}`);
        } else if (c.hpCurrent != null && c.hpMax != null) {
          // Character — exact HP is shared table info.
          announce(`${c.name}: ${c.hpCurrent} of ${c.hpMax} hit points`);
        }
      }
    }
    prevAnnounceRef.current = { hp, turnKey };
  }, [encounter, announce]);

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
    function clearHideTimer() {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }

    function scheduleHide() {
      clearHideTimer();
      hideTimer.current = setTimeout(() => {
        if (!controlsRef.current?.contains(document.activeElement)) setControlsVisible(false);
      }, 3500);
    }

    function ping(event?: Event) {
      setControlsVisible(true);
      if (event?.type === 'focusin' && controlsRef.current?.contains(event.target as Node)) {
        clearHideTimer();
      } else {
        scheduleHide();
      }
    }

    window.addEventListener('pointermove', ping, { passive: true });
    window.addEventListener('pointerdown', ping, { passive: true });
    window.addEventListener('keydown', ping);
    window.addEventListener('focusin', ping);
    window.addEventListener('focusout', ping);
    ping();
    return () => {
      window.removeEventListener('pointermove', ping);
      window.removeEventListener('pointerdown', ping);
      window.removeEventListener('keydown', ping);
      window.removeEventListener('focusin', ping);
      window.removeEventListener('focusout', ping);
      clearHideTimer();
    };
  }, []);

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

  if (!Number.isFinite(cid)) {
    return <CenteredMessage icon="tv" title="No campaign selected." />;
  }
  if (role == null && !loading) {
    return (
      <CenteredMessage icon="padlock" title="You don't have access to this campaign.">
        <Link to="/" className="btn btn-primary" style={{ marginTop: 12 }}>
          Back to your campaigns
        </Link>
      </CenteredMessage>
    );
  }
  if (loading && !summary) {
    return <CenteredMessage icon="campfire" title="Loading display…" pulse />;
  }
  if (error && !summary) {
    return (
      <CenteredMessage icon="hazard-sign" title={error}>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => void load()}>
          Retry
        </button>
      </CenteredMessage>
    );
  }
  if (!summary) return null;

  const location = safeLocation(summary.currentLocation);
  const party = safeParty(summary.characters);
  const quests = safeQuests(summary.quests);
  const npcs = safeNpcs(summary.npcs);
  const combatants = encounter ? safeCombatants(encounter.combatants) : [];
  const currentId =
    encounter && encounter.status === 'running' ? encounter.currentCombatantId ?? null : null;
  const displayedFullscreenNotice = fullscreenSupported
    ? fullscreenNotice
    : ({ kind: 'info', message: FULLSCREEN_UNSUPPORTED } satisfies FullscreenNotice);
  const keepControlsVisible = controlsVisible || displayedFullscreenNotice != null;

  return (
    <main className="cf-screen">
      <style>{SCREEN_CSS}</style>

      {/* Floating operator chrome stays outside the player-facing content panels. */}
      <div
        ref={controlsRef}
        className="cf-screen-control-stack"
        style={{ opacity: keepControlsVisible ? 1 : 0, pointerEvents: keepControlsVisible ? 'auto' : 'none' }}
      >
        <div className="cf-screen-controls">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => navigate(`/c/${cid}`)}
            title="Exit the display"
          >
            ✕ Exit
          </button>
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
        {displayedFullscreenNotice && (
          <p
            id="cf-screen-fullscreen-notice"
            className={`cf-screen-fullscreen-notice ${displayedFullscreenNotice.kind === 'error' ? 'error' : ''}`}
            role={displayedFullscreenNotice.kind === 'error' ? 'alert' : 'status'}
          >
            {displayedFullscreenNotice.message}
          </p>
        )}
      </div>

      {/* Header: campaign + where the party is */}
      <header className="cf-screen-head">
        <h1>{summary.campaign.name}</h1>
        <div className="cf-screen-chips">
          {location ? (
            <span className="cf-chip cf-chip-accent">
              {location.isCurrent ? <GameIcon slug="position-marker" size={14} className="inline align-text-bottom mr-1" /> : null}
              {location.name}
              {location.kind ? <span className="cf-chip-sub"> · {location.kind}</span> : null}
            </span>
          ) : (
            <span className="cf-chip">Location unset</span>
          )}
          <span className="cf-chip">Session {summary.campaign.sessionCount}</span>
        </div>
        {liveActivity.mode === 'driver' && liveActivity.lastNarration && (
          <p className="cf-ai-ticker"><GameIcon slug="robot-golem" size={14} className="inline align-text-bottom mr-1" />{liveActivity.lastNarration}</p>
        )}
      </header>

      <div className="cf-screen-grid">
        {/* Initiative rail takes the stage while combat is live */}
        {encounter && combatants.length > 0 && (
          <section className="cf-panel cf-panel-wide">
            <div className="cf-panel-head">
              <h2>Initiative</h2>
              <span className="cf-chip cf-chip-accent">
                {encounter.name} · Round {encounter.round}
              </span>
            </div>
            <ol className="cf-init-list">
              {combatants.map((c) => (
                <InitiativeRow key={c.id} combatant={c} isCurrent={c.id === currentId} />
              ))}
            </ol>
          </section>
        )}

        {/* Party */}
        <section className="cf-panel">
          <div className="cf-panel-head">
            <h2>Party</h2>
          </div>
          {party.length === 0 ? (
            <p className="cf-empty">No characters yet.</p>
          ) : (
            <div className="cf-party">
              {party.map((c) => {
                const pct = c.hpMax > 0 ? Math.max(0, Math.min(100, (c.hpCurrent / c.hpMax) * 100)) : 0;
                const tone = pct <= 25 ? 'crit' : pct <= 50 ? 'low' : '';
                return (
                  <div key={c.id} className="cf-party-card">
                    <div className="cf-party-top">
                      <span className="cf-party-name">{c.name}</span>
                      {c.ac != null && <span className="cf-chip cf-chip-sm">AC {c.ac}</span>}
                    </div>
                    <div className="cf-party-sub">
                      {[c.species, c.className && `${c.className} ${c.level}`].filter(Boolean).join(' · ') ||
                        `Level ${c.level}`}
                    </div>
                    <div className="cf-hp-row">
                      <div className={`cf-hp ${tone}`}>
                        <div style={{ width: `${pct}%` }} />
                      </div>
                      <span className="cf-hp-num">
                        {c.hpCurrent}/{c.hpMax}
                      </span>
                    </div>
                    {c.conditions.length > 0 && (
                      <div className="cf-conds">
                        {c.conditions.map((cond) => (
                          <span key={cond} className="cf-cond">
                            {cond}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Quests */}
        <section className="cf-panel">
          <div className="cf-panel-head">
            <h2>Quests</h2>
          </div>
          {quests.length === 0 ? (
            <p className="cf-empty">No active quests.</p>
          ) : (
            <div className="cf-quests">
              {quests.map((q) => (
                <div key={q.id} className="cf-quest">
                  <div className="cf-quest-top">
                    <span className="cf-quest-title">{q.title}</span>
                    <span className={`cf-chip cf-chip-sm ${q.status === 'active' ? 'cf-chip-accent' : ''}`}>
                      {q.status}
                    </span>
                  </div>
                  {q.objectives.length > 0 && (
                    <ul className="cf-objs">
                      {q.objectives.map((o) => (
                        <li key={o.id} className={o.done ? 'done' : ''}>
                          <span className="cf-obj-mark">{o.done ? '✓' : '○'}</span>
                          {o.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* NPCs (revealed only) */}
        {npcs.length > 0 && (
          <section className="cf-panel">
            <div className="cf-panel-head">
              <h2>Faces you know</h2>
            </div>
            <div className="cf-npcs">
              {npcs.map((n) => (
                <div key={n.id} className="cf-npc">
                  <span className="cf-npc-name">{n.name}</span>
                  {n.role && <span className="cf-npc-role">{n.role}</span>}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

function InitiativeRow({ combatant, isCurrent }: { combatant: SafeCombatant; isCurrent: boolean }) {
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
    <li className={`cf-init ${isCurrent ? 'current' : ''}`}>
      <span className="cf-init-num">{combatant.initiative ?? '–'}</span>
      <div className="cf-init-main">
        <div className="cf-init-name">
          {combatant.name}
          <span className={`cf-chip cf-chip-sm ${isMonster ? '' : 'cf-chip-accent'}`}>{combatant.kind === 'npc' ? 'NPC' : combatant.kind}</span>
        </div>
        {combatant.conditions.length > 0 && (
          <div className="cf-conds">
            {combatant.conditions.map((cond) => (
              <span key={cond} className="cf-cond">
                {cond}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="cf-init-hp">
        {isMonster ? (
          <>
            <span className="cf-hp-num">{combatant.hpBand ? HP_BAND_LABEL[combatant.hpBand] : '—'}</span>
            <div className={`cf-hp ${bandTone}`}>
              <div style={{ width: `${bandPct}%` }} />
            </div>
          </>
        ) : (
          <>
            <span className="cf-hp-num">
              {combatant.hpCurrent}/{combatant.hpMax}
            </span>
            <div className={`cf-hp ${charTone}`}>
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

// Scoped, TV-legible styling. Uses clamp() so it scales from a laptop preview up
// to a living-room screen. Colors come from the shared Nocturne tokens.
const SCREEN_CSS = `
.cf-screen {
  min-height: 100vh;
  background: radial-gradient(120% 120% at 50% -10%, #1c1f31 0%, var(--color-bg) 60%);
  color: var(--color-text);
  padding: clamp(16px, 3vw, 48px);
  font-family: var(--font-body);
}
.cf-screen-control-stack {
  position: fixed;
  top: 14px;
  right: 14px;
  width: min(420px, calc(100vw - 28px));
  z-index: 20;
  transition: opacity 0.4s ease;
}
.cf-screen-controls {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
.cf-screen-fullscreen-notice {
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
.cf-screen-fullscreen-notice.error {
  border-color: color-mix(in srgb, var(--color-danger, #e5735b) 58%, transparent);
  color: #fff;
}
.cf-screen-head { margin-bottom: clamp(16px, 2.4vw, 32px); }
.cf-screen-head h1 {
  margin: 0 0 10px;
  font-family: var(--font-heading);
  font-weight: 800;
  color: #fff;
  font-size: clamp(28px, 4.5vw, 64px);
  line-height: 1.05;
}
.cf-screen-chips { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.cf-chip {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--color-divider);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: clamp(13px, 1.2vw, 18px);
  white-space: nowrap;
  color: var(--color-text);
}
.cf-chip-sm { padding: 3px 9px; font-size: clamp(10px, 0.9vw, 13px); text-transform: capitalize; }
.cf-chip-accent {
  border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
  background: color-mix(in srgb, var(--color-accent) 16%, transparent);
  color: var(--color-accent-2);
}
.cf-chip-sub { opacity: 0.7; }
.cf-ai-ticker {
  margin: 10px 0 0;
  font-size: clamp(13px, 1.3vw, 18px);
  color: var(--color-accent-2, var(--color-accent));
  opacity: 0.9;
  max-width: 70ch;
}
.cf-screen-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
  gap: clamp(14px, 1.8vw, 26px);
  align-items: start;
}
.cf-panel {
  background: color-mix(in srgb, var(--color-surface) 82%, transparent);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-lg);
  padding: clamp(14px, 1.6vw, 26px);
}
.cf-panel-wide { grid-column: 1 / -1; }
.cf-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.cf-panel-head h2 {
  margin: 0;
  font-family: var(--font-heading);
  font-weight: 700;
  color: #fff;
  font-size: clamp(18px, 2vw, 30px);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.cf-empty { color: var(--color-neutral-500); font-size: clamp(14px, 1.2vw, 18px); margin: 4px 0 0; }

/* Initiative */
.cf-init-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.cf-init {
  display: flex;
  align-items: center;
  gap: clamp(10px, 1.2vw, 18px);
  padding: clamp(9px, 1vw, 15px) clamp(12px, 1.2vw, 18px);
  border-radius: var(--radius-md);
  border-left: 3px solid transparent;
  background: color-mix(in srgb, var(--color-bg) 40%, transparent);
}
.cf-init.current {
  border-left-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent) 35%, transparent);
}
.cf-init-num {
  flex: none;
  width: clamp(38px, 3.4vw, 56px);
  text-align: center;
  font-family: var(--font-heading);
  font-weight: 800;
  font-size: clamp(20px, 2.4vw, 36px);
  color: var(--color-accent-2);
}
.cf-init.current .cf-init-num { color: var(--color-accent); }
.cf-init-main { flex: 1; min-width: 0; }
.cf-init-name {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-weight: 600;
  color: #fff;
  font-size: clamp(16px, 1.7vw, 26px);
}
.cf-init-hp { flex: none; width: clamp(120px, 14vw, 220px); text-align: right; }

/* HP bars (shared look with the app's cf-hp) */
.cf-hp {
  height: 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text) 12%, transparent);
  overflow: hidden;
  margin-top: 5px;
}
.cf-hp > div { height: 100%; background: #5bd18b; border-radius: 999px; transition: width 0.4s ease; }
.cf-hp.low > div { background: #e5c15b; }
.cf-hp.crit > div { background: #e5735b; }
.cf-hp-num { font-size: clamp(13px, 1.3vw, 20px); font-variant-numeric: tabular-nums; color: var(--color-neutral-300); }
.cf-hp-row { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
.cf-hp-row .cf-hp { flex: 1; margin-top: 0; }

/* Party */
.cf-party { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 210px), 1fr)); gap: 12px; }
.cf-party-card { border: 1px solid var(--color-divider); border-radius: var(--radius-md); padding: 12px 14px; }
.cf-party-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cf-party-name { font-weight: 700; color: #fff; font-size: clamp(15px, 1.5vw, 22px); }
.cf-party-sub { color: var(--color-neutral-400); font-size: clamp(12px, 1.1vw, 16px); margin-top: 2px; text-transform: capitalize; }

/* Conditions */
.cf-conds { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.cf-cond {
  border: 1px solid var(--color-divider);
  border-radius: 999px;
  padding: 2px 9px;
  font-size: clamp(10px, 0.95vw, 13px);
  color: var(--color-accent-2);
}

/* Quests */
.cf-quests { display: flex; flex-direction: column; gap: 14px; }
.cf-quest-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.cf-quest-title { font-weight: 700; color: #fff; font-size: clamp(15px, 1.5vw, 22px); }
.cf-objs { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.cf-objs li {
  display: flex;
  gap: 9px;
  align-items: baseline;
  color: var(--color-neutral-200);
  font-size: clamp(13px, 1.2vw, 18px);
}
.cf-objs li.done { color: var(--color-neutral-500); text-decoration: line-through; }
.cf-obj-mark { color: var(--color-accent); flex: none; }
.cf-objs li.done .cf-obj-mark { color: var(--color-neutral-600); }

/* NPCs */
.cf-npcs { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr)); gap: 10px; }
.cf-npc { border: 1px solid var(--color-divider); border-radius: var(--radius-md); padding: 10px 13px; }
.cf-npc-name { display: block; font-weight: 600; color: #fff; font-size: clamp(14px, 1.3vw, 19px); }
.cf-npc-role { color: var(--color-neutral-400); font-size: clamp(12px, 1.1vw, 15px); }
`;
