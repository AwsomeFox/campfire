/**
 * Two live button systems, not a missing <Btn> variant (issue #1713 Part A).
 *
 * §5 of #1533 misdiagnosed 325 raw `<button>` sites as evidence that <Btn> lacks an
 * icon/small variant. Re-classifying every raw `<button>` by its actual className found
 * a narrower, purely mechanical sub-problem: 16 sites hand-wrote the `cf-btn` class
 * directly on a raw `<button>` instead of composing `<Btn>` (the component that already
 * applies `cf-btn` + density + ghost/danger modifiers — see ui.tsx). Those were migrated
 * in #1713 Part A. This spec is the regression guard: it walks the whole `src` tree
 * (same shape as design-system-density.unit.spec.ts's drift-pattern scan and
 * ui-icons.unit.spec.ts's recursive control-surface scan) so a new raw
 * `className="cf-btn ..."` on a `<button>` fails CI instead of quietly regrowing the
 * count.
 *
 * Deliberately NOT flagged: the 17 `role="radio"|"menuitem"|"tab"|"switch"|"checkbox"`
 * buttons repo-wide are structurally different widgets (composite ARIA patterns, not
 * plain buttons) and are correctly raw `<button>` — #1713 explicitly excludes them from
 * migration. `ui.tsx`'s own `Btn` definition is exempted too: it's the one place that is
 * SUPPOSED to write `cf-btn` on a raw `<button>`, because it IS the `cf-btn` component.
 */
import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../src');
const UI_TSX = resolve(ROOT, 'components/ui.tsx');

/** ARIA roles that make a raw `<button>` a correct, non-migratable composite widget. */
const EXEMPT_ROLES = new Set(['radio', 'menuitem', 'tab', 'switch', 'checkbox']);

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSources(full, out);
    } else if (/\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract every raw `<button ...>` (or `<button ... />`) opening tag from `src`,
 * respecting nested `{...}` JS expressions and string/template literals so an
 * arrow function's `=>` (or any other stray `>`) inside an attribute value can't
 * truncate the tag early — a plain `<button[^>]*>` regex would misparse those.
 */
function findButtonTags(src: string): string[] {
  const tags: string[] = [];
  const re = /<button(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index;
    let i = start + '<button'.length;
    let braceDepth = 0;
    let inStr: string | null = null;
    let tagEnd = -1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (c === '\\') { i++; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === '{') { braceDepth++; continue; }
      if (c === '}') { braceDepth--; continue; }
      if (braceDepth === 0 && c === '>') { tagEnd = i; break; }
    }
    if (tagEnd === -1) continue;
    tags.push(src.slice(start, tagEnd + 1));
    re.lastIndex = tagEnd + 1;
  }
  return tags;
}

/**
 * Extract the raw value text of a `name="..."` / `name={...}` attribute from an
 * opening-tag string, balancing nested `{}` and string/template quoting the same way
 * `findButtonTags` balances the tag itself. Returns null if the attribute isn't present.
 */
function extractAttrValue(tag: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*`);
  const match = re.exec(tag);
  if (!match) return null;
  let i = match.index + match[0].length;
  const openChar = tag[i];
  if (openChar === '"' || openChar === "'") {
    const close = tag.indexOf(openChar, i + 1);
    if (close === -1) return null;
    return tag.slice(i + 1, close);
  }
  if (openChar !== '{') return null;
  let depth = 0;
  let inStr: string | null = null;
  const start = i;
  for (; i < tag.length; i++) {
    const c = tag[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') { depth++; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0) return tag.slice(start + 1, i);
      continue;
    }
  }
  return null;
}

/**
 * Whitespace-delimited class tokens actually assignable to this tag's `className`,
 * rather than a substring match over the whole opening tag — a `data-testid=` value,
 * a `title=`, or an unrelated class like `cf-btn-group` must never trip this. Handles
 * both a plain `className="cf-btn ..."` string and a `className={...}` expression
 * (ternaries / template literals with interpolations) by pulling every quoted string
 * literal out of the attribute value (including inside `${...}` interpolations).
 */
function classNameTokens(tag: string): string[] {
  const raw = extractAttrValue(tag, 'className');
  if (raw == null) return [];
  const literals: string[] = [];
  const quoteRe = /(['"`])((?:\\.|(?!\1).)*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = quoteRe.exec(raw))) {
    literals.push(match[2]);
  }
  const text = literals.length > 0 ? literals.join(' ') : raw;
  return text.split(/\s+/).filter(Boolean);
}

function hasCfBtnClass(tag: string): boolean {
  return classNameTokens(tag).includes('cf-btn');
}

function exemptRole(tag: string): string | null {
  const roleMatch = tag.match(/role=["']([a-z]+)["']/);
  if (roleMatch && EXEMPT_ROLES.has(roleMatch[1])) return roleMatch[1];
  return null;
}

const SOURCES = collectSources(ROOT);

test.describe('classNameTokens / hasCfBtnClass (Codex review on #1729)', () => {
  // The first cut of this guard substring-matched `cf-btn` over the WHOLE opening tag,
  // so a `data-testid="cf-btn-group"` or a `title="..."` mentioning cf-btn anywhere —
  // or a genuinely unrelated class like `cf-btn-group` — would spuriously fail CI. Both
  // directions are pinned here directly against the tokenizer, not just indirectly via
  // the real source tree (a one-directional proof is exactly how the original bug
  // slipped through review).

  test('still catches a genuine hand-written cf-btn class', () => {
    expect(hasCfBtnClass('<button type="button" className="cf-btn cf-btn-ghost cf-density-compact">')).toBe(true);
    expect(hasCfBtnClass('<button className="text-xs cf-btn">')).toBe(true);
    // className={...} expression form (ternary), as used nowhere in this repo's raw
    // buttons but worth covering since the attribute syntax is legal JSX.
    expect(hasCfBtnClass('<button className={cond ? "cf-btn cf-btn-ghost" : "cf-btn"}>')).toBe(true);
  });

  test('does NOT flag a cf-btn substring outside className', () => {
    expect(hasCfBtnClass('<button type="button" data-testid="cf-btn-group" onClick={onClick}>')).toBe(false);
    expect(hasCfBtnClass('<button title="Looks like a cf-btn but is not one">')).toBe(false);
    expect(hasCfBtnClass('<button aria-label="cf-btn-icon-preview">')).toBe(false);
  });

  test('does NOT flag a related-but-distinct class token like cf-btn-group', () => {
    expect(hasCfBtnClass('<button className="cf-btn-group flex items-center">')).toBe(false);
    expect(classNameTokens('<button className="cf-btn-group">')).toEqual(['cf-btn-group']);
  });

  test('ui.tsx\'s own Btn definition would still be caught by the tokenizer if it weren\'t exempted by file path', () => {
    // Confirms the file-path exemption in the tree scan (not a tokenizer quirk) is what
    // keeps ui.tsx green — the tokenizer itself correctly sees `cf-btn` as a real token
    // in a template-literal className.
    const btnTag = '<button ref={ref} className={`cf-btn ${densityClass(density)} ${ghost ? \'cf-btn-ghost\' : \'\'} ${className}`.trim()} {...rest} />';
    expect(hasCfBtnClass(btnTag)).toBe(true);
  });
});

test.describe('cf-btn migration (issue #1713 Part A)', () => {
  test('no raw <button> hand-writes the cf-btn class outside ui.tsx or a role-based widget', () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      if (file === UI_TSX) continue; // Btn's own implementation — the one legitimate site.
      const text = readFileSync(file, 'utf8');
      const tags = findButtonTags(text);
      for (const tag of tags) {
        if (!hasCfBtnClass(tag)) continue;
        if (exemptRole(tag)) continue; // radio/menuitem/tab/switch/checkbox — correctly raw.
        const rel = file.replace(ROOT + '/', '');
        offenders.push(`${rel}: raw <button> hand-writes cf-btn — use <Btn> instead\n  ${tag.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
    expect(offenders, `issue #1713 Part A drift:\n${offenders.join('\n\n')}`).toEqual([]);
  });

  test('the two role-based cf-btn buttons remain intentionally raw (killSwitch / status toggles)', () => {
    // Documents the exemption rather than just silently allowing it — if either of
    // these switches ever drops its role, the migration test above will (correctly)
    // start flagging it, and this test's own match should shrink to warn that the
    // documented exemption list has drifted from reality.
    const sites = [
      { rel: 'features/admin/AiConsoleCard.tsx', role: 'switch' },
      { rel: 'features/admin/SettingsCard.tsx', role: 'switch' },
    ];
    for (const { rel, role } of sites) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      const tags = findButtonTags(text).filter(hasCfBtnClass);
      expect(tags.length, `${rel} should still have exactly one cf-btn raw <button>`).toBeGreaterThan(0);
      expect(tags.some((t) => exemptRole(t) === role), `${rel}'s cf-btn button should carry role="${role}"`).toBe(true);
    }
  });
});
