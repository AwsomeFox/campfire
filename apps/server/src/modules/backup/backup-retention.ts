/**
 * Pure retention and disk-reserve helpers for scheduled whole-server backups
 * (issue #505). BackupService owns filesystem verification/deletion; this
 * module only parses operator policy and decides which already-verified
 * archives are eligible to prune.
 */

export const DEFAULT_BACKUP_KEEP_COUNT = 14;
export const DEFAULT_BACKUP_KEEP_DAYS = 30;
export const DEFAULT_BACKUP_MIN_FREE_BYTES = 512 * 1024 * 1024; // 512 MiB
export const BACKUP_ESTIMATE_GROWTH_FACTOR = 1.15;
export const BACKUP_ESTIMATE_MIN_GROWTH_BYTES = 1024 * 1024; // 1 MiB

export interface BackupRetentionPolicy {
  /**
   * Keep at least this many newest verified, unprotected archives. `null`
   * disables count-based pruning.
   */
  keepCount: number | null;
  /** Delete verified, unprotected archives older than this many days. */
  keepDays: number | null;
  /**
   * Keep total scheduled-backup bytes under this cap by deleting oldest
   * verified, unprotected archives. `null` disables size-based pruning.
   */
  maxTotalBytes: number | null;
  /** Protect the most recent known-good archive from all retention rules. */
  protectLastGood: boolean;
}

export interface BackupRetentionCandidate {
  name: string;
  bytes: number;
  mtimeMs: number;
  /** Set only after manifest/zip/reconciliation verification by BackupService. */
  verified: boolean;
  /** A valid archive with recorded missing files; retainable but never last-known-good. */
  partial?: boolean;
  /** Archive matches the scheduler's persisted last-known-good record. */
  lastKnownGood?: boolean;
  /** Operator-pinned local archive, e.g. a marker file next to the zip. */
  pinned?: boolean;
  /** Operator-marked as having a protected offsite copy. */
  offsite?: boolean;
}

export interface BackupRetentionDecision {
  name: string;
  bytes: number;
  mtimeMs: number;
  reasons: string[];
}

export interface BackupRetentionPlan {
  keep: BackupRetentionDecision[];
  prune: BackupRetentionDecision[];
  totalBytes: number;
  prunableBytes: number;
}

export function parseBackupRetentionPolicy(
  env: NodeJS.ProcessEnv = process.env,
): BackupRetentionPolicy {
  return {
    keepCount: parseOptionalPositiveInteger(
      env.BACKUP_KEEP_COUNT,
      DEFAULT_BACKUP_KEEP_COUNT,
      'BACKUP_KEEP_COUNT',
    ),
    keepDays: parseOptionalPositiveInteger(
      env.BACKUP_KEEP_DAYS,
      DEFAULT_BACKUP_KEEP_DAYS,
      'BACKUP_KEEP_DAYS',
    ),
    maxTotalBytes: parseOptionalPositiveInteger(
      env.BACKUP_MAX_TOTAL_BYTES,
      null,
      'BACKUP_MAX_TOTAL_BYTES',
    ),
    protectLastGood: parseBoolean(env.BACKUP_PROTECT_LAST_GOOD, true),
  };
}

export function parseBackupMinFreeBytes(
  raw: string | undefined = process.env.BACKUP_MIN_FREE_BYTES,
): number {
  return parseOptionalPositiveInteger(raw, DEFAULT_BACKUP_MIN_FREE_BYTES, 'BACKUP_MIN_FREE_BYTES') ?? 0;
}

type BackupEstimateFallback = number | (() => number);

export function estimateNextBackupBytes(
  lastSize: number | null | undefined,
  fallbackBytes: BackupEstimateFallback = 0,
): number {
  const basis =
    typeof lastSize === 'number' && Number.isFinite(lastSize) && lastSize > 0
      ? lastSize
      : Math.max(0, resolveEstimateFallbackBytes(fallbackBytes));
  if (basis <= 0) return 0;
  return Math.ceil(Math.max(basis * BACKUP_ESTIMATE_GROWTH_FACTOR, basis + BACKUP_ESTIMATE_MIN_GROWTH_BYTES));
}

function resolveEstimateFallbackBytes(fallbackBytes: BackupEstimateFallback): number {
  return typeof fallbackBytes === 'function' ? fallbackBytes() : fallbackBytes;
}

export function planBackupRetention(
  candidates: BackupRetentionCandidate[],
  policy: BackupRetentionPolicy,
  nowMs: number = Date.now(),
): BackupRetentionPlan {
  const newestVerifiedName = candidates
    .filter((candidate) => candidate.verified)
    .sort(newestFirst)[0]?.name;
  const normalized = candidates
    .filter((candidate) => candidate.bytes >= 0 && Number.isFinite(candidate.bytes))
    .map((candidate) => ({
      ...candidate,
      newestVerified: candidate.verified && candidate.name === newestVerifiedName,
      protected:
        isProtected(candidate, policy) ||
        (policy.protectLastGood && candidate.verified && candidate.name === newestVerifiedName),
      reasons: [] as string[],
    }));

  const pruneNames = new Set<string>();
  const pruneReasons = new Map<string, string[]>();
  const safetyKeptNames = new Set<string>();
  const markPrune = (candidate: { name: string }, reason: string) => {
    pruneNames.add(candidate.name);
    const reasons = pruneReasons.get(candidate.name) ?? [];
    if (!reasons.includes(reason)) reasons.push(reason);
    pruneReasons.set(candidate.name, reasons);
  };

  const verified = normalized.filter((candidate) => candidate.verified).sort(newestFirst);
  const partial = normalized.filter((candidate) => candidate.partial === true).sort(newestFirst);
  const eligible = [...verified, ...partial].filter((candidate) => !candidate.protected);

  if (policy.keepCount !== null) {
    verified
      .slice(policy.keepCount)
      .filter((candidate) => !candidate.protected)
      .forEach((candidate) => markPrune(candidate, 'count'));
    partial
      .slice(policy.keepCount)
      .filter((candidate) => !candidate.protected)
      .forEach((candidate) => markPrune(candidate, 'count'));
  }

  if (policy.keepDays !== null) {
    const cutoff = nowMs - policy.keepDays * 24 * 60 * 60 * 1000;
    eligible
      .filter((candidate) => candidate.mtimeMs < cutoff)
      .forEach((candidate) => markPrune(candidate, 'age'));
  }

  if (policy.maxTotalBytes !== null) {
    let projectedBytes = normalized
      .filter((candidate) => !pruneNames.has(candidate.name))
      .reduce((sum, candidate) => sum + candidate.bytes, 0);
    for (const candidate of eligible.slice().sort(oldestFirst)) {
      if (projectedBytes <= policy.maxTotalBytes) break;
      if (!pruneNames.has(candidate.name)) {
        markPrune(candidate, 'size');
        projectedBytes -= candidate.bytes;
      }
    }
  }

  if (!allowsZeroVerifiedBackups(policy)) {
    const keptVerifiedCount = verified.filter((candidate) => !pruneNames.has(candidate.name)).length;
    if (keptVerifiedCount === 0 && verified.length > 0) {
      const safetyKept = verified[0];
      pruneNames.delete(safetyKept.name);
      pruneReasons.delete(safetyKept.name);
      safetyKeptNames.add(safetyKept.name);
    }
  }

  const keep: BackupRetentionDecision[] = [];
  const prune: BackupRetentionDecision[] = [];
  for (const candidate of normalized.sort(newestFirst)) {
    const protectedReasons = protectionReasons(candidate, policy);
    if (pruneNames.has(candidate.name)) {
      prune.push({
        name: candidate.name,
        bytes: candidate.bytes,
        mtimeMs: candidate.mtimeMs,
        reasons: pruneReasons.get(candidate.name) ?? ['policy'],
      });
    } else {
      keep.push({
        name: candidate.name,
        bytes: candidate.bytes,
        mtimeMs: candidate.mtimeMs,
        reasons:
          protectedReasons.length > 0
            ? protectedReasons
            : safetyKeptNames.has(candidate.name)
              ? ['only-verified']
            : candidate.verified
              ? ['retained']
              : ['unverified'],
      });
    }
  }

  return {
    keep,
    prune,
    totalBytes: normalized.reduce((sum, candidate) => sum + candidate.bytes, 0),
    prunableBytes: prune.reduce((sum, candidate) => sum + candidate.bytes, 0),
  };
}

function isProtected(candidate: BackupRetentionCandidate, policy: BackupRetentionPolicy): boolean {
  return (
    candidate.pinned === true ||
    candidate.offsite === true ||
    (policy.protectLastGood && candidate.lastKnownGood === true)
  );
}

function allowsZeroVerifiedBackups(policy: BackupRetentionPolicy): boolean {
  return policy.keepCount === 0 && policy.protectLastGood === false;
}

function protectionReasons(
  candidate: BackupRetentionCandidate & { newestVerified?: boolean },
  policy: BackupRetentionPolicy,
): string[] {
  const reasons: string[] = [];
  if (candidate.pinned) reasons.push('pinned');
  if (candidate.offsite) reasons.push('offsite');
  if (policy.protectLastGood && candidate.lastKnownGood) reasons.push('last-known-good');
  if (policy.protectLastGood && candidate.newestVerified) reasons.push('newest-verified');
  return reasons;
}

function newestFirst(a: { mtimeMs: number; name: string }, b: { mtimeMs: number; name: string }): number {
  const byTime = b.mtimeMs - a.mtimeMs;
  return byTime !== 0 ? byTime : b.name.localeCompare(a.name);
}

function oldestFirst(a: { mtimeMs: number; name: string }, b: { mtimeMs: number; name: string }): number {
  const byTime = a.mtimeMs - b.mtimeMs;
  return byTime !== 0 ? byTime : a.name.localeCompare(b.name);
}

function parseOptionalPositiveInteger(
  raw: string | undefined,
  fallback: number | null,
  name: string,
): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  if (parsed === 0) return null;
  // Env values can be user-controlled; cap at MAX_SAFE_INTEGER so byte math
  // stays precise enough for retention comparisons.
  if (parsed > Number.MAX_SAFE_INTEGER) return fallback;
  // Touch `name` in a single place so future logging can include the source
  // without changing call sites.
  void name;
  return parsed;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}
