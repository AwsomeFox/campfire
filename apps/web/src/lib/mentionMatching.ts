import type { MentionTarget } from '@campfire/schema';

/** A unique, normalized entity name ready to match against rendered text. */
export type MentionCandidate = {
  key: string;
  target: MentionTarget;
};

/** UTF-16 source offsets for one mention in the original, unnormalized text. */
export type MentionMatch = {
  start: number;
  end: number;
  target: MentionTarget;
};

type Segment = { index: number; segment: string };
type SegmenterLike = { segment(input: string): Iterable<Segment> };
type SegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: 'grapheme' | 'word' },
) => SegmenterLike;

export type MentionSegmentationOptions = {
  /** Test hook and compatibility escape hatch for runtimes without Intl.Segmenter. */
  forceFallback?: boolean;
};

function unicodePattern(source: string, flags = 'u'): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

// Construct Unicode-property expressions at runtime. Older embedded browsers that
// cannot parse one of these properties now disable auto-linking safely instead of
// failing module evaluation and taking the whole Markdown renderer down.
const WORD_CHARACTER = unicodePattern('[\\p{L}\\p{M}\\p{N}\\p{Pc}]');
const COMBINING_MARK = unicodePattern('\\p{M}');
const COMBINING_MARK_GLOBAL = unicodePattern('\\p{M}', 'gu');
const SCRIPT_WITHOUT_REQUIRED_SPACES = unicodePattern(
  '(?:\\p{Script_Extensions=Han}|\\p{Script_Extensions=Hiragana}|\\p{Script_Extensions=Katakana}|\\p{Script_Extensions=Bopomofo}|\\p{Script_Extensions=Hangul}|\\p{Script_Extensions=Thai}|\\p{Script_Extensions=Lao}|\\p{Script_Extensions=Khmer}|\\p{Script_Extensions=Myanmar})',
);
const UNICODE_MENTION_MATCHING_SUPPORTED = Boolean(
  WORD_CHARACTER && COMBINING_MARK && COMBINING_MARK_GLOBAL && SCRIPT_WITHOUT_REQUIRED_SPACES,
);

/**
 * Canonical mention key strategy.
 *
 * NFD makes precomposed and combining-mark spellings compare identically without
 * compatibility-folding distinct names (as NFKC/NFKD would). JavaScript's
 * locale-independent Unicode lowercase mapping keeps results deterministic when
 * two users have different browser locales. The second NFD restores canonical
 * order if case conversion introduced combining marks.
 */
function foldUnicode(value: string): string {
  return value.normalize('NFD').toLowerCase().normalize('NFD');
}

export function normalizeMentionName(value: string): string {
  return foldUnicode(value.trim());
}

/** Drop canonically equal/case-equal collisions, then sort deterministically. */
export function buildMentionCandidates(targets: ReadonlyArray<MentionTarget>): MentionCandidate[] {
  if (!UNICODE_MENTION_MATCHING_SUPPORTED) return [];
  const byKey = new Map<string, MentionTarget | null>();
  for (const target of targets) {
    const key = normalizeMentionName(target.name);
    if (!key) continue;
    const baseCharacterCount = [...key.replace(COMBINING_MARK_GLOBAL!, '')].length;
    if (baseCharacterCount < 2 && !SCRIPT_WITHOUT_REQUIRED_SPACES!.test(key)) continue;
    byKey.set(key, byKey.has(key) ? null : target);
  }

  return [...byKey.entries()]
    .filter((entry): entry is [string, MentionTarget] => entry[1] !== null)
    .map(([key, target]) => ({ key, target }))
    .sort((left, right) => {
      if (left.key.length !== right.key.length) return right.key.length - left.key.length;
      if (left.key !== right.key) return left.key < right.key ? -1 : 1;
      if (left.target.type !== right.target.type) return left.target.type < right.target.type ? -1 : 1;
      return left.target.id - right.target.id;
    });
}

function segmenter(granularity: 'grapheme' | 'word', forceFallback: boolean): SegmenterLike | null {
  if (forceFallback) return null;
  const Segmenter = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;
  return Segmenter ? new Segmenter('und', { granularity }) : null;
}

/**
 * Conservative grapheme fallback used only to preserve source offsets. Grouping
 * marks with their base is sufficient for canonical NFD matching; emoji and ZWJ
 * sequences do not change length under our normalization strategy.
 */
function fallbackGraphemes(input: string): Segment[] {
  const result: Segment[] = [];
  let offset = 0;
  for (const point of input) {
    const previous = result[result.length - 1];
    if (previous && COMBINING_MARK!.test(point)) previous.segment += point;
    else result.push({ index: offset, segment: point });
    offset += point.length;
  }
  return result;
}

function graphemes(input: string, forceFallback: boolean): Segment[] {
  const native = segmenter('grapheme', forceFallback);
  return native ? [...native.segment(input)] : fallbackGraphemes(input);
}

function normalizedSource(input: string, forceFallback: boolean) {
  const normalized = foldUnicode(input);
  const starts = new Map<number, number>([[0, 0]]);
  const ends = new Map<number, number>([[0, 0]]);
  let normalizedOffset = 0;

  for (const part of graphemes(input, forceFallback)) {
    const sourceEnd = part.index + part.segment.length;
    starts.set(normalizedOffset, part.index);
    normalizedOffset += foldUnicode(part.segment).length;
    ends.set(normalizedOffset, sourceEnd);
  }

  // Unicode's context-sensitive case mappings currently preserve these offset
  // lengths. Keep a safe whole-string fallback if a future runtime adds one that
  // does not: no match is preferable to slicing through the wrong source text.
  if (normalizedOffset !== normalized.length) {
    starts.clear();
    ends.clear();
    starts.set(0, 0);
    ends.set(normalized.length, input.length);
  }

  return { normalized, starts, ends };
}

function codePointBefore(input: string, index: number): string {
  if (index <= 0) return '';
  const previous = input.charCodeAt(index - 1);
  const start = previous >= 0xdc00 && previous <= 0xdfff ? index - 2 : index - 1;
  return String.fromCodePoint(input.codePointAt(Math.max(0, start))!);
}

function codePointAt(input: string, index: number): string {
  if (index >= input.length) return '';
  return String.fromCodePoint(input.codePointAt(index)!);
}

function fallbackBoundary(input: string, index: number): boolean {
  if (index <= 0 || index >= input.length) return true;
  const left = codePointBefore(input, index);
  const right = codePointAt(input, index);
  if (!WORD_CHARACTER!.test(left) || !WORD_CHARACTER!.test(right)) return true;

  // Scripts commonly written without spaces must remain matchable in running
  // prose. For whitespace-delimited scripts, adjacent word characters mean the
  // candidate is only a partial name and must not link.
  return SCRIPT_WITHOUT_REQUIRED_SPACES!.test(left) || SCRIPT_WITHOUT_REQUIRED_SPACES!.test(right);
}

function boundaryPredicate(input: string, forceFallback: boolean): (index: number) => boolean {
  const native = segmenter('word', forceFallback);
  if (!native) return (index) => fallbackBoundary(input, index);

  const boundaries = new Set<number>([0, input.length]);
  for (const part of native.segment(input)) {
    boundaries.add(part.index);
    boundaries.add(part.index + part.segment.length);
  }
  return (index) => boundaries.has(index);
}

/**
 * Find every non-overlapping mention in one text node. Matching is stateless:
 * every call starts at offset zero, so repeated and adjacent DOM text nodes have
 * identical behavior. Earliest source position wins; at the same position the
 * longest entity name wins.
 */
export function findMentionMatches(
  text: string,
  candidates: ReadonlyArray<MentionCandidate>,
  options: MentionSegmentationOptions = {},
): MentionMatch[] {
  if (!text || candidates.length === 0) return [];
  const forceFallback = options.forceFallback === true;
  const source = normalizedSource(text, forceFallback);
  const isBoundary = boundaryPredicate(source.normalized, forceFallback);
  const possible: Array<MentionMatch & { normalizedStart: number; normalizedEnd: number }> = [];

  for (const candidate of candidates) {
    let from = 0;
    while (from <= source.normalized.length - candidate.key.length) {
      const normalizedStart = source.normalized.indexOf(candidate.key, from);
      if (normalizedStart < 0) break;
      const normalizedEnd = normalizedStart + candidate.key.length;
      const start = source.starts.get(normalizedStart);
      const end = source.ends.get(normalizedEnd);
      if (start !== undefined && end !== undefined && isBoundary(normalizedStart) && isBoundary(normalizedEnd)) {
        possible.push({ start, end, target: candidate.target, normalizedStart, normalizedEnd });
      }
      from = normalizedStart + Math.max(1, candidate.key.length);
    }
  }

  possible.sort((left, right) => {
    if (left.normalizedStart !== right.normalizedStart) return left.normalizedStart - right.normalizedStart;
    if (left.normalizedEnd !== right.normalizedEnd) return right.normalizedEnd - left.normalizedEnd;
    if (left.target.type !== right.target.type) return left.target.type < right.target.type ? -1 : 1;
    return left.target.id - right.target.id;
  });

  const matches: MentionMatch[] = [];
  let consumedThrough = -1;
  for (const match of possible) {
    if (match.normalizedStart < consumedThrough) continue;
    matches.push({ start: match.start, end: match.end, target: match.target });
    consumedThrough = match.normalizedEnd;
  }
  return matches;
}
