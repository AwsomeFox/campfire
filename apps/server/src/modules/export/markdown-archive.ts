import { createHash } from 'node:crypto';
import { APP_VERSION } from '../../common/build-metadata';
import { CURRENT_SCHEMA_REVISION } from '../backup/backup-manifest';

/** Marks a zip as a Campfire human-readable campaign markdown archive (issue #863). */
export const MARKDOWN_ARCHIVE_APP = 'campfire';
export const MARKDOWN_ARCHIVE_KIND = 'campaign-markdown-archive';

/**
 * Manifest format version written into new archives. Bump when the zip layout or
 * manifest schema changes incompatibly.
 */
export const MARKDOWN_ARCHIVE_FORMAT_VERSION = 1;

/** Secrecy profile for the DM-facing markdown archive (dmSecret fields included). */
export const MARKDOWN_ARCHIVE_SECRECY_PROFILE = 'dm-full';

/** Max Unicode code points in a display stem before truncation (readability cap). */
export const ARCHIVE_STEM_MAX = 80;

/**
 * UTF-8 byte budget for the display stem. Most filesystems (ext4, APFS, NTFS) cap a
 * single path COMPONENT at 255 bytes, and archiveRecordFilename appends a
 * `__{type}-{id}.md` suffix. A code-point cap alone is unsafe: 80 emoji encode to 320
 * UTF-8 bytes, blowing past 255 before the suffix. Reserve room for the suffix so even
 * an all-multibyte stem plus its typed id stays extractable. 180 bytes leaves 75 bytes
 * for the suffix (ample for `__timeline-event-2147483647.md`).
 */
export const ARCHIVE_STEM_MAX_BYTES = 180;

const utf8ByteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Truncate to whole Unicode code points, honoring BOTH a code-point cap (readability)
 * and a UTF-8 byte budget (filesystem safety). Never splits a multi-byte code point.
 */
function truncateStem(stem: string, maxCodePoints: number, maxBytes: number): string {
  const parts: string[] = [];
  let bytes = 0;
  for (const cp of stem) {
    const cpBytes = utf8ByteLength(cp);
    if (parts.length >= maxCodePoints || bytes + cpBytes > maxBytes) break;
    parts.push(cp);
    bytes += cpBytes;
  }
  return parts.join('');
}

/**
 * Characters that are unsafe in zip entry names across common unzip tools /
 * filesystems (Windows reserved, path separators, ASCII controls).
 */
// eslint-disable-next-line no-control-regex -- intentionally match ASCII controls + DEL
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

/**
 * Preserve a human-readable Unicode display stem for archive filenames (issue #863).
 *
 * Unlike {@link slugify}, this keeps CJK / Arabic / emoji / mixed-case letters so
 * two records that only differed by case or script stay visually distinct. Path
 * separators and Windows-forbidden characters are replaced; whitespace-only names
 * and names that sanitize to empty (e.g. Windows-forbidden `?`) fall back to
 * `untitled` — other punctuation-only stems like `!!!` are kept. Collision safety
 * comes from the stable
 * record id appended by {@link archiveRecordFilename}, not from this stem.
 */
export function archiveDisplayStem(name: string): string {
  const normalized = (name ?? '').normalize('NFKC').trim();
  const cleaned = normalized
    .replace(UNSAFE_FILENAME_CHARS, '-')
    // Collapse whitespace runs to a single space so stems stay readable.
    .replace(/\s+/g, ' ')
    // Avoid leading/trailing dots and spaces (Windows strips trailing dots).
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const stem = cleaned || 'untitled';
  if ([...stem].length <= ARCHIVE_STEM_MAX && utf8ByteLength(stem) <= ARCHIVE_STEM_MAX_BYTES) return stem;
  return truncateStem(stem, ARCHIVE_STEM_MAX, ARCHIVE_STEM_MAX_BYTES).replace(/[\s.-]+$/g, '') || 'untitled';
}

/**
 * Collision-proof deterministic markdown filename: `{stem}__{type}-{id}.md`.
 * The typed id makes the path unique even when stems collide (duplicates,
 * case-only variants, or punctuation-only stems that share the same display text).
 */
export function archiveRecordFilename(
  type: string,
  id: number | string,
  name: string,
): string {
  const stem = archiveDisplayStem(name);
  return `${stem}__${type}-${id}.md`;
}

/** Stable typed id token written into markdown for cross-links (`npc:12`). */
export function typedRecordId(type: string, id: number | string): string {
  return `${type}:${id}`;
}

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export type ArchiveModuleRepresentation =
  | { kind: 'markdown-file'; path: string }
  | { kind: 'markdown-folder'; path: string }
  | { kind: 'embedded'; path: string; note?: string }
  | { kind: 'excluded'; reason: string };

export type ArchiveTruncation = {
  module: string;
  exported: number;
  note: string;
};

export type ArchiveExclusion = {
  module: string;
  reason: string;
};

export type ArchiveRecordEntry = {
  type: string;
  id: number | string;
  path: string;
  checksum: string;
};

export type MarkdownArchiveManifest = {
  app: string;
  kind: string;
  formatVersion: number;
  appVersion: string;
  schemaVersion: number;
  secrecyProfile: string;
  createdAt: string;
  campaignId: number;
  counts: Record<string, number>;
  checksums: {
    /** sha256 of the machine-readable campaign.json payload. */
    campaignJson: string;
    /**
     * sha256 (path → hex) of every archive entry EXCEPT campaign.json (covered by
     * `campaignJson`) and archive-manifest.json (cannot checksum itself). This spans
     * the human-readable markdown files, the embedded `uploads/` binaries, and
     * `warnings.txt` when present.
     */
    files: Record<string, string>;
  };
  modules: Record<string, ArchiveModuleRepresentation>;
  exclusions: ArchiveExclusion[];
  truncations: ArchiveTruncation[];
  records: ArchiveRecordEntry[];
};

/** Keys always present on the machine export object from {@link ExportService.buildExport}. */
export const MACHINE_EXPORT_MODULES = [
  'campaign',
  'quests',
  'npcs',
  'locations',
  'sessions',
  'characters',
  'notes',
  'comments',
  'members',
  'audit',
  'auditMeta',
  'auditNote',
  'aiSeat',
  'aiScribeConfig',
  'proposals',
  'encounters',
  'factions',
  'storyArcs',
  'timelineEvents',
  'timelineCalendar',
  'sessionZero',
  'inventory',
  'treasury',
  'revisions',
  'attachments',
  'attachmentsNote',
  'participantSupportNote',
] as const;

export type MachineExportModule = (typeof MACHINE_EXPORT_MODULES)[number];

/**
 * Build the versioned archive manifest (issue #863). Every machine-export module
 * must appear in `modules` as either a readable representation or an exclusion.
 */
export function buildMarkdownArchiveManifest(input: {
  campaignId: number;
  createdAt?: string;
  counts: Record<string, number>;
  campaignJson: string;
  fileChecksums: Record<string, string>;
  modules: Record<string, ArchiveModuleRepresentation>;
  exclusions?: ArchiveExclusion[];
  truncations?: ArchiveTruncation[];
  records: ArchiveRecordEntry[];
  appVersion?: string;
  schemaVersion?: number;
}): MarkdownArchiveManifest {
  const modules = input.modules;
  for (const key of MACHINE_EXPORT_MODULES) {
    if (!(key in modules)) {
      throw new Error(`markdown archive manifest missing module representation for '${key}'`);
    }
  }

  return {
    app: MARKDOWN_ARCHIVE_APP,
    kind: MARKDOWN_ARCHIVE_KIND,
    formatVersion: MARKDOWN_ARCHIVE_FORMAT_VERSION,
    appVersion: input.appVersion ?? APP_VERSION,
    schemaVersion: input.schemaVersion ?? CURRENT_SCHEMA_REVISION,
    secrecyProfile: MARKDOWN_ARCHIVE_SECRECY_PROFILE,
    createdAt: input.createdAt ?? new Date().toISOString(),
    campaignId: input.campaignId,
    counts: input.counts,
    checksums: {
      campaignJson: sha256Hex(input.campaignJson),
      files: input.fileChecksums,
    },
    modules,
    exclusions: input.exclusions ?? [],
    truncations: input.truncations ?? [],
    records: input.records,
  };
}

/**
 * Informational warning when two records share a display stem inside a folder.
 * Data is never lost (ids disambiguate paths); the note helps a human scanning
 * the folder understand why two near-identical names appear.
 */
export function stemCollisionWarnings(
  label: string,
  allocations: Array<{ stem: string; filename: string }>,
): string[] {
  const byStem = new Map<string, string[]>();
  for (const { stem, filename } of allocations) {
    const list = byStem.get(stem);
    if (list) list.push(filename);
    else byStem.set(stem, [filename]);
  }
  const warnings: string[] = [];
  for (const [stem, files] of byStem) {
    if (files.length < 2) continue;
    warnings.push(
      `${files.length} ${label}s shared the display stem '${stem}' and were exported as ${files.join(', ')}.`,
    );
  }
  return warnings;
}
