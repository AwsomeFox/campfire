import { GROUNDING_PREAMBLE } from '../../src/modules/ai-driver/ai-driver.service';
import { ActionSpec, isResolvableSpec, rollBranchDamage, type OutcomeBranch } from '@campfire/schema';

/**
 * #1053 — the AI DM must be TOLD that server-side attack resolution exists.
 *
 * ── Do not delete this as prompt trivia ───────────────────────────────────────────────
 * The issue was filed as "no tool combines roll d20 + compare AC + apply damage; the AI must
 * chain three or more calls and each step risks hallucination". The observation was true and
 * the diagnosis was wrong: `resolve_action` (#414) had done all of it server-side — adapter-
 * aware hit/miss/crit, crit doubling the DICE only, resistance/immunity, atomic apply, undo
 * token — and was already on the driver's live-play allowlist. What was missing was one
 * sentence in the system prompt. The preamble said "you may resolve live play directly: ROLL
 * DICE, apply HP/conditions…", which is a description of the manual chain, and never named
 * `resolve_action` at all.
 *
 * So the capability existed, the allowlist permitted it, and the model was told to do it the
 * manual way. NOTHING in the test suite could detect that, which is why this file exists: a
 * prompt regression that silently reintroduces hand-rolled attacks looks identical to a
 * passing build. These assertions are the detector.
 */

const preamble = GROUNDING_PREAMBLE;

describe('driver system prompt names the server-side attack path (#1053)', () => {
  it('tells the model to use resolve_action for attacks', () => {
    expect(preamble).toMatch(/resolve_action/);
    expect(preamble).toMatch(/attack/i);
  });

  it('no longer offers "roll dice" as the way to resolve live play', () => {
    // The exact phrasing that caused the issue. A future edit that reinstates an unqualified
    // "roll dice" in the live-play sentence puts the model straight back on the manual chain.
    expect(preamble).not.toMatch(/resolve live play directly:[^\n]*roll dice/i);
  });

  it('says a single call can both resolve and apply', () => {
    // Without this the model resolves, then has to decide to apply — and a preview it never
    // commits is a narrated attack that never touched anyone's HP.
    expect(preamble).toMatch(/commit\s*:\s*true/i);
  });

  it('qualifies what roll_dice is still FOR, so the ambiguity does not return', () => {
    // An unqualified "you may roll dice" is what created the ambiguity in the first place.
    expect(preamble).toMatch(/roll_dice/);
    expect(preamble).toMatch(/roll_dice[^\n]*(no target|no consequence)/i);
  });

  it('states the crit rule the server actually implements', () => {
    // The model narrates the outcome, so it needs the same rule the server applied, or its
    // prose contradicts the numbers on the sheet.
    expect(preamble).toMatch(/crit[^\n]*doubles the dice/i);
    expect(preamble).toMatch(/never the flat/i);
  });
});

/**
 * The prompt carries a WORKED inline-spec example. This is the half of the fix that decides
 * whether the change moves behaviour at all: naming a tool whose input shape the model cannot
 * construct just makes it fail once and fall back to the manual chain — a change that looks
 * correct and does nothing.
 */
describe('the inline-spec example in the prompt is actually valid (#1053)', () => {
  /**
   * Extracted from the preamble itself, so the example cannot rot away from the assertion.
   * Brace-counted rather than regex-matched: a pattern like `\}\}\}\}` silently stops matching
   * the moment the example gains or loses a nesting level, and a test that cannot find its
   * subject fails for the wrong reason.
   */
  function exampleFromPrompt(): unknown {
    const start = preamble.indexOf('{"mode":"attack"');
    if (start === -1) throw new Error('the prompt no longer carries an inline attack-spec example');
    let depth = 0;
    for (let i = start; i < preamble.length; i++) {
      if (preamble[i] === '{') depth++;
      else if (preamble[i] === '}') {
        depth--;
        if (depth === 0) return JSON.parse(preamble.slice(start, i + 1));
      }
    }
    throw new Error('the inline attack-spec example in the prompt has unbalanced braces');
  }

  it('parses as an ActionSpec', () => {
    expect(() => ActionSpec.parse(exampleFromPrompt())).not.toThrow();
  });

  it('is RESOLVABLE — the property a plausible guess fails', () => {
    // Every ActionSpec field is optional with a default, so `{}` and `{attack:{bonus:'+5'}}`
    // both parse happily and then fail isResolvableSpec for want of `mode`. That is precisely
    // the trap an unguided model falls into, and why an example beats a field list.
    expect(isResolvableSpec(ActionSpec.parse(exampleFromPrompt()))).toBe(true);
    expect(isResolvableSpec(ActionSpec.parse({ attack: { bonus: '+5' } }))).toBe(false);
    expect(isResolvableSpec(ActionSpec.parse({}))).toBe(false);
  });

  it('carries a hit branch with damage, so a hit actually does something', () => {
    const spec = ActionSpec.parse(exampleFromPrompt());
    expect(spec.outcomes.hit?.damage?.length).toBeGreaterThan(0);
  });

  it('keeps the modifier OUT of the dice formula, as the prompt instructs', () => {
    // The example is what the model will copy. If it modelled "1d8+3" as a formula it would
    // teach exactly the mistake the surrounding sentence warns against.
    const spec = ActionSpec.parse(exampleFromPrompt());
    const part = spec.outcomes.hit!.damage[0];
    expect(part.formula).not.toMatch(/[+-]\s*\d/);
    expect(part.flat).toBeGreaterThan(0);
  });
});

/**
 * Why the formula/flat split is load-bearing (#1053).
 *
 * `DamagePart.formula`'s own doc comment used to read `Dice expression ("2d6+3")`, which
 * contradicted `rollBranchDamage`'s contract that a crit re-rolls `formula` and adds `flat`
 * once. Anyone following the documented example got the modifier doubled on every critical
 * hit — silently, with no error. These pin the real behaviour so the two cannot drift apart
 * again, and so the hazard is written down rather than rediscovered.
 */
describe('critical damage doubles dice, never the modifier (#1053)', () => {
  /** Deterministic roller: every die shows its maximum face. */
  const maxRoll = (expr: string) => {
    const [count, sides] = expr.split('d').map(Number);
    return { total: count * sides } as ReturnType<Parameters<typeof rollBranchDamage>[1]>;
  };

  function branch(formula: string, flat: number): OutcomeBranch {
    return {
      damage: [{ formula, flat, type: 'slashing' }],
      halfDamage: false,
      healing: '',
      tempHp: '',
      effects: [],
      text: '',
    };
  }

  it('the CORRECT shape doubles only the dice', () => {
    // 1d8 max = 8. Normal: 8 + 3 = 11. Crit: (8 + 8) + 3 = 19 — the +3 is added once.
    expect(rollBranchDamage(branch('1d8', 3), maxRoll).parts[0].amount).toBe(11);
    expect(rollBranchDamage(branch('1d8', 3), maxRoll, { critical: true }).parts[0].amount).toBe(19);
  });

  it('folding the modifier INTO the formula doubles it — the hazard the docs used to invite', () => {
    // "1d8+3" as a formula rolls 11 normally (same as above), but 22 on a crit instead of 19:
    // the +3 got doubled. Nothing errors; the sheet is just quietly wrong.
    const wrong = rollBranchDamage(branch('1d8+3', 0), (expr) => {
      const m = expr.match(/(\d+)d(\d+)(?:\+(\d+))?/)!;
      return { total: Number(m[1]) * Number(m[2]) + Number(m[3] ?? 0) } as ReturnType<
        Parameters<typeof rollBranchDamage>[1]
      >;
    }, { critical: true });
    expect(wrong.parts[0].amount).toBe(22);
    // ...versus the 19 the correct split produces. Documented, not endorsed.
    expect(wrong.parts[0].amount).not.toBe(19);
  });
});
