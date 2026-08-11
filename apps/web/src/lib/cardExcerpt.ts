/**
 * A bounded, plain-text preview for a list card.
 *
 * List cards clamp their preview to two lines in CSS, but a clamp only limits PAINTING —
 * the whole string still lands in the DOM, and in a `title` attribute it becomes a tooltip
 * the size of the field. `Quest.body` and `Npc.body` allow up to 50,000 characters and the
 * list endpoints are unpaginated, so a legitimate campaign could push megabytes of markdown
 * into a single list render.
 *
 * Bounding happens BEFORE render for that reason. Two lines of a card are on the order of
 * 120 characters; 200 leaves room for wider viewports without ever approaching the field
 * limit.
 */
export const CARD_EXCERPT_MAX = 200;

/**
 * Collapse the markdown a body may contain down to something a one-glance preview can show.
 *
 * Deliberately shallow — this is not a markdown renderer, and it does not need to be. It
 * strips the marks that would otherwise show up as literal punctuation in the preview
 * (heading hashes, emphasis, list bullets, blockquote carets, link syntax, code ticks) and
 * flattens whitespace so a multi-paragraph body reads as one line rather than as a column
 * of fragments.
 */
export function cardExcerpt(body: string | null | undefined, max: number = CARD_EXCERPT_MAX): string {
  if (!body) return '';
  const flattened = body
    // Take the leading slice first: everything below is linear in input length, and a 50k
    // body should not be fully rewritten to produce 200 characters. The margin covers marks
    // that get stripped rather than kept.
    .slice(0, max * 4)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[>\s]*[-*+]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened.length <= max) return flattened;
  // Cut on a word boundary so the preview does not end mid-word.
  const cut = flattened.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
