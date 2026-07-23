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
import { useTranslation } from 'react-i18next';
import type { DiceRoll } from '@campfire/schema';
import { api, API, ApiError, getWithHeaders } from '../../lib/api';
import { Card, TextInput, Btn } from '../../components/ui';
import { useAnnounce } from '../../components/Announcer';
import { DiceTray } from './DiceTray';
import { RolledDice } from './RolledDice';
import { RolledTerms } from './RolledTerms';
import { canonicalizeDiceExpr } from '../../lib/i18nNumbers';
import { d20Flavor, d20FlourishI18nKey, d20TotalClasses } from '../../lib/d20Flavor';

const POLL_MS = 5000;

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
  const { t } = useTranslation();
  const limit = compact ? 4 : 8;
  const [expr, setExpr] = useState('1d20');
  const [rolling, setRolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rolls, setRolls] = useState<DiceRoll[]>([]);
  // Id of the roll the local user just made — only that total tumbles in, so
  // polled-in rolls from other players don't animate on every 5s refresh.
  const [justRolledId, setJustRolledId] = useState<number | null>(null);
  // Durable retention ceiling disclosed by the server (#614): the number of
  // rolls a campaign keeps before the oldest are pruned, or null when history
  // is never pruned ("keep all"). Used to render the honest "Showing the latest
  // N rolls" footnote; undefined until the first successful feed fetch.
  const [retention, setRetention] = useState<number | null | undefined>(undefined);
  const announce = useAnnounce();
  const exprId = useId();

  const load = useCallback(async () => {
    try {
      const { data, headers } = await getWithHeaders<DiceRoll[]>(`${API}/campaigns/${campaignId}/rolls?limit=${limit}`);
      setRolls(data);
      // Retention is disclosed per-response so it tracks the server's current
      // policy (incl. the "unlimited" keep-all mode) without a separate call.
      const r = headers.get('X-Dice-Rolls-Retention');
      setRetention(r === null ? undefined : r === 'unlimited' ? null : Number.isFinite(Number(r)) ? Number(r) : undefined);
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
      // Issue #633: canonicalize the expression before submit so non-ASCII
      // decimal digits (Arabic-Indic ٠-٩, Persian ۰-۹, Devanagari ०-९) typed or
      // pasted by international rollers are normalized to ASCII and lowercase,
      // matching the server's ASCII-only DiceExprPattern. The server remains
      // the authority on shape (zod regex) and bounds (parseCompoundDiceExpr);
      // this is purely input normalization, documented at DiceExprPattern in
      // @campfire/schema.
      const cleaned = canonicalizeDiceExpr(raw.trim());
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
        const flavor = d20Flavor(result);
        const flourishKey = d20FlourishI18nKey(flavor);
        const flourish = flourishKey ? t(flourishKey) : '';
        const keptSaid = result.kept ? t('dice.announceKept', { kept: result.kept.join(', ') }) : '';
        const checkSaid =
          result.dc != null ? (result.success ? t('dice.announceSuccess', { dc: result.dc }) : t('dice.announceFail', { dc: result.dc })) : '';
        announce(
          t('dice.announceRoll', {
            label: result.label ? `${result.label} ` : '',
            expr: result.expr,
            total: result.total,
            rolls: result.rolls.join(', '),
            kept: keptSaid,
            check: checkSaid,
            flourish,
          }),
        );
        return result;
      } catch (err) {
        const message = err instanceof ApiError ? err.message : t('dice.rollError');
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
      <span className="card-kicker">{compact ? t('dice.dice') : t('dice.diceLog')}</span>
      <DiceTray onSubmitExpr={submitExpr} rolling={rolling} campaignId={campaignId} compact={compact} />
      <details className="dice-advanced">
        <summary className="text-muted" style={{ fontSize: 11.5, cursor: 'pointer' }}>
          {t('dice.advancedSummary')}
        </summary>
        <form onSubmit={rollFromInput} className="flex gap-2 items-end flex-wrap" style={{ marginTop: 8 }}>
          <div className="field" style={{ flex: 1, minWidth: compact ? 100 : 120 }}>
            <label htmlFor={exprId}>{t('dice.expression')}</label>
            <TextInput
              id={exprId}
              aria-label={t('dice.diceExpressionLabel')}
              placeholder={t('dice.exprPlaceholder')}
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
            />
          </div>
          <Btn type="submit" className={compact ? '!min-h-0 !py-2 text-xs' : undefined} disabled={rolling || !expr.trim()}>
            {rolling ? t('dice.rolling') : t('dice.roll')}
          </Btn>
        </form>
      </details>
      {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
      {rolls.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 11.5, margin: 0 }}>
          {compact
            ? t('dice.emptyCompact')
            : t('dice.emptyFull')}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {rolls.map((r) => {
            const flavor = d20Flavor(r);
            const fresh = r.id === justRolledId;
            const totalClass = d20TotalClasses(flavor, fresh);
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
              {r.terms && <RolledTerms terms={r.terms} />}
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
                  {r.success ? t('dice.pass') : t('dice.fail')}
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
      {/* #614: disclose the durable retention policy honestly. Hidden on the
          compact dashboard widget (no room) and until the first fetch resolves
          `retention`; null means "keep everything", a number is the cap. */}
      {!compact && retention !== undefined && (
        <p className="text-muted" style={{ fontSize: 10.5, margin: 0 }}>
          {retention === null
            ? t('dice.retentionUnbounded')
            : t('dice.retentionCapped', { count: retention })}
        </p>
      )}
    </Card>
  );
}
