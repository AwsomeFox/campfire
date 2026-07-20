/**
 * Tap-to-build dice tray (issue #38) — a table-friendly alternative to typing dice
 * notation. Tap d20/d6/…, bump a modifier, pick a preset; the tray composes the
 * expression(s) and hands them to the existing shared-log roll path. Nobody has to
 * type "2d6+3" mid-combat anymore — but the advanced expression box still lives in
 * SharedDiceLog for power users.
 *
 * Scope note: the server roll endpoint understands a single die group per expression
 * ("NdM", optional keep/drop khN/klN/dhN/dlN, optional +K). So:
 *  - A mixed pool (e.g. 2d6 + 1d8) submits one roll per die group; each lands as its
 *    own shared-log entry. The common single-group case (2d6+3, 1d20+5) is one clean
 *    roll with a server-computed total.
 *  - Advantage/disadvantage submit a real keep/drop expression — "2d20kh1" / "2d20kl1"
 *    (issue #130) — so the server rolls both d20s AND computes the kept total that
 *    everyone in the shared feed sees; the tray just surfaces the same kept die.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DiceRoll } from '@campfire/schema';
import { Btn } from '../../components/ui';
import { RolledDice } from './RolledDice';

// Standard polyhedral faces the server accepts (see apps/server/src/common/dice.ts).
const DICE_FACES = [4, 6, 8, 10, 12, 20, 100] as const;
const MAX_COUNT = 20; // server's per-group cap
const MAX_MOD = 99; // tray-side clamp; server allows up to 999 via the advanced box

type AdvMode = 'flat' | 'adv' | 'dis';

/** sides -> count, e.g. { 6: 2, 8: 1 } === "2d6 + 1d8" */
type Pool = Record<number, number>;

interface SavedPreset {
  label: string;
  pool: Pool;
  modifier: number;
  advMode: AdvMode;
}

interface DiceTrayProps {
  /** Submit one built expression; returns the persisted roll (or null on failure). */
  onSubmitExpr: (expr: string) => Promise<DiceRoll | null>;
  rolling: boolean;
  campaignId: number;
  compact?: boolean;
}

function formatMod(mod: number): string {
  if (mod === 0) return '';
  return mod > 0 ? `+${mod}` : `${mod}`;
}

function poolEntries(pool: Pool): [number, number][] {
  return DICE_FACES.map((sides) => [sides, pool[sides] ?? 0] as [number, number]).filter(
    ([, count]) => count > 0,
  );
}

/**
 * Build the expression(s) to submit. Advantage -> "2d20kh1{mod}", disadvantage ->
 * "2d20kl1{mod}" (server keeps the high/low die and computes the total, issue #130).
 * Otherwise one expression per die group, with the modifier folded onto the first.
 */
function buildExprs(pool: Pool, modifier: number, advMode: AdvMode): string[] {
  if (advMode === 'adv') return [`2d20kh1${formatMod(modifier)}`];
  if (advMode === 'dis') return [`2d20kl1${formatMod(modifier)}`];
  const entries = poolEntries(pool);
  if (entries.length === 0) return [];
  return entries.map(([sides, count], i) => `${count}d${sides}${i === 0 ? formatMod(modifier) : ''}`);
}

/** Human-readable preview of the pending roll. */
function previewText(pool: Pool, modifier: number, advMode: AdvMode): string {
  if (advMode !== 'flat') {
    return `2d20 keep ${advMode === 'adv' ? 'highest' : 'lowest'}${formatMod(modifier) ? ` ${formatMod(modifier)}` : ''}`;
  }
  const entries = poolEntries(pool);
  if (entries.length === 0) return modifier !== 0 ? formatMod(modifier) : 'Tap dice to build a roll';
  return entries.map(([sides, count]) => `${count}d${sides}`).join(' + ') + (formatMod(modifier) ? ` ${formatMod(modifier)}` : '');
}

const STATIC_PRESETS: { labelKey: string; pool: Pool }[] = [
  { labelKey: 'presetAttack', pool: { 20: 1 } },
  { labelKey: 'presetSave', pool: { 20: 1 } },
  { labelKey: 'presetAbilityCheck', pool: { 20: 1 } },
  { labelKey: 'presetInitiative', pool: { 20: 1 } },
];

function storageKey(campaignId: number): string {
  return `campfire.dicePresets.${campaignId}`;
}

function loadPresets(campaignId: number): SavedPreset[] {
  try {
    const raw = localStorage.getItem(storageKey(campaignId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedPreset[]) : [];
  } catch {
    return [];
  }
}

export function DiceTray({ onSubmitExpr, rolling, campaignId, compact = false }: DiceTrayProps) {
  const { t } = useTranslation();
  const [pool, setPool] = useState<Pool>({});
  const [modifier, setModifier] = useState(0);
  const [advMode, setAdvMode] = useState<AdvMode>('flat');
  const [savedPresets, setSavedPresets] = useState<SavedPreset[]>(() => loadPresets(campaignId));
  // Local "big result" feedback. For advantage/disadvantage the server now returns the
  // kept die (result.kept) and a total that already reflects the keep + modifier.
  const [feedback, setFeedback] = useState<{ label: string; total: number; rolls: number[]; kept?: number[] } | null>(
    null,
  );

  useEffect(() => {
    setSavedPresets(loadPresets(campaignId));
  }, [campaignId]);

  const entries = poolEntries(pool);
  const isLoneD20 = entries.length === 1 && entries[0][0] === 20 && entries[0][1] === 1;
  const advAvailable = entries.length === 0 || isLoneD20;
  const exprs = buildExprs(pool, modifier, advMode);
  const canRoll = exprs.length > 0 && !rolling;

  const addDie = useCallback((sides: number) => {
    setFeedback(null);
    setAdvMode('flat');
    setPool((prev) => {
      const next = Math.min((prev[sides] ?? 0) + 1, MAX_COUNT);
      return { ...prev, [sides]: next };
    });
  }, []);

  const removeGroup = useCallback((sides: number) => {
    setFeedback(null);
    setPool((prev) => {
      const rest = { ...prev };
      delete rest[sides];
      return rest;
    });
  }, []);

  const decGroup = useCallback((sides: number) => {
    setFeedback(null);
    setPool((prev) => {
      const count = (prev[sides] ?? 0) - 1;
      const rest = { ...prev };
      if (count <= 0) delete rest[sides];
      else rest[sides] = count;
      return rest;
    });
  }, []);

  const clearAll = useCallback(() => {
    setPool({});
    setModifier(0);
    setAdvMode('flat');
    setFeedback(null);
  }, []);

  const toggleAdv = useCallback((mode: Exclude<AdvMode, 'flat'>) => {
    setFeedback(null);
    setPool({ 20: 1 }); // advantage is always a single d20
    setAdvMode((prev) => (prev === mode ? 'flat' : mode));
  }, []);

  const applyPreset = useCallback((p: { pool: Pool; modifier?: number; advMode?: AdvMode }) => {
    setFeedback(null);
    setPool({ ...p.pool });
    if (p.modifier !== undefined) setModifier(p.modifier);
    setAdvMode(p.advMode ?? 'flat');
  }, []);

  const persistPresets = useCallback(
    (next: SavedPreset[]) => {
      setSavedPresets(next);
      try {
        localStorage.setItem(storageKey(campaignId), JSON.stringify(next));
      } catch {
        /* localStorage unavailable (private mode / quota) — presets stay in-memory */
      }
    },
    [campaignId],
  );

  const saveCurrentPreset = useCallback(() => {
    if (exprs.length === 0) return;
    const label = window.prompt(t('dice.namePrompt'))?.trim();
    if (!label) return;
    const preset: SavedPreset = { label, pool: { ...pool }, modifier, advMode };
    persistPresets([...savedPresets.filter((p) => p.label !== label), preset].slice(-12));
  }, [exprs.length, pool, modifier, advMode, savedPresets, persistPresets]);

  const deletePreset = useCallback(
    (label: string) => {
      persistPresets(savedPresets.filter((p) => p.label !== label));
    },
    [savedPresets, persistPresets],
  );

  const doRoll = useCallback(async () => {
    const toSubmit = buildExprs(pool, modifier, advMode);
    if (toSubmit.length === 0) return;
    if (advMode !== 'flat') {
      const result = await onSubmitExpr(toSubmit[0]);
      if (result) {
        // Server keeps the high/low die (2d20kh1 / kl1) and returns the kept total.
        setFeedback({
          label: advMode === 'adv' ? t('dice.keptHigh') : t('dice.keptLow'),
          total: result.total,
          rolls: result.rolls,
          kept: result.kept,
        });
      }
      return;
    }
    let last: DiceRoll | null = null;
    for (const expr of toSubmit) {
      // Sequential so multi-group rolls land in a stable order in the shared feed.
      last = await onSubmitExpr(expr);
    }
    if (last) setFeedback({ label: last.expr, total: last.total, rolls: last.rolls, kept: last.kept });
  }, [pool, modifier, advMode, onSubmitExpr]);

  const dieBtnSize = compact ? 40 : 48;

  return (
    <div className="space-y-2.5">
      {/* Die buttons */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {DICE_FACES.map((sides) => (
          <button
            key={sides}
            type="button"
            onClick={() => addDie(sides)}
            aria-label={t('dice.addDie', { sides })}
            className="cf-btn"
            style={{
              minHeight: dieBtnSize,
              minWidth: dieBtnSize,
              padding: '0 10px',
              fontSize: compact ? 12 : 13,
              flex: '0 0 auto',
            }}
          >
            d{sides}
          </button>
        ))}
      </div>

      {/* Advantage / Disadvantage (d20) */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => toggleAdv('adv')}
          disabled={!advAvailable && advMode !== 'adv'}
          aria-pressed={advMode === 'adv'}
          className="cf-btn cf-btn-ghost"
          style={{
            minHeight: compact ? 32 : 38,
            fontSize: 12,
            ...(advMode === 'adv'
              ? { color: 'var(--color-accent)', borderColor: 'var(--color-accent)' }
              : {}),
          }}
        >
          {t('dice.advantage')}
        </button>
        <button
          type="button"
          onClick={() => toggleAdv('dis')}
          disabled={!advAvailable && advMode !== 'dis'}
          aria-pressed={advMode === 'dis'}
          className="cf-btn cf-btn-ghost"
          style={{
            minHeight: compact ? 32 : 38,
            fontSize: 12,
            ...(advMode === 'dis'
              ? { color: 'var(--color-accent)', borderColor: 'var(--color-accent)' }
              : {}),
          }}
        >
          {t('dice.disadvantage')}
        </button>
      </div>

      {/* Modifier stepper */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="text-muted" style={{ fontSize: 12, minWidth: 52 }}>
          {t('dice.modifier')}
        </span>
        <button
          type="button"
          onClick={() => setModifier((m) => Math.max(m - 1, -MAX_MOD))}
          aria-label={t('dice.decreaseModifier')}
          className="cf-btn cf-btn-ghost"
          style={{ minHeight: 36, minWidth: 40, padding: 0, fontSize: 18 }}
        >
          −
        </button>
        <span
          aria-live="polite"
          style={{ fontFamily: 'var(--font-heading)', fontSize: 16, minWidth: 34, textAlign: 'center' }}
        >
          {modifier > 0 ? `+${modifier}` : modifier}
        </span>
        <button
          type="button"
          onClick={() => setModifier((m) => Math.min(m + 1, MAX_MOD))}
          aria-label={t('dice.increaseModifier')}
          className="cf-btn cf-btn-ghost"
          style={{ minHeight: 36, minWidth: 40, padding: 0, fontSize: 18 }}
        >
          +
        </button>
      </div>

      {/* Live pool — tap a group to remove */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', minHeight: 30 }}>
        {advMode !== 'flat' ? (
          <span
            style={{
              fontSize: 12.5,
              padding: '4px 8px',
              borderRadius: 'var(--radius-md, 8px)',
              border: '1px solid var(--color-accent)',
              color: 'var(--color-accent)',
            }}
          >
            {previewText(pool, modifier, advMode)}
          </span>
        ) : (
          entries.map(([sides, count]) => (
            <span
              key={sides}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12.5,
                padding: '4px 6px 4px 10px',
                borderRadius: 'var(--radius-md, 8px)',
                border: '1px solid var(--color-divider)',
              }}
            >
              {count}d{sides}
              <button
                type="button"
                onClick={() => decGroup(sides)}
                aria-label={t('dice.removeOne', { sides })}
                className="text-muted"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: '0 4px' }}
              >
                −
              </button>
              <button
                type="button"
                onClick={() => removeGroup(sides)}
                aria-label={t('dice.removeAll', { sides })}
                className="text-muted"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, padding: '0 2px' }}
              >
                ✕
              </button>
            </span>
          ))
        )}
        {entries.length === 0 && advMode === 'flat' && (
          <span className="text-muted" style={{ fontSize: 11.5 }}>
            {previewText(pool, modifier, advMode)}
          </span>
        )}
        {(entries.length > 0 || modifier !== 0 || advMode !== 'flat') && (
          <button
            type="button"
            onClick={clearAll}
            className="text-muted"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, marginLeft: 'auto' }}
          >
            {t('dice.clear')}
          </button>
        )}
      </div>

      {/* Big Roll button + prominent total */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Btn
          type="button"
          onClick={() => void doRoll()}
          disabled={!canRoll}
          style={{ flex: 1, minHeight: compact ? 40 : 48, fontSize: compact ? 14 : 16 }}
        >
          {rolling ? t('dice.rolling') : exprs.length === 0 ? t('dice.roll') : t('dice.rollExpr', { preview: previewText(pool, modifier, advMode) })}
        </Btn>
        {feedback && (
          <div style={{ textAlign: 'right', flex: 'none' }}>
            <div
              style={{
                fontFamily: 'var(--font-heading)',
                fontSize: compact ? 22 : 28,
                lineHeight: 1,
                color: 'var(--color-accent)',
              }}
            >
              {feedback.total}
            </div>
            <div className="text-muted" style={{ fontSize: 10, display: 'flex', gap: 4, justifyContent: 'flex-end', alignItems: 'baseline' }}>
              <span>{feedback.label}</span>
              <RolledDice rolls={feedback.rolls} kept={feedback.kept} fontSize={10} />
            </div>
          </div>
        )}
      </div>

      {/* Presets */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {STATIC_PRESETS.map((p) => (
          <button
            key={p.labelKey}
            type="button"
            onClick={() => applyPreset(p)}
            className="cf-btn cf-btn-ghost"
            style={{ minHeight: 32, fontSize: 11.5, padding: '0 10px' }}
          >
            {t(`dice.${p.labelKey}`)}
          </button>
        ))}
        {savedPresets.map((p) => (
          <span
            key={p.label}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              borderRadius: 'var(--radius-md, 8px)',
              border: '1px solid var(--color-divider)',
            }}
          >
            <button
              type="button"
              onClick={() => applyPreset(p)}
              className="text-muted"
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, padding: '6px 4px 6px 10px' }}
            >
              {p.label}
            </button>
            <button
              type="button"
              onClick={() => deletePreset(p.label)}
              aria-label={t('dice.deletePreset', { label: p.label })}
              className="text-muted"
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, padding: '6px 8px 6px 2px' }}
            >
              ✕
            </button>
          </span>
        ))}
        {exprs.length > 0 && (
          <button
            type="button"
            onClick={saveCurrentPreset}
            className="text-muted"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, padding: '0 6px', marginLeft: 'auto' }}
          >
            {t('dice.saveRoll')}
          </button>
        )}
      </div>
    </div>
  );
}
