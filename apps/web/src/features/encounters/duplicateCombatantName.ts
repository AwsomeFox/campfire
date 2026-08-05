export function duplicateCombatantName(name: string, rosterNames: readonly string[]): string {
  const match = /^(.*?)(?:\s+(\d+))?$/.exec(name.trim());
  const base = match?.[1] || name.trim();
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffix = new RegExp(`^${escaped}(?:\\s+(\\d+))?$`);
  const max = rosterNames.reduce((highest, candidate) => {
    const found = suffix.exec(candidate.trim());
    return found ? Math.max(highest, Number(found[1] ?? 1)) : highest;
  }, 1);
  const suffixText = ` ${max + 1}`;
  return `${base.slice(0, 120 - suffixText.length)}${suffixText}`;
}
