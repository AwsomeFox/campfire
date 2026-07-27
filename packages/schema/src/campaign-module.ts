/**
 * Campaign modules — package identity, lineage, updates, overlays and rollback (issue #585).
 *
 * Before this, a cloned/imported campaign was an anonymous copy: no stable package id,
 * no author/license/version, no record of where it came from, and therefore no way for a
 * publisher to ship a correction that a table could merge with its own edits. A *campaign
 * module* fixes that by giving distributable content a versioned manifest plus a per-artifact
 * content hash, and by persisting — in its own tables, NOT derived from the campaign name —
 * where an installed copy came from and what it was forked from.
 *
 * The three-way update model, which is the whole point of the per-artifact hashes:
 *
 *   BASE      the artifact content as it was INSTALLED (upstream vX). Persisted at install
 *             time in campaign_module_artifacts.baseline_json / baseline_hash.
 *   LOCAL     the artifact content as it exists in the campaign RIGHT NOW, hashed live.
 *   UPSTREAM  the artifact content in the newer package (vY) being previewed.
 *
 * Without a persisted BASE you cannot tell "the table edited this" from "the publisher
 * edited this" — you only see that two blobs differ. With it, every artifact classifies
 * exactly (see {@link ModuleArtifactChange}) and a field-level merge is well defined:
 * a field upstream did not touch keeps the local value; a field the table did not touch
 * takes the upstream value; a field both changed to different values is a real conflict
 * and is surfaced rather than silently overwritten.
 *
 * Local divergence survives an update as an OVERLAY: after apply, BASE advances to the
 * upstream content and the fields where the campaign still differs from BASE are recorded
 * as the overlay patch. The next update therefore re-runs the same clean three-way compare
 * instead of accumulating drift.
 */
import { z } from 'zod';

/** Bump when the manifest wire shape changes incompatibly. */
export const MODULE_MANIFEST_FORMAT_VERSION = 1;
/** Bump when the update-plan wire shape changes incompatibly. */
export const MODULE_UPDATE_PLAN_FORMAT_VERSION = 1;

/**
 * Entity kinds a module may ship. Deliberately the four *prep* entities a published
 * adventure is made of — play state (sessions, encounters in progress, characters) is
 * the table's, never the publisher's, and is out of scope for module updates.
 */
export const ModuleArtifactKind = z.enum(['location', 'npc', 'quest', 'faction']);
export type ModuleArtifactKind = z.infer<typeof ModuleArtifactKind>;

export const ModuleAuthor = z.object({
  name: z.string().min(1).max(200),
  url: z.string().max(500).default(''),
  email: z.string().max(200).default(''),
});
export type ModuleAuthor = z.infer<typeof ModuleAuthor>;

/**
 * One artifact's identity in the manifest. `key` is the publisher-assigned stable id —
 * it is what survives install (local row ids are per-install and meaningless upstream),
 * so renaming an artifact is an edit, not a delete+add. `contentHash` is the sha256 of
 * the artifact's portable payload under the shared stable-JSON encoding.
 */
export const ModuleArtifactRef = z.object({
  kind: ModuleArtifactKind,
  key: z.string().min(1).max(160),
  name: z.string().max(200).default(''),
  contentHash: z.string().length(64),
});
export type ModuleArtifactRef = z.infer<typeof ModuleArtifactRef>;

/**
 * A dependency contract entry. `kind: 'module'` names another campaign module by UUID;
 * `kind: 'compendium-pack'` names an installed rule pack by slug (reusing the #584
 * open-license pack identity rather than inventing a second one).
 */
export const ModuleDependencyKind = z.enum(['module', 'compendium-pack']);
export type ModuleDependencyKind = z.infer<typeof ModuleDependencyKind>;

export const ModuleDependency = z.object({
  kind: ModuleDependencyKind.default('module'),
  /** Module UUID, or rule-pack slug when kind is 'compendium-pack'. */
  id: z.string().min(1).max(200),
  name: z.string().max(200).default(''),
  /** Semver range (see @campfire/schema semver helpers). '*' accepts anything. */
  versionRange: z.string().min(1).max(120).default('*'),
  optional: z.boolean().default(false),
});
export type ModuleDependency = z.infer<typeof ModuleDependency>;

export const ModuleCompatibility = z.object({
  /** Semver range over the Campfire app version. '*' = any. */
  campfire: z.string().min(1).max(120).default('*'),
  /** Rule-pack slugs this module is written for; empty = system-agnostic. */
  ruleSystems: z.array(z.string().max(80)).default([]),
});
export type ModuleCompatibility = z.infer<typeof ModuleCompatibility>;

/**
 * The versioned module manifest. `moduleId` is the package identity: a UUID that is stable
 * across installs, campaign renames, and republishes, and is what an update is matched on.
 */
export const ModuleManifest = z.object({
  app: z.literal('campfire').default('campfire'),
  kind: z.literal('campaign-module-manifest').default('campaign-module-manifest'),
  formatVersion: z.number().int().positive().default(MODULE_MANIFEST_FORMAT_VERSION),
  moduleId: z.string().uuid(),
  name: z.string().min(1).max(200),
  /** Strict semver — validated on install; a non-semver version is rejected. */
  version: z.string().min(1).max(80),
  description: z.string().max(4000).default(''),
  authors: z.array(ModuleAuthor).max(50).default([]),
  license: z.string().max(160).default(''),
  /** Where this package came from — the install origin, persisted independently of the campaign name. */
  sourceUrl: z.string().max(500).default(''),
  compatibility: ModuleCompatibility.default({ campfire: '*', ruleSystems: [] }),
  dependencies: z.array(ModuleDependency).max(100).default([]),
  artifacts: z.array(ModuleArtifactRef).max(5000).default([]),
  publishedAt: z.string().max(64).default(''),
});
export type ModuleManifest = z.infer<typeof ModuleManifest>;

/**
 * One artifact's payload. `data` is intentionally a loose object: the server projects it
 * through a per-kind portable-field whitelist before hashing or writing, so unknown keys
 * are dropped rather than trusted (they can never smuggle in server-local ids).
 */
export const ModuleArtifactContent = z.object({
  kind: ModuleArtifactKind,
  key: z.string().min(1).max(160),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type ModuleArtifactContent = z.infer<typeof ModuleArtifactContent>;

/** A complete installable/updatable package: manifest + the artifact payloads it names. */
export const ModulePackage = z.object({
  manifest: ModuleManifest,
  artifacts: z.array(ModuleArtifactContent).max(5000).default([]),
});
export type ModulePackage = z.infer<typeof ModulePackage>;

// ---------- lineage ----------

/** How this install came to exist. A fork keeps its parent's identity as lineage, not as its own id. */
export const ModuleOriginKind = z.enum(['install', 'fork']);
export type ModuleOriginKind = z.infer<typeof ModuleOriginKind>;

/**
 * Persisted lineage for one installed module. Every field here lives in its own column —
 * renaming the campaign, or the module, cannot sever any of it.
 */
export const ModuleLineage = z.object({
  originKind: ModuleOriginKind,
  /** URL the package was installed from, captured at install time. '' when installed from an upload. */
  originSourceUrl: z.string().max(500).default(''),
  /** For a fork: the upstream module UUID it descends from. null for a plain install. */
  upstreamModuleId: z.string().max(80).nullable().default(null),
  /** For a fork: the upstream version at the moment of forking. */
  upstreamVersion: z.string().max(80).nullable().default(null),
  forkedAt: z.string().max(64).nullable().default(null),
  /** True once the table permanently severs upstream updates. Lineage is retained as history. */
  detached: z.boolean().default(false),
  detachedAt: z.string().max(64).nullable().default(null),
});
export type ModuleLineage = z.infer<typeof ModuleLineage>;

/** An installed module as read back over the API. */
export const ModuleInstall = z.object({
  id: z.number().int().positive(),
  campaignId: z.number().int().positive(),
  moduleId: z.string().max(80),
  name: z.string().max(200),
  version: z.string().max(80),
  description: z.string().max(4000),
  license: z.string().max(160),
  sourceUrl: z.string().max(500),
  authors: z.array(ModuleAuthor),
  compatibility: ModuleCompatibility,
  dependencies: z.array(ModuleDependency),
  lineage: ModuleLineage,
  artifactCount: z.number().int().nonnegative(),
  /** Artifacts whose current content differs from the installed baseline. */
  locallyEditedCount: z.number().int().nonnegative(),
  /** Artifacts carrying an overlay patch retained across a previous update. */
  overlayCount: z.number().int().nonnegative(),
  installedAt: z.string(),
  updatedAt: z.string(),
  /** Set when a previous update can still be rolled back. */
  rollbackAvailable: z.boolean(),
});
export type ModuleInstall = z.infer<typeof ModuleInstall>;

// ---------- update preview (three-way) ----------

/**
 * Per-artifact classification of an update, derived from BASE/LOCAL/UPSTREAM hashes.
 *
 *  - `unchanged`         local == base == upstream. Nothing to do.
 *  - `upstream_changed`  local == base, upstream differs. Safe to apply verbatim.
 *  - `locally_edited`    upstream == base, local differs. The table's edit stands; skip.
 *  - `both_changed`      all three differ but no single field collides — merges cleanly.
 *  - `conflict`          all three differ AND at least one field was changed to different
 *                        values on both sides. Requires a resolution; never auto-overwritten.
 *  - `deleted_upstream`  in base, absent from the new package.
 *  - `added_upstream`    in the new package, absent from base.
 *  - `deleted_locally`   in base and upstream, but the campaign row is gone/trashed.
 */
export const ModuleArtifactChange = z.enum([
  'unchanged',
  'upstream_changed',
  'locally_edited',
  'both_changed',
  'conflict',
  'deleted_upstream',
  'added_upstream',
  'deleted_locally',
]);
export type ModuleArtifactChange = z.infer<typeof ModuleArtifactChange>;

/** What applying the plan would actually do to this artifact under the chosen resolution. */
export const ModuleArtifactAction = z.enum([
  'none',
  'update',
  'merge',
  'keep_local',
  'create',
  'delete',
  'needs_resolution',
]);
export type ModuleArtifactAction = z.infer<typeof ModuleArtifactAction>;

/** How unresolved conflicts are handled by apply. Default 'skip' — never silently overwrite. */
export const ModuleConflictPolicy = z.enum(['skip', 'upstream', 'local']);
export type ModuleConflictPolicy = z.infer<typeof ModuleConflictPolicy>;

/** What apply does with artifacts the publisher removed. Default 'keep' for locally edited ones. */
export const ModuleDeletePolicy = z.enum(['keep', 'delete']);
export type ModuleDeletePolicy = z.infer<typeof ModuleDeletePolicy>;

export const ModuleFieldChange = z.object({
  field: z.string().max(120),
  base: z.unknown().optional(),
  local: z.unknown().optional(),
  upstream: z.unknown().optional(),
  /** True when base/local/upstream all differ — the field cannot be merged automatically. */
  conflict: z.boolean(),
});
export type ModuleFieldChange = z.infer<typeof ModuleFieldChange>;

export const ModuleUpdateArtifactPlan = z.object({
  kind: ModuleArtifactKind,
  key: z.string().max(160),
  name: z.string().max(200),
  change: ModuleArtifactChange,
  action: ModuleArtifactAction,
  /** The campaign row this artifact is bound to, or null (added upstream / deleted locally). */
  entityId: z.number().int().positive().nullable(),
  baselineHash: z.string().nullable(),
  localHash: z.string().nullable(),
  upstreamHash: z.string().nullable(),
  /** Fields that differ on either side; `conflict: true` marks the ones that collide. */
  fields: z.array(ModuleFieldChange).default([]),
  /** Field names that collide — the shortlist a DM has to decide on. */
  conflictFields: z.array(z.string().max(120)).default([]),
});
export type ModuleUpdateArtifactPlan = z.infer<typeof ModuleUpdateArtifactPlan>;

export const ModuleDependencyStatus = z.enum([
  'satisfied',
  'missing',
  'version_mismatch',
  'unparseable_range',
]);
export type ModuleDependencyStatus = z.infer<typeof ModuleDependencyStatus>;

export const ModuleDependencyCheck = z.object({
  kind: ModuleDependencyKind,
  id: z.string().max(200),
  name: z.string().max(200),
  versionRange: z.string().max(120),
  optional: z.boolean(),
  status: ModuleDependencyStatus,
  installedVersion: z.string().max(80).nullable(),
  /** True when this dependency entry is new or changed relative to the installed manifest. */
  changed: z.boolean(),
});
export type ModuleDependencyCheck = z.infer<typeof ModuleDependencyCheck>;

export const ModuleCompatibilityCheck = z.object({
  compatible: z.boolean(),
  appVersion: z.string().max(80),
  campfireRange: z.string().max(120),
  ruleSystem: z.string().max(80),
  ruleSystems: z.array(z.string().max(80)),
  issues: z.array(z.string().max(400)).default([]),
});
export type ModuleCompatibilityCheck = z.infer<typeof ModuleCompatibilityCheck>;

/** A blocking or advisory finding on the plan. */
export const ModulePlanWarning = z.object({
  code: z.string().max(80),
  message: z.string().max(500),
  blocking: z.boolean().default(false),
});
export type ModulePlanWarning = z.infer<typeof ModulePlanWarning>;

/**
 * The dry-run result: everything apply would do, computed without mutating anything.
 * `POST …/update/preview` returns exactly this, and `POST …/update` returns it again
 * (post-apply) so the caller can see what actually happened.
 */
export const ModuleUpdatePlan = z.object({
  app: z.literal('campfire').default('campfire'),
  kind: z.literal('campaign-module-update-plan').default('campaign-module-update-plan'),
  formatVersion: z.number().int().positive().default(MODULE_UPDATE_PLAN_FORMAT_VERSION),
  campaignId: z.number().int().positive(),
  campaignName: z.string().max(200),
  installId: z.number().int().positive(),
  moduleId: z.string().max(80),
  moduleName: z.string().max(200),
  fromVersion: z.string().max(80),
  toVersion: z.string().max(80),
  versionChange: z.enum(['upgrade', 'downgrade', 'same', 'unknown']),
  compatibility: ModuleCompatibilityCheck,
  dependencies: z.array(ModuleDependencyCheck).default([]),
  artifacts: z.array(ModuleUpdateArtifactPlan).default([]),
  /** Count per {@link ModuleArtifactChange} value. */
  counts: z.record(z.string(), z.number().int().nonnegative()),
  conflictCount: z.number().int().nonnegative(),
  warnings: z.array(ModulePlanWarning).default([]),
  /** False when a blocking warning is present (detached install, id mismatch, bad dependency). */
  canApply: z.boolean(),
  createdAt: z.string(),
});
export type ModuleUpdatePlan = z.infer<typeof ModuleUpdatePlan>;

// ---------- request bodies ----------

export const ModuleInstallRequest = z.object({
  package: ModulePackage,
  /** Overrides manifest.sourceUrl as the recorded install origin (e.g. the registry URL fetched). */
  originSourceUrl: z.string().max(500).optional(),
});
export type ModuleInstallRequest = z.infer<typeof ModuleInstallRequest>;

/** Per-artifact conflict resolution, keyed by `<kind>:<key>`. */
export const ModuleResolution = z.enum(['upstream', 'local', 'merge', 'skip']);
export type ModuleResolution = z.infer<typeof ModuleResolution>;

export const ModuleUpdateRequest = z.object({
  package: ModulePackage,
  /** Default handling for artifacts classed `conflict`. 'skip' keeps local and re-previews later. */
  onConflict: ModuleConflictPolicy.default('skip'),
  /** What to do with artifacts the publisher removed AND the table never edited. */
  onUpstreamDelete: ModuleDeletePolicy.default('delete'),
  /** Explicit per-artifact overrides, keyed `<kind>:<key>` (e.g. "npc:vex"). */
  resolutions: z.record(z.string(), ModuleResolution).default({}),
  /** Preview only — validate and return the plan without writing. Equivalent to the preview route. */
  dryRun: z.boolean().default(false),
});
export type ModuleUpdateRequest = z.infer<typeof ModuleUpdateRequest>;

export const ModuleForkRequest = z.object({
  /** Name for the forked module; defaults to "<name> (fork)". */
  name: z.string().min(1).max(200).optional(),
  /** Starting version for the fork; defaults to the current version. Must be semver. */
  version: z.string().min(1).max(80).optional(),
});
export type ModuleForkRequest = z.infer<typeof ModuleForkRequest>;

/** Bulk dry run: preview one package against every selected table (campaign). */
export const ModuleBulkPreviewRequest = z.object({
  package: ModulePackage,
  campaignIds: z.array(z.number().int().positive()).min(1).max(200),
});
export type ModuleBulkPreviewRequest = z.infer<typeof ModuleBulkPreviewRequest>;

export const ModuleBulkPreviewSkip = z.object({
  campaignId: z.number().int().positive(),
  campaignName: z.string().max(200).default(''),
  code: z.enum(['not_installed', 'forbidden', 'not_found', 'detached']),
  message: z.string().max(300),
});
export type ModuleBulkPreviewSkip = z.infer<typeof ModuleBulkPreviewSkip>;

export const ModuleBulkPreview = z.object({
  app: z.literal('campfire').default('campfire'),
  kind: z.literal('campaign-module-bulk-update-preview').default('campaign-module-bulk-update-preview'),
  formatVersion: z.number().int().positive().default(MODULE_UPDATE_PLAN_FORMAT_VERSION),
  moduleId: z.string().max(80),
  toVersion: z.string().max(80),
  plans: z.array(ModuleUpdatePlan).default([]),
  skipped: z.array(ModuleBulkPreviewSkip).default([]),
  /** Tables where the plan applies cleanly with no conflicts. */
  cleanCount: z.number().int().nonnegative(),
  /** Tables with at least one conflicting artifact. */
  conflictedCount: z.number().int().nonnegative(),
  blockedCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type ModuleBulkPreview = z.infer<typeof ModuleBulkPreview>;

/**
 * One artifact's retained local divergence. `overlay` holds only the fields where the
 * campaign differs from the installed baseline; `effective` is the baseline with the
 * overlay applied — i.e. what the table actually has. This is what "local edits are
 * preserved as overlays" looks like from the outside: an inspectable patch, not a guess.
 */
export const ModuleOverlayEntry = z.object({
  kind: ModuleArtifactKind,
  key: z.string().max(160),
  name: z.string().max(200),
  entityId: z.number().int().positive().nullable(),
  /** Baseline version this overlay is expressed against. */
  baselineVersion: z.string().max(80),
  baseline: z.record(z.string(), z.unknown()),
  overlay: z.record(z.string(), z.unknown()),
  effective: z.record(z.string(), z.unknown()),
  fields: z.array(z.string().max(120)),
});
export type ModuleOverlayEntry = z.infer<typeof ModuleOverlayEntry>;

/** One restorable point, written before every apply. */
export const ModuleSnapshot = z.object({
  id: z.number().int().positive(),
  installId: z.number().int().positive(),
  reason: z.enum(['install', 'update', 'fork']),
  fromVersion: z.string().max(80),
  toVersion: z.string().max(80),
  artifactCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  createdBy: z.string().max(120),
  rolledBackAt: z.string().nullable(),
});
export type ModuleSnapshot = z.infer<typeof ModuleSnapshot>;

export const ModuleRollbackResult = z.object({
  install: ModuleInstall,
  snapshot: ModuleSnapshot,
  restoredCount: z.number().int().nonnegative(),
  recreatedCount: z.number().int().nonnegative(),
  removedCount: z.number().int().nonnegative(),
});
export type ModuleRollbackResult = z.infer<typeof ModuleRollbackResult>;

export const ModuleUpdateResult = z.object({
  install: ModuleInstall,
  plan: ModuleUpdatePlan,
  applied: z.boolean(),
  updatedCount: z.number().int().nonnegative(),
  createdCount: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  keptLocalCount: z.number().int().nonnegative(),
  overlayCount: z.number().int().nonnegative(),
  unresolvedConflictCount: z.number().int().nonnegative(),
  snapshotId: z.number().int().positive().nullable(),
});
export type ModuleUpdateResult = z.infer<typeof ModuleUpdateResult>;
