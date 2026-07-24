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
 *
 * Saved-roll safety (issue #690): naming uses an inline modal (never native
 * `prompt()`), the 12-preset limit is disclosed before save, duplicates ask
 * before replacing, deletion offers Undo, and storage failures surface as a
 * memory-only badge rather than a silently-dropped persist. The pure decision
 * tree lives in `savedRollsState.ts`; this component owns the side-effectful
 * bits (dialog markup, real localStorage, Undo bar).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DiceRoll } from '@campfire/schema';
import { Btn, TextInput } from '../../components/ui';
import { useDialog } from '../../components/useDialog';
import { useAnnounce } from '../../components/Announcer';
import { RolledDice } from './RolledDice';
import {
  MAX_PRESETS,
  applySave,
  classifySave,
  isDuplicate,
  markMemoryOnly,
  normalizePresets,
  removePreset,
  type AdvMode,
  type Pool,
  type SavedPreset,
} from './savedRollsState';

// Standard polyhedral faces the server accepts (see apps/server/src/common/dice.ts).
const DICE_FACES = [4, 6, 8, 10, 12, 20, 100] as const;
const MAX_COUNT = 20; // server's per-group cap
const MAX_MOD = 99; // tray-side clamp; server allows up to 999 via the advanced box

// Undo window for a deleted preset (issue #690). The preset is staged for this
// long before the delete is considered committed; Undo restores it.
const DELETE_UNDO_MS = 7000;

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
    return normalizePresets(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Modal-phase state machine for the save flow (issue #690). */
type SavePhase =
  | { kind: 'closed' }
  | { kind: 'naming' }
  | { kind: 'confirm-duplicate'; label: string }
  | { kind: 'limit' };

/** A preset staged for deletion, restorable until the Undo window elapses. */
interface PendingDelete {
  preset: SavedPreset;
  /** Snapshot of the full list BEFORE the removal, so Undo restores order too. */
  previousList: SavedPreset[];
}

export function DiceTray({ onSubmitExpr, rolling, campaignId, compact = false }: DiceTrayProps) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const [pool, setPool] = useState<Pool>({});
  const [modifier, setModifier] = useState(0);
  const [advMode, setAdvMode] = useState<AdvMode>('flat');
  const [savedPresets, setSavedPresets] = useState<SavedPreset[]>(() => loadPresets(campaignId));
  // Local "big result" feedback. For advantage/disadvantage the server now returns the
  // kept die (result.kept) and a total that already reflects the keep + modifier.
  const [feedback, setFeedback] = useState<{ label: string; total: number; rolls: number[]; kept?: number[] } | null>(
    null,
  );

  // --- Save-flow modal state (issue #690) ---------------------------------
  const [savePhase, setSavePhase] = useState<SavePhase>({ kind: 'closed' });
  const [draftLabel, setDraftLabel] = useState('');
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // --- Deletion Undo state ------------------------------------------------
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Storage-failure notice (private mode / quota) ----------------------
  // `storageBlocked` is a sticky flag (true once a write has failed) used to
  // badge in-memory presets. `storageNotice` is the one-shot modal: shown once
  // right after a failed save, then dismissed so it doesn't nag on every render.
  // Tracked for the badge described above; not yet read directly here (kept
  // for the `setStorageBlocked` side effect below and any future consumer).
  const [_storageBlocked, setStorageBlocked] = useState(false);
  const [storageNotice, setStorageNotice] = useState(false);

  useEffect(() => {
    setSavedPresets(loadPresets(campaignId));
  }, [campaignId]);

  // Cancel any pending delete timer on unmount so it never fires into a stale closure.
  useEffect(() => {
    return () => {
      if (deleteTimerRef.current != null) clearTimeout(deleteTimerRef.current);
    };
  }, []);

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

  /**
   * Persist the next preset list to localStorage and update React state. Returns
   * true if the write landed, false if storage was unavailable (private mode /
   * quota) — in which case the presets stay in-memory only and are badged
   * accordingly so a "saved" roll is never presented as persisted (issue #690).
   */
  const persistPresets = useCallback(
    (next: SavedPreset[]): boolean => {
      let ok = true;
      try {
        localStorage.setItem(storageKey(campaignId), JSON.stringify(next));
        // A successful write clears the sticky memory-only badge — storage is
        // healthy again (e.g. the user left private mode).
        setStorageBlocked(false);
      } catch {
        // localStorage unavailable (private mode / quota) — presets stay in-memory.
        // Mark every preset memory-only so the badge distinguishes them from disk.
        ok = false;
        setStorageBlocked(true);
        next = markMemoryOnly(next);
      }
      setSavedPresets(next);
      return ok;
    },
    [campaignId],
  );

  // --- Commit a save (shared by the naming + duplicate-confirm paths) -----
  const commitSave = useCallback(
    (label: string) => {
      const preset: SavedPreset = {
        label,
        pool: { ...pool },
        modifier,
        advMode,
        persisted: true,
      };
      const decision = classifySave(savedPresets, label);
      // Reaching the commit with an at-limit list + a NEW name would silently
      // evict — block instead (the limit dialog already told the user to free a
      // slot). Only a duplicate-replace (handled by applySave) reaches the write.
      if (decision.kind === 'at-limit' && !isDuplicate(savedPresets, label)) {
        setSavePhase({ kind: 'limit' });
        return;
      }
      const next = applySave(savedPresets, preset);
      const stored = persistPresets(next);
      setSavePhase({ kind: 'closed' });
      setDraftLabel('');
      if (stored) {
        announce(t('dice.savedAnnounce', { label }));
      } else {
        // Surface the memory-only state ONCE: the preset is usable for the
        // session but will not survive reload. The sticky `storageBlocked` flag
        // keeps the in-list badge accurate without re-popping this modal.
        setStorageNotice(true);
      }
    },
    [pool, modifier, advMode, savedPresets, persistPresets, announce, t],
  );

  // --- Open the naming modal ---------------------------------------------
  const openSave = useCallback(() => {
    if (exprs.length === 0) return;
    setDraftLabel('');
    setSavePhase({ kind: 'naming' });
  }, [exprs.length]);

  // Confirm from the naming modal: classify and route.
  const submitName = useCallback(() => {
    const label = draftLabel.trim();
    if (!label) return;
    const decision = classifySave(savedPresets, label);
    if (decision.kind === 'duplicate') {
      // Ask before replacing — no silent overwrite (issue #690).
      setSavePhase({ kind: 'confirm-duplicate', label });
      return;
    }
    if (decision.kind === 'at-limit') {
      // Disclose the limit before any eviction.
      setSavePhase({ kind: 'limit' });
      return;
    }
    commitSave(label);
  }, [draftLabel, savedPresets, commitSave]);

  // --- Deletion with Undo -------------------------------------------------
  const deletePreset = useCallback(
    (label: string) => {
      const target = savedPresets.find((p) => p.label.toLowerCase() === label.toLowerCase());
      if (!target) return;
      // Stage the removal: snapshot the current list so Undo restores order, then
      // apply a removable list to memory/disk. The delete is NOT permanent until
      // the Undo window elapses.
      const previousList = savedPresets;
      const next = removePreset(savedPresets, label);
      persistPresets(next);
      setPendingDelete({ preset: target, previousList });
      if (deleteTimerRef.current != null) clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = setTimeout(() => {
        setPendingDelete(null);
        deleteTimerRef.current = null;
      }, DELETE_UNDO_MS);
    },
    [savedPresets, persistPresets],
  );

  const undoDelete = useCallback(async () => {
    if (!pendingDelete) return;
    if (deleteTimerRef.current != null) {
      clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = null;
    }
    // Restore the full original snapshot (preserves slot order + persisted flag).
    persistPresets(pendingDelete.previousList);
    setPendingDelete(null);
    announce(t('dice.savedAnnounce', { label: pendingDelete.preset.label }));
  }, [pendingDelete, persistPresets, announce, t]);

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
  const nameValid = draftLabel.trim().length > 0;

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
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
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
              {!p.persisted && (
                <span
                  title={t('dice.memoryOnlyBadge')}
                  style={{ marginLeft: 6, fontSize: 9.5, opacity: 0.7, fontStyle: 'italic' }}
                >
                  {t('dice.memoryOnlyBadge')}
                </span>
              )}
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
            onClick={openSave}
            className="text-muted"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, padding: '0 6px', marginLeft: 'auto' }}
          >
            {t('dice.saveRoll')}
          </button>
        )}
      </div>

      {/* Save-roll naming modal (issue #690 — replaces native prompt()) */}
      {savePhase.kind === 'naming' && (
        <div className="dialog-backdrop" onClick={() => setSavePhase({ kind: 'closed' })}>
          <NamingDialog
            title={t('dice.saveRollTitle')}
            nameLabel={t('dice.saveRollNameLabel')}
            placeholder={t('dice.saveRollNamePlaceholder')}
            cancelLabel={t('dice.saveRollCancel')}
            confirmLabel={t('dice.saveRollConfirm')}
            onCancel={() => setSavePhase({ kind: 'closed' })}
            onSubmit={submitName}
            value={draftLabel}
            onChange={setDraftLabel}
            valid={nameValid}
            nameInputRef={nameInputRef}
            hint={savedPresets.length >= MAX_PRESETS ? t('dice.limitBody', { max: MAX_PRESETS }) : undefined}
          />
        </div>
      )}

      {/* Duplicate-replace confirmation (issue #690 — no silent overwrite) */}
      {savePhase.kind === 'confirm-duplicate' && (
        <div className="dialog-backdrop" onClick={() => setSavePhase({ kind: 'naming' })}>
          <ConfirmInline
            title={t('dice.duplicateTitle')}
            body={t('dice.duplicateBody', { label: savePhase.label })}
            confirmLabel={t('dice.duplicateConfirm')}
            cancelLabel={t('dice.saveRollCancel')}
            danger={false}
            onCancel={() => setSavePhase({ kind: 'naming' })}
            onConfirm={() => commitSave(savePhase.label)}
          />
        </div>
      )}

      {/* 12-preset limit disclosure (issue #690 — no silent eviction) */}
      {savePhase.kind === 'limit' && (
        <div className="dialog-backdrop" onClick={() => setSavePhase({ kind: 'closed' })}>
          <ConfirmInline
            title={t('dice.limitTitle')}
            body={t('dice.limitBody', { max: MAX_PRESETS })}
            confirmLabel={t('dice.limitConfirm')}
            cancelLabel={t('dice.saveRollCancel')}
            danger={false}
            cancelHidden
            onCancel={() => setSavePhase({ kind: 'closed' })}
            onConfirm={() => setSavePhase({ kind: 'closed' })}
          />
        </div>
      )}

      {/* Storage-failure notice (private mode / quota — issue #690).
          One-shot: shown once right after a save that couldn't persist, then
          dismissed. The sticky `storageBlocked` flag keeps the per-preset
          memory-only badge accurate without re-popping this modal. */}
      {storageNotice && savePhase.kind === 'closed' && !pendingDelete && (
        <div className="dialog-backdrop" onClick={() => setStorageNotice(false)}>
          <ConfirmInline
            title={t('dice.memoryOnlyTitle')}
            body={t('dice.memoryOnlyBody')}
            confirmLabel={t('dice.memoryOnlyConfirm')}
            cancelLabel={t('dice.saveRollCancel')}
            danger={false}
            cancelHidden
            onCancel={() => setStorageNotice(false)}
            onConfirm={() => setStorageNotice(false)}
          />
        </div>
      )}

      {/* Deletion Undo (issue #690 — recoverable, not immediate) */}
      {pendingDelete && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          style={{
            position: 'fixed',
            left: '50%',
            bottom: 24,
            transform: 'translateX(-50%)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            maxWidth: 'calc(100vw - 32px)',
            padding: '10px 12px 10px 16px',
            borderRadius: 'var(--radius-md, 10px)',
            background: 'var(--color-neutral-800, #1c1c22)',
            color: 'var(--color-neutral-100, #f2f2f5)',
            border: '1px solid var(--color-neutral-700, #333)',
            boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
            fontSize: 13,
          }}
        >
          <span aria-hidden>{t('dice.deleteUndo', { label: pendingDelete.preset.label })}</span>
          <button
            type="button"
            style={{ fontSize: 12.5, minHeight: 0, padding: '4px 12px' }}
            className="cf-btn cf-btn-ghost"
            onClick={() => void undoDelete()}
          >
            {t('dice.undo')}
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              if (deleteTimerRef.current != null) {
                clearTimeout(deleteTimerRef.current);
                deleteTimerRef.current = null;
              }
              setPendingDelete(null);
            }}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--color-neutral-400, #999)',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: '2px 4px',
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Naming modal — the `.dialog` / `.dialog-backdrop` pattern (see nocturne.css)
 * with accessible focus management via `useDialog`. Replaces the native
 * `prompt()` for naming a saved roll (issue #690).
 */
function NamingDialog({
  title,
  nameLabel,
  placeholder,
  cancelLabel,
  confirmLabel,
  onCancel,
  onSubmit,
  value,
  onChange,
  valid,
  nameInputRef,
  hint,
}: {
  title: string;
  nameLabel: string;
  placeholder: string;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onSubmit: () => void;
  value: string;
  onChange: (v: string) => void;
  valid: boolean;
  nameInputRef: React.RefObject<HTMLInputElement | null>;
  hint?: string;
}) {
  const dialogRef = useDialog<HTMLDivElement>({ onClose: onCancel, initialFocusRef: nameInputRef });
  const titleId = useRef(`dice-save-title-${Math.random().toString(36).slice(2)}`).current;
  // TextInput is a forwardRef<HTMLInputElement>; the input ref is shared with
  // useDialog's initial-focus target. A callback ref bridges the (nullable)
  // MutableRefObject the dialog expects with the (non-null) RefObject the
  // forwardRef component is typed for.
  const setInputRef = useCallback((node: HTMLInputElement | null) => {
    (nameInputRef as React.MutableRefObject<HTMLInputElement | null>).current = node;
  }, [nameInputRef]);

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (valid) onSubmit();
    }
  }

  return (
    <div
      ref={dialogRef}
      className="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => e.stopPropagation()}
    >
      <p className="dialog-title" id={titleId}>
        {title}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{ fontSize: 12, opacity: 0.7 }} htmlFor="dice-save-name">
          {nameLabel}
        </label>
        <TextInput
          id="dice-save-name"
          ref={setInputRef}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          autoComplete="off"
          maxLength={40}
          style={{ width: '100%' }}
        />
        {hint && (
          <p role="note" style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
            {hint}
          </p>
        )}
      </div>
      <div className="dialog-actions">
        <Btn ghost onClick={onCancel}>
          {cancelLabel}
        </Btn>
        <Btn onClick={onSubmit} disabled={!valid}>
          {confirmLabel}
        </Btn>
      </div>
    </div>
  );
}

/**
 * Inline confirm notice for the duplicate / limit / memory-only flows. Same
 * accessible `.dialog` pattern as ConfirmDialog but rendered inline here so the
 * save modal's local state machine owns open/close. `cancelHidden` collapses
 * the cancel button for pure acknowledgements (limit disclosure, memory notice).
 */
function ConfirmInline({
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger = false,
  cancelHidden = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  cancelHidden?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useDialog<HTMLDivElement>({ onClose: onCancel });
  const titleId = useRef(`dice-confirm-title-${Math.random().toString(36).slice(2)}`).current;
  return (
    <div
      ref={dialogRef}
      className="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => e.stopPropagation()}
    >
      <p className="dialog-title" id={titleId}>
        {title}
      </p>
      <div className="dialog-body">{body}</div>
      <div className="dialog-actions">
        {!cancelHidden && (
          <Btn ghost onClick={onCancel}>
            {cancelLabel}
          </Btn>
        )}
        <Btn danger={danger} onClick={onConfirm}>
          {confirmLabel}
        </Btn>
      </div>
    </div>
  );
}
