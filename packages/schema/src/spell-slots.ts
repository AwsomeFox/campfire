/**
 * Spell-slot expenditure — the single definition of what a slot level's maximum means and
 * when a spend must fail (issue #1039).
 *
 * ── What the issue assumes, and what is actually there ────────────────────────────────
 * The issue reports "no MCP tool wraps `POST :id/spell-slots`, and there's no
 * `patch_spell_slots` in DRIVER_LIVE_PLAY_TOOLS". Half of that is right:
 *
 *   - An MCP tool DOES exist — `adjust_spell_slots` (mcp-tools.ts), registered and pinned in
 *     the catalog. It is simply not named `patch_spell_slots`. Adding a second tool with the
 *     same job would be the duplicate-implementation trap, so the fix wires up the one that
 *     exists rather than minting a rival.
 *   - It is genuinely ABSENT from `DRIVER_LIVE_PLAY_TOOLS`, so the driver seat — which is
 *     default-deny — could never call it. That half of the issue is exactly right.
 *
 * ── The real defect ───────────────────────────────────────────────────────────────────
 * The acceptance criterion "errors when no slots remain" was NOT met, and not because the tool
 * was missing: `CharactersService.patchSpellSlots` SILENTLY CLAMPED. Casting at a level with
 * `used === max` returned 201 with an unchanged sheet. For a human clicking a pip that is a
 * confusing no-op; for the AI DM it is the unlimited-casting hole itself, because a model that
 * receives a success narrates the spell as cast. The only error it raised was for a level with
 * no slots configured at all.
 *
 * Its sibling thirty lines below — `adjustResource` (#422) — throws on exactly this condition.
 * Two methods on one service disagreed about whether overspend is an error, and the safe one
 * was not the one guarding spells.
 *
 * ── The asymmetry here is deliberate ──────────────────────────────────────────────────
 * Overspending is an ERROR; over-restoring CLAMPS to zero. They are not the same act. Spending
 * is a claim on a resource, and a claim that cannot be honoured must fail loudly or the caller
 * proceeds as though it succeeded. Restoring cannot invent anything — it converges on
 * `used = 0`, which is precisely the state a long rest produces legitimately — so failing a
 * restore that overshoots would be noise, and a UI that restores one pip at a time would hit it
 * constantly. (`adjustResource` errors in both directions; if a reviewer prefers strict
 * symmetry, {@link applySpellSlotDelta} is the one place to change it.)
 *
 * Everything here is pure so the boundary conditions are testable without a database, and so
 * the several existing writers of the `spellSlots` blob can share one notion of "remaining".
 */
import { z } from 'zod';

/** Lowest addressable spell level. */
export const SPELL_SLOT_MIN_LEVEL = 1;
/** Highest addressable spell level; matches `SpellSlotPatch.level`'s bound. */
export const SPELL_SLOT_MAX_LEVEL = 9;

/** One level's pool, mirroring the stored `SpellSlotLevel`. */
export const SpellSlotPool = z.object({
  max: z.number().int().min(0),
  used: z.number().int().min(0),
});
export type SpellSlotPool = z.infer<typeof SpellSlotPool>;

/** The stored blob: level (as a string key) → pool. */
export type SpellSlotMap = Record<string, SpellSlotPool>;

/** Why a slot change was refused. */
export type SpellSlotDeltaError =
  /** The character has no slots configured at that level at all. */
  | 'no_slots_at_level'
  /** Fewer slots remain than the spend asked for. This is the unlimited-casting guard. */
  | 'insufficient_slots';

export interface SpellSlotDeltaFailure {
  ok: false;
  reason: SpellSlotDeltaError;
  level: number;
  /**
   * Slots left at that level RIGHT NOW.
   *
   * On the failure path specifically, this is the field that lets the AI DM self-correct
   * instead of retrying blindly: a bare "no slots remain" invites the model to try again or to
   * narrate the spell anyway, whereas "you asked to spend 1, you have 0 of 4" tells it what to
   * do next (cast at another level, or take a rest).
   */
  remaining: number;
  max: number;
  message: string;
}

export interface SpellSlotDeltaSuccess {
  ok: true;
  level: number;
  /** The full replacement blob, ready to persist. Never mutates the input. */
  slots: SpellSlotMap;
  usedBefore: number;
  usedAfter: number;
  /** Slots left AFTER the change — echoed to the caller so a model never has to guess. */
  remaining: number;
  max: number;
  /** True when a restore was clamped at zero rather than refused. */
  clamped: boolean;
}

export type SpellSlotDeltaResult = SpellSlotDeltaSuccess | SpellSlotDeltaFailure;

/** Slots left at a level; 0 when the level is not configured. */
export function spellSlotsRemaining(slots: Readonly<SpellSlotMap>, level: number): number {
  const pool = slots[String(level)];
  if (!pool || pool.max <= 0) return 0;
  return Math.max(0, pool.max - pool.used);
}

/**
 * Apply a spend (+delta) or restore (-delta) at one spell level.
 *
 * PURE and non-mutating: returns a full replacement blob. The caller is expected to run this
 * inside the same synchronous transaction as the re-read that produced `slots` — see
 * `CharactersService.patchSpellSlots` for why that is what makes a concurrent double-cast safe.
 */
export function applySpellSlotDelta(
  slots: Readonly<SpellSlotMap>,
  level: number,
  delta: number,
): SpellSlotDeltaResult {
  const key = String(level);
  const pool = slots[key];
  const max = pool?.max ?? 0;

  if (!pool || max <= 0) {
    return {
      ok: false,
      reason: 'no_slots_at_level',
      level,
      remaining: 0,
      max: 0,
      message: `This character has no level ${level} spell slots. Set the level's maximum on the sheet first.`,
    };
  }

  const usedBefore = Math.max(0, Math.min(max, pool.used));
  const remainingBefore = max - usedBefore;

  // SPEND — must fail rather than clamp. This is the acceptance criterion and the whole
  // reason the tool is worth having: a silent success here is indistinguishable, to the
  // caller, from actually having cast the spell.
  if (delta > 0 && delta > remainingBefore) {
    return {
      ok: false,
      reason: 'insufficient_slots',
      level,
      remaining: remainingBefore,
      max,
      message:
        `Cannot spend ${delta} level ${level} spell ${delta === 1 ? 'slot' : 'slots'}: ` +
        `${remainingBefore} of ${max} remain. Cast at a different level, or take a long rest.`,
    };
  }

  // RESTORE — clamps. It cannot invent a slot, and `used = 0` is the state a long rest
  // produces anyway, so refusing an overshoot would be noise rather than protection.
  const rawAfter = usedBefore + delta;
  const usedAfter = Math.max(0, Math.min(max, rawAfter));

  return {
    ok: true,
    level,
    slots: { ...slots, [key]: { max, used: usedAfter } },
    usedBefore,
    usedAfter,
    remaining: max - usedAfter,
    max,
    clamped: rawAfter !== usedAfter,
  };
}

/**
 * A compact, name-free description of a slot change for the combat log.
 *
 * Name-free by contract: the combat log redacts actor/target names per role and forbids
 * name-bearing `detail` text (#869), so the character's name travels in the `actor` field.
 */
export function describeSpellSlotChange(result: SpellSlotDeltaSuccess): string {
  if (result.usedAfter === result.usedBefore) return `No change to level ${result.level} spell slots`;
  const spent = result.usedAfter > result.usedBefore;
  const count = Math.abs(result.usedAfter - result.usedBefore);
  const verb = spent ? 'spent' : 'restored';
  return `${verb} ${count} level ${result.level} spell ${count === 1 ? 'slot' : 'slots'} (${result.remaining}/${result.max} remaining)`;
}
