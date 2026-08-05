export function duplicateCombatantName(name: string, rosterNames: readonly string[]): string {
  const match = /^(.*?)(?:\s+(\d+))?$/.exec(name.trim());
  const base = match?.[1] || name.trim();
  const max = rosterNames.reduce((highest, candidate) => {
    const trimmed = candidate.trim();
    if (trimmed === base) return Math.max(highest, 1);
    const found = /^(.*?)\s+(\d+)$/.exec(trimmed);
    if (!found) return highest;
    const number = Number(found[2]);
    const suffixText = ` ${number}`;
    // Long names are shortened to make room for their number. Compare against the
    // same number-specific prefix so the second (and later) duplicate stays in the
    // same roster family even as the suffix grows from one digit to two.
    const expectedBase = base.slice(0, 120 - suffixText.length);
    return found[1] === expectedBase ? Math.max(highest, number) : highest;
  }, 1);
  const suffixText = ` ${max + 1}`;
  return `${base.slice(0, 120 - suffixText.length)}${suffixText}`;
}
