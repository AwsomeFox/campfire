/**
 * Expand a dice expression into per-die side counts for roll animation (issue #1352).
 * Order matches server roll order: `2d6+1d20` → [6, 6, 20]. Modifier-only terms are
 * skipped; unknown shapes yield an empty list (caller skips animation).
 */
const DICE_GROUP_RE = /(\d+)d(\d+)/gi;

export function parseDiceGroupsFromExpr(expr: string): { count: number; sides: number }[] {
  const groups: { count: number; sides: number }[] = [];
  let match: RegExpExecArray | null;
  DICE_GROUP_RE.lastIndex = 0;
  while ((match = DICE_GROUP_RE.exec(expr)) !== null) {
    const count = Number.parseInt(match[1], 10);
    const sides = Number.parseInt(match[2], 10);
    if (Number.isFinite(count) && Number.isFinite(sides) && count > 0 && sides > 0) {
      groups.push({ count, sides });
    }
  }
  return groups;
}

/** Flat list of die sides in roll order (one entry per physical die). */
export function expandDiceSidesFromExpr(expr: string): number[] {
  const out: number[] = [];
  for (const { count, sides } of parseDiceGroupsFromExpr(expr)) {
    for (let i = 0; i < count; i++) out.push(sides);
  }
  return out;
}
