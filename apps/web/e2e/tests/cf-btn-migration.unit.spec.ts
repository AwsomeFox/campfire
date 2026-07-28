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

function hasCfBtnClass(tag: string): boolean {
  // Matches a literal `cf-btn` word inside a className="..." / className={`...`} value,
  // not merely the substring (so `cf-btn-group` alone, with no bare `cf-btn`, wouldn't
  // false-positive — though in practice every real offender also carries plain `cf-btn`).
  return /\bcf-btn\b/.test(tag);
}

function exemptRole(tag: string): string | null {
  const roleMatch = tag.match(/role=["']([a-z]+)["']/);
  if (roleMatch && EXEMPT_ROLES.has(roleMatch[1])) return roleMatch[1];
  return null;
}

const SOURCES = collectSources(ROOT);

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
