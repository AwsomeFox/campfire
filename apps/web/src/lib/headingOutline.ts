export type HeadingNode = {
  level: number;
  text: string;
};

/** Collect h1–h6 headings in document order from a DOM subtree. */
export function collectHeadingOutline(root: ParentNode): HeadingNode[] {
  return Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((el) => ({
    level: Number(el.tagName.slice(1)),
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }));
}

/**
 * Validate a page heading outline for issue #457:
 * - exactly one h1
 * - no skipped levels
 * - no duplicate adjacent titles at the same level
 */
export function validateHeadingOutline(outline: HeadingNode[]): string[] {
  const errors: string[] = [];
  if (outline.length === 0) {
    errors.push('outline is empty');
    return errors;
  }

  const h1Count = outline.filter((node) => node.level === 1).length;
  if (h1Count !== 1) {
    errors.push(`expected exactly one h1, got ${h1Count}`);
  }
  if (outline[0].level !== 1) {
    errors.push(`outline must start with h1, got h${outline[0].level}`);
  }

  for (let i = 1; i < outline.length; i++) {
    const prev = outline[i - 1];
    const cur = outline[i];
    if (cur.level - prev.level > 1) {
      errors.push(`heading level skips from h${prev.level} ("${prev.text}") to h${cur.level} ("${cur.text}")`);
    }
    if (prev.text === cur.text) {
      errors.push(`duplicate adjacent heading "${cur.text}" (h${prev.level} then h${cur.level})`);
    }
  }

  return errors;
}
