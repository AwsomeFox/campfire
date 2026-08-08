// Generates the design-system entry that apps/web doesn't ship.
//
// Campfire's UI lives inside a private Vite app, not a component library: there
// is no dist/, no barrel, and tsconfig sets noEmit, so the converter has no
// .d.ts tree to discover components from. This script produces the three inputs
// the converter needs, all derived from the real app source:
//
//   apps/web/.ds-entry.tsx     the bundle entry (re-exports only, gitignored)
//   .design-sync/groups/*.md   category frontmatter -> the DS pane's grouping
//   .design-sync/config.json   componentSrcMap (the authoritative component list)
//
// The entry MUST live under apps/web: package-build.mjs derives PKG_DIR by
// walking up from --entry to the package.json whose name matches cfg.pkg.
//
// Re-run after adding or renaming a component:
//   node .design-sync/gen-entry.mjs

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'apps/web');
const SRC = join(WEB, 'src');

// Providers and context plumbing — real exports, but not cards. RollResultToastProvider
// stays OUT of the component list yet IN the bundle, so it can serve as cfg.provider.
const NOT_A_CARD = new Set([
  'AnnounceProvider', 'KeyboardCommandProvider', 'RollResultToastContext', 'PrintOnly',
]);
const BUNDLE_ONLY = new Set(['RollResultToastProvider']);

// features/ is scoped deliberately: presentational, reusable pieces only. Route
// components, admin data cards, and wizards are app screens, not design system.
const FEATURE_ALLOW = {
  characters: 'CharacterCompletionBanner CharacterDetailLoadingSkeleton CharacterSheetNav CharacterTrashMenu PartyRestPanel RollModeChooser StatusTag NewCharacterForm',
  dice: 'DiceTray RolledDice RolledTerms',
  dashboard: 'DiceWidget InstallHintBanner OfflinePackBanner CatchUpPanel',
  'ai-dm': 'AiModeBadge CostDisclosure AiDmPresenceTag DraftWithAiButton',
  admin: 'ActorRoleBadge',
  encounters: 'CombatLog DmLifecycleHeader MonsterHpDisplayControl FloatingNumbers EncounterWhisperComposer GridOverlay',
  notes: 'EntityPicker', comments: 'EntityDiscussion', safety: 'SafetyControlsCard',
  storylines: 'StorylineContentEditor', proposals: 'ProposalPayloadEditor', compendium: 'CampaignLibraryCard',
};

const GROUPS = {
  Primitives: 'Btn Card Chip Dialog TextInput TextArea EmptyState ErrorNote Inset DmPanel Skeleton SkeletonInline SkeletonRoute SkeletonCard SkeletonConditionalRegion VirtualList Toggle GatedControl CopyControl PrintControl',
  Forms: 'Field LabeledField AudienceField PasswordInput IconPicker ImageUpload MarkdownEditor CampaignMetadataFields RequiredMarker OptionalMarker MapPurposePicker MapUploadButton NewCharacterForm ProposalPayloadEditor StorylineContentEditor EntityPicker',
  Navigation: 'PageHeader PageTitle ListDetailLink DetailPageWayfinding NotFoundState GlobalSearchPalette CharacterSheetNav StatusMenuButton QuickCaptureDialog',
  Entities: 'EntityCard CampaignCover CampaignLibraryCard EntitySecrecyControls EntityRevealDialog VisibleToPlayersBar EncounterBacklinksCard NotesRail RevisionHistoryPanel EntityDiscussion LocationStatusLabel',
  Badges: 'QuestStatusBadge NpcDispositionBadge ActorRoleBadge StatusTag AiModeBadge AiDmPresenceTag',
  Character: 'CharacterStatCard StatBlock CharacterCompletionBanner CharacterDetailLoadingSkeleton CharacterTrashMenu PartyRestPanel',
  Dice: 'DiceTray RolledDice RolledTerms DiceRollOverlay DiceWidget RollContextMenu RollModeChooser RollResultBanner RollResultToast',
  Encounter: 'CombatLog HpBar MonsterHpDisplayControl FloatingNumbers GridOverlay DmLifecycleHeader EncounterWhisperComposer DmPrivacyGroup',
  Feedback: 'SaveFeedback UndoSnackbar StaleWriteConflict PwaUpdateBanner RestoreDraftBanner InstallHintBanner OfflinePackBanner CatchUpPanel ConfirmDialog ConfirmDestructiveDialog UnsavedFormDialog ShortcutHelpDialog',
  Icons: 'GameIcon UIIcon BrandMark',
  AI: 'AiProviderPrivacyNotice CostDisclosure DraftWithAiButton GenerateMapPanel GetAMapPanel ExternalGeneratorCard MapConceptGlossary MapPurposePreview MapReplaceDialog',
  Safety: 'SafetyHoldBar SafetyControlsCard SafetyHoldDisplayOverlay SafetyHoldOverlayView',
  Content: 'Markdown TermHelp RulesHintPopover',
};
const GROUP_OF = {};
for (const [g, names] of Object.entries(GROUPS)) for (const n of names.split(' ')) GROUP_OF[n] = g;

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  return e.isDirectory() ? walk(p) : p.endsWith('.tsx') && !/\.(test|spec|stories)\./.test(p) ? [p] : [];
});

// PascalCase value exports only; rejects SCREAMING_SNAKE constants, which the
// converter would refuse anyway (componentSrcMap keys must be [A-Z][A-Za-z0-9]*).
function exportsOf(file) {
  const t = readFileSync(file, 'utf8');
  const names = new Set();
  for (const rx of [/^export function ([A-Z]\w+)/gm, /^export const ([A-Z]\w+)\s*[:=]/gm]) {
    for (const m of t.matchAll(rx)) names.add(m[1]);
  }
  return [...names].filter((n) => /^[A-Z][A-Za-z0-9]*$/.test(n) && n !== n.toUpperCase());
}

const picked = new Map();
const add = (name, file) => {
  if (NOT_A_CARD.has(name) || BUNDLE_ONLY.has(name) || picked.has(name)) return;
  picked.set(name, relative(WEB, file).split('\\').join('/'));
};

for (const f of walk(join(SRC, 'components')).sort()) for (const n of exportsOf(f).sort()) add(n, f);
for (const [feat, allow] of Object.entries(FEATURE_ALLOW)) {
  const dir = join(SRC, 'features', feat);
  if (!existsSync(dir)) { console.error(`! feature dir missing: ${feat}`); continue; }
  const want = new Set(allow.split(' '));
  const found = new Set();
  for (const f of walk(dir).sort()) for (const n of exportsOf(f).sort()) if (want.has(n)) { add(n, f); found.add(n); }
  const missing = [...want].filter((n) => !found.has(n));
  if (missing.length) console.error(`! ${feat}: not found ${missing.join(', ')}`);
}

// ── entry barrel (bundle contents = cards + bundle-only providers)
const byFile = new Map();
for (const [n, rel] of [...picked].sort()) {
  if (!byFile.has(rel)) byFile.set(rel, []);
  byFile.get(rel).push(n);
}
for (const n of BUNDLE_ONLY) {
  for (const f of walk(SRC)) {
    if (exportsOf(f).includes(n)) {
      const rel = relative(WEB, f).split('\\').join('/');
      if (!byFile.has(rel)) byFile.set(rel, []);
      if (!byFile.get(rel).includes(n)) byFile.get(rel).push(n);
      break;
    }
  }
}
const lines = [
  '// GENERATED by .design-sync/gen-entry.mjs — do not edit. Re-exports only.',
  '// The design-system entry apps/web does not ship; see .design-sync/NOTES.md.',
  '',
  "// Preview harness (cfg.provider), not a card — see .design-sync/preview-surface.tsx.",
  "export { DsPreviewSurface } from '../../.design-sync/preview-surface';",
  '',
];
for (const [rel, names] of [...byFile].sort()) {
  lines.push(`export { ${[...names].sort().join(', ')} } from './${rel.replace(/\.tsx$/, '')}';`);
}
writeFileSync(join(WEB, '.ds-entry.tsx'), lines.join('\n') + '\n');

// ── group stubs. Frontmatter-only: the body is empty, so emit.mjs still
// synthesizes the full .prompt.md from props + JSDoc and only takes the category.
const gdir = join(ROOT, '.design-sync/groups');
rmSync(gdir, { recursive: true, force: true });
mkdirSync(gdir, { recursive: true });
for (const n of picked.keys()) {
  writeFileSync(join(gdir, `${n}.md`), `---\ncategory: ${GROUP_OF[n] ?? 'Components'}\n---\n`);
}

// ── i18n catalog for previews (gitignored, regenerated here).
// The app's own src/i18n module builds its catalog with Vite's
// `import.meta.glob`, which esbuild cannot evaluate — importing it made every
// preview die with "import_meta.glob is not a function". These are plain JSON
// files, so a static re-export gives previews the app's REAL English copy
// instead of raw translation keys. Generated from the directory listing so a
// new domain file is picked up automatically.
const enDir = join(SRC, 'i18n/locales/en');
const catalogs = readdirSync(enDir).filter((f) => f.endsWith('.json')).sort();
const ident = (f) => 'c_' + f.replace(/\.json$/, '').replace(/[^A-Za-z0-9]/g, '_');
writeFileSync(
  join(WEB, '.ds-i18n.ts'),
  '// GENERATED by .design-sync/gen-entry.mjs — do not edit.\n' +
    catalogs.map((f) => `import ${ident(f)} from './src/i18n/locales/en/${f}';`).join('\n') +
    `\n\n// Each file is { "<domain>": { ... } } with a unique top-level key, so a\n` +
    `// shallow merge is a clean union — mirrors loadCatalog() in src/i18n/index.ts.\n` +
    `export const enCatalog = Object.assign({}, ${catalogs.map(ident).join(', ')});\n`,
);

// ── types shim. lib/dts.mjs resolves the package's .d.ts entry as
// `pkgJson.types ?? 'index.d.ts'`; apps/web declares no `types`, so dropping
// this file in makes the emitted tree discoverable without touching the app's
// package.json. Without it every <Name>Props degrades to an index signature.
writeFileSync(
  join(WEB, 'index.d.ts'),
  '// GENERATED by .design-sync/gen-entry.mjs — types entry for the converter.\n' +
    "// Emit the tree first: npx tsc -p .design-sync/tsconfig.dts.json\n" +
    "export * from './.ds-types/apps/web/.ds-entry';\n",
);

// ── componentSrcMap into the existing config, preserving every other key.
// Bundle-only exports need explicit `null` now that a real .d.ts tree exists:
// they ARE exported from the barrel, so discovery would otherwise card them.
const cfgPath = join(ROOT, '.design-sync/config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
cfg.componentSrcMap = {
  ...Object.fromEntries([...picked].sort()),
  ...Object.fromEntries([...BUNDLE_ONLY, 'DsPreviewSurface'].map((n) => [n, null])),
};
writeFileSync(cfgPath, JSON.stringify(cfg, null, 1) + '\n');

const counts = {};
for (const n of picked.keys()) counts[GROUP_OF[n] ?? 'Components'] = (counts[GROUP_OF[n] ?? 'Components'] ?? 0) + 1;
console.error(`${picked.size} components from ${byFile.size} files`);
console.error(Object.entries(counts).sort().map(([g, c]) => `${g}:${c}`).join('  '));
const ungrouped = [...picked.keys()].filter((n) => !GROUP_OF[n]);
if (ungrouped.length) console.error(`ungrouped -> Components: ${ungrouped.join(', ')}`);
