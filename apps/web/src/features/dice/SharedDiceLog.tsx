/**
 * Shared dice log (issue #35) — the table's roll feed, persisted server-side per
 * campaign so every member sees everyone's rolls (they were previously client-local
 * component state, invisible to the rest of the table and lost on reload).
 *
 * One component, two densities: `compact` for the dashboard DiceWidget card, full
 * size for RunSessionPage's dice log. POSTs to the existing /campaigns/:id/roll
 * endpoint (which now persists) and polls GET /campaigns/:id/rolls while the tab
 * is visible — same 5s poll-while-visible convention as RunSessionPage's encounter
 * refresh. When the SSE event stream lands (issue #4) the poll can be swapped for
 * a push without touching the rendering below.
 */
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type { DiceRoll } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, TextInput, Btn } from '../../components/ui';
import { useAnnounce } from '../../components/Announcer';
import { DiceTray } from './DiceTray';
import { RolledDice } from './RolledDice';

const POLL_MS = 5000;

// Flavor a d20 roll for the crit flourish (issue #67): a natural 20 gets a gold
// total + sparkle, a natural 1 a muted-rose shudder. Only meaningful for a single
// d20 (the classic to-hit / save die); everything else is a plain roll.
function rollFlavor(r: DiceRoll): 'crit' | 'fumble' | null {
  if (!/\bd20\b/i.test(r.expr)) return null;
  if (r.rolls.includes(20)) return 'crit';
  if (r.rolls.includes(1)) return 'fumble';
  return null;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function SharedDiceLog({ campaignId, compact = false }: { campaignId: number; compact?: boolean }) {
  const limit = compact ? 4 : 8;
  const [expr, setExpr] = useState('1d20');
  const [rolling, setRolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rolls, setRolls] = useState<DiceRoll[]>([]);
  // Id of the roll the local user just made — only that total tumbles in, so
  // polled-in rolls from other players don't animate on every 5s refresh.
  const [justRolledId, setJustRolledId] = useState<number | null>(null);
  const announce = useAnnounce();
  const exprId = useId();

  const load = useCallback(async () => {
    try {
      const list = await api.get<DiceRoll[]>(`${API}/campaigns/${campaignId}/rolls?limit=${limit}`);
      setRolls(list);
    } catch {
      /* keep last-known feed; next poll retries */
    }
  }, [campaignId, limit]);

  // Initial fetch + poll while the tab is visible, so other members' rolls show up
  // without a manual reload (mirrors RunSessionPage's encounter polling).
  useEffect(() => {
    void load();
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      void load();
    };
    const handle = setInterval(tick, POLL_MS);
    return () => clearInterval(handle);
  }, [load]);

  // Single roll-submit path, shared by the tap-to-build tray (issue #38) and the
  // advanced expression box. Kept intact so the shared-log/animation work (#35, #67)
  // can hook the same POST -> prepend -> announce flow. Returns the persisted roll so
  // the tray can surface a per-roll result (e.g. the kept die on an advantage roll).
  const submitExpr = useCallback(
    async (raw: string): Promise<DiceRoll | null> => {
      const cleaned = raw.trim();
      if (!cleaned) return null;
      setRolling(true);
      setError(null);
      try {
        const result = await api.post<DiceRoll>(`${API}/campaigns/${campaignId}/roll`, { expr: cleaned });
        // Prepend own roll immediately (dedupe by id — the next poll returns it too).
        setRolls((prev) => [result, ...prev.filter((r) => r.id !== result.id)].slice(0, limit));
        setJustRolledId(result.id); // triggers the tumble/crit/fumble animation (issue #67)
        // Announce the result — the roll feed is otherwise visual-only (issue #93),
        // calling out kept dice, DC success/fail, and a natural 20 / natural 1.
        const flavor = rollFlavor(result);
        const flourish = flavor === 'crit' ? ' — critical!' : flavor === 'fumble' ? ' — fumble!' : '';
        const keptSaid = result.kept ? `, kept ${result.kept.join(', ')}` : '';
        const checkSaid =
          result.dc != null ? `, ${result.success ? 'success' : 'fail'} vs DC ${result.dc}` : '';
        announce(
          `Rolled ${result.label ? `${result.label} ` : ''}${result.expr}: ${result.total} (${result.rolls.join(', ')}${keptSaid})${checkSaid}${flourish}`,
        );
        return result;
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Couldn't roll.";
        setError(message);
        announce(message, { assertive: true });
        return null;
      } finally {
        setRolling(false);
      }
    },
    [campaignId, limit, announce],
  );

  async function rollFromInput(e: FormEvent) {
    e.preventDefault();
    await submitExpr(expr);
  }

  return (
    <Card className="space-y-2.5">
      <span className="card-kicker">{compact ? 'Dice' : 'Dice log'}</span>
      <DiceTray onSubmitExpr={submitExpr} rolling={rolling} campaignId={campaignId} compact={compact} />
      <details className="dice-advanced">
        <summary className="text-muted" style={{ fontSize: 11.5, cursor: 'pointer' }}>
          Advanced — type an expression
        </summary>
        <form onSubmit={rollFromInput} className="flex gap-2 items-end flex-wrap" style={{ marginTop: 8 }}>
          <div className="field" style={{ flex: 1, minWidth: compact ? 100 : 120 }}>
            <label htmlFor={exprId}>Expression</label>
            <TextInput
              id={exprId}
              aria-label="Dice expression"
              placeholder="1d20+3 or 4d6dl1"
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
            />
          </div>
          <Btn type="submit" className={compact ? '!min-h-0 !py-2 text-xs' : undefined} disabled={rolling || !expr.trim()}>
            {rolling ? 'Rolling…' : 'Roll'}
          </Btn>
        </form>
      </details>
      {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
      {rolls.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 11.5, margin: 0 }}>
          {compact
            ? 'Roll anytime — not just in combat. Try 1d20, 2d6+4, or 2d20kh1 (advantage).'
            : 'No rolls yet — the whole table sees this log. Try 1d20, 2d6+4, or 2d20kh1 (advantage).'}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {rolls.map((r) => {
            const flavor = rollFlavor(r);
            const fresh = r.id === justRolledId;
            const totalClass = [
              flavor === 'crit' ? 'cf-roll-crit' : flavor === 'fumble' ? 'cf-roll-fumble' : '',
              fresh ? 'cf-anim-roll' : '',
              fresh && flavor === 'crit' ? 'cf-anim-crit' : '',
              fresh && flavor === 'fumble' ? 'cf-anim-fumble' : '',
            ].filter(Boolean).join(' ');
            return (
            <div
              key={r.id}
              title={new Date(r.createdAt).toLocaleString()}
              style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: compact ? 28 : 32 }}
            >
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, display: 'flex', gap: 8, alignItems: 'baseline', overflow: 'hidden' }}>
                <span className="text-muted" style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.rollerName || r.rollerUserId}
                </span>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.label ? `${r.label}: ` : ''}
                  {r.expr}
                  {r.dc != null ? ` vs DC ${r.dc}` : ''}
                </span>
              </span>
              <RolledDice rolls={r.rolls} kept={r.kept} />
              {fresh && flavor === 'crit' && (
                <span className="cf-crit-spark" aria-hidden="true" style={{ fontSize: compact ? 12 : 14, color: 'var(--cf-crit)', flex: 'none' }}>
                  ✦
                </span>
              )}
              {r.dc != null && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    flex: 'none',
                    color: r.success ? 'var(--color-success, #4ade80)' : 'var(--color-danger, #f87171)',
                  }}
                >
                  {r.success ? 'PASS' : 'FAIL'}
                </span>
              )}
              <span
                className={totalClass || undefined}
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontSize: compact ? 16 : 18,
                  color: 'var(--color-accent)',
                  flex: 'none',
                }}
              >
                {r.total}
              </span>
              <span className="text-muted" style={{ fontSize: 10, flex: 'none', minWidth: 26, textAlign: 'right' }}>
                {timeAgo(r.createdAt)}
              </span>
            </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
