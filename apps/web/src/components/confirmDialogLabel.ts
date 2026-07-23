/**
 * Confirm-dialog busy labels (issue #793).
 *
 * Callers used to pass `confirmLabel={busy ? 'Ending…' : 'End encounter'}`, but
 * ConfirmDialog overwrote every busy state with generic "Working…", making those
 * ternaries unreachable. Busy copy should keep the action (+ object) — e.g.
 * "Ending encounter…" — via an explicit `pendingLabel` or a grammatical
 * derivation from `confirmLabel`.
 */

/** Irregular gerund spellings that do not follow the default -ing rules. */
const SPECIAL_GERUNDS: Record<string, string> = {
  cancel: 'Cancelling',
};

/**
 * Turn an imperative confirm label into a progressive busy label.
 * "End encounter" → "Ending encounter…"; "Remove" → "Removing…".
 * Labels that already end in `…` are returned unchanged; a trailing `...`
 * is normalized to `…`.
 */
export function derivePendingLabel(confirmLabel: string): string {
  const label = confirmLabel.trim();
  if (!label) return 'Working…';
  if (/…$/.test(label)) return label;
  if (/\.\.\.$/.test(label)) return `${label.slice(0, -3)}…`;

  const [verb, ...restParts] = label.split(/\s+/);
  const rest = restParts.join(' ');
  const gerund = verbToGerund(verb);
  return rest ? `${gerund} ${rest}…` : `${gerund}…`;
}

/**
 * Label shown on the confirm button while `busy` is true.
 * Explicit non-empty `pendingLabel` (after trim) wins; otherwise derive from
 * `confirmLabel`.
 */
export function resolveBusyConfirmLabel(confirmLabel: string, pendingLabel?: string): string {
  const explicit = pendingLabel?.trim();
  if (explicit) return explicit;
  return derivePendingLabel(confirmLabel);
}

function verbToGerund(verb: string): string {
  const lower = verb.toLowerCase();
  const special = SPECIAL_GERUNDS[lower];
  if (special) return matchVerbCase(special, verb);

  let stem = lower;
  if (stem.endsWith('ie')) {
    stem = `${stem.slice(0, -2)}y`;
  } else if (stem.endsWith('e') && !stem.endsWith('ee')) {
    stem = stem.slice(0, -1);
  } else if (shouldDoubleFinalConsonant(stem)) {
    stem = `${stem}${stem[stem.length - 1]}`;
  }

  return matchVerbCase(`${stem}ing`, verb);
}

/** Double the final consonant for short CVC verbs (run → running). */
function shouldDoubleFinalConsonant(word: string): boolean {
  if (word.length < 3) return false;
  const vowels = 'aeiou';
  const a = word[word.length - 3];
  const b = word[word.length - 2];
  const c = word[word.length - 1];
  if (vowels.includes(c) || c === 'w' || c === 'x' || c === 'y') return false;
  if (!vowels.includes(b) || vowels.includes(a)) return false;
  // Monosyllable approximation: a single vowel group.
  const groups = word.replace(/[^aeiou]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return groups.length === 1;
}

function matchVerbCase(gerund: string, originalVerb: string): string {
  if (!originalVerb) return gerund;
  if (originalVerb[0] === originalVerb[0].toUpperCase()) {
    return `${gerund[0].toUpperCase()}${gerund.slice(1).toLowerCase()}`;
  }
  return gerund.toLowerCase();
}
