/**
 * Issue #600 — the charter versioning rules, as pure functions.
 *
 * Two questions decide the whole feature, and both live here so they can be reasoned
 * about and tested without a database, a Nest app, or a campaign:
 *
 *   1. Does this new version invalidate the consent people already gave?
 *   2. Given who has answered what, which version is the table actually operating under?
 *
 * They are separated from the service on purpose. "Material change" is a policy decision
 * that a reviewer must be able to read in one screen and disagree with concretely; buried
 * inside a service method it would be a behaviour nobody could find.
 */
import type {
  CharterAcknowledgmentState,
  CharterVersionDiff,
  SessionZeroCharterVersion,
} from '@campfire/schema';

/** The five authored fields a charter version carries. */
export type CharterFields = {
  lines: string[];
  veils: string[];
  safetyTools: string[];
  houseRules: string;
  toneAndExpectations: string;
};

/**
 * Normalize one protective entry for comparison.
 *
 * Trimmed and case-folded, so re-casing or re-spacing a line is NOT treated as
 * withdrawing it and re-adding a different one. Without this, a DM fixing a typo in
 * "no Harm to children" would force the entire table to re-acknowledge — and a consent
 * prompt that fires on typos is a consent prompt people learn to dismiss unread.
 */
function normalize(entry: string): string {
  return entry.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizedSet(entries: string[]): Set<string> {
  return new Set(entries.map(normalize).filter((e) => e !== ''));
}

/** Entries present in `before` but absent from `after`, in their original form. */
function removedEntries(before: string[], after: string[]): string[] {
  const keep = normalizedSet(after);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of before) {
    const key = normalize(entry);
    if (key === '' || keep.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * THE DEFINITION: a change is MATERIAL exactly when it withdraws a protection.
 *
 * Concretely — material iff any entry disappears from `lines`, `veils`, or
 * `safetyTools`. Everything else is not.
 *
 * The reasoning, because this is the rule the whole consent gate rests on:
 *
 *  - REMOVALS are material. A participant agreed to play at a table where a subject was
 *    off-limits. Taking that limit away is the one change that can make their existing
 *    agreement false, so it must not carry forward silently.
 *  - ADDITIONS are not. A version that only adds a line is strictly MORE protective than
 *    the one they already accepted; nobody is worse off, and forcing re-acknowledgment
 *    would train people to click through safety prompts — which costs more safety than
 *    the prompt buys.
 *  - EDITS are treated as a removal plus an addition, and therefore as material. That is
 *    the conservative direction and it is deliberate: "no on-screen violence" edited to
 *    "no graphic on-screen violence" reads like a tidy-up and is actually a loosening,
 *    and no cheap textual comparison can reliably tell those apart. Case and whitespace
 *    are normalized away first (see `normalize`) so genuine typo fixes do not trip it.
 *  - HOUSE RULES and TONE are not material at any size. They are table-craft prose, not
 *    the content boundary somebody consented to; their changes are surfaced in the diff
 *    and notified, but they do not invalidate an acknowledgment. A DM must be able to
 *    fix a wording without stopping play for the whole table.
 *
 * Note what this deliberately does NOT do: it never treats "more restrictive" as needing
 * consent, and it never asks the DM to self-declare whether their change was material.
 * A self-declared flag is the version of this feature that quietly does nothing.
 */
export function isMaterialCharterChange(before: CharterFields, after: CharterFields): boolean {
  return (
    removedEntries(before.lines, after.lines).length > 0 ||
    removedEntries(before.veils, after.veils).length > 0 ||
    removedEntries(before.safetyTools, after.safetyTools).length > 0
  );
}

/** Field-by-field difference between two versions, for the reader and the notification. */
export function diffCharters(
  before: CharterFields,
  after: CharterFields,
  fromVersion: number,
  toVersion: number,
): CharterVersionDiff {
  return {
    fromVersion,
    toVersion,
    material: isMaterialCharterChange(before, after),
    addedLines: removedEntries(after.lines, before.lines),
    removedLines: removedEntries(before.lines, after.lines),
    addedVeils: removedEntries(after.veils, before.veils),
    removedVeils: removedEntries(before.veils, after.veils),
    addedSafetyTools: removedEntries(after.safetyTools, before.safetyTools),
    removedSafetyTools: removedEntries(before.safetyTools, after.safetyTools),
    houseRulesChanged: before.houseRules.trim() !== after.houseRules.trim(),
    toneChanged: before.toneAndExpectations.trim() !== after.toneAndExpectations.trim(),
  };
}

/** True when a published version is identical in substance to what came before. */
export function charterUnchanged(before: CharterFields, after: CharterFields): boolean {
  const d = diffCharters(before, after, 0, 1);
  return (
    d.addedLines.length === 0 &&
    d.removedLines.length === 0 &&
    d.addedVeils.length === 0 &&
    d.removedVeils.length === 0 &&
    d.addedSafetyTools.length === 0 &&
    d.removedSafetyTools.length === 0 &&
    !d.houseRulesChanged &&
    !d.toneChanged
  );
}

/** The empty charter a campaign implicitly has before its first publish. */
export const EMPTY_CHARTER: CharterFields = {
  lines: [],
  veils: [],
  safetyTools: [],
  houseRules: '',
  toneAndExpectations: '',
};

/** Who must answer, and what each of them said about a given version. */
export type AckLookup = (versionId: number) => Map<string, CharterAcknowledgmentState>;

/**
 * True when `userId` has agreed to `version` — either by acknowledging that version
 * directly, or by acknowledging any LATER version.
 *
 * Agreeing to version N means agreeing to that charter text, which already contains
 * every earlier version's content (and every material change between). Join and renew
 * flows only record an acknowledgment against the latest version the person is looking
 * at; without this covering rule, a new player who joins a multi-version table and acks
 * the newest charter would leave every earlier gated version "unacknowledged" for them,
 * collapsing the table's effective version back to null and unbounding the AI from the
 * charter the rest of the table already agreed to.
 */
export function hasAcknowledgedThrough(
  userId: string,
  version: SessionZeroCharterVersion,
  versions: SessionZeroCharterVersion[],
  acksFor: AckLookup,
): boolean {
  for (const candidate of versions) {
    if (candidate.version < version.version) continue;
    if (acksFor(candidate.id).get(userId) === 'acknowledged') return true;
  }
  return false;
}

/**
 * THE OTHER DEFINITION: which version is the table actually operating under.
 *
 * Walks versions oldest-first and stops at the first MATERIAL version that has not been
 * acknowledged by everyone required. The effective version is the last one before that
 * stop.
 *
 * Why walking, rather than just checking the newest version:
 *
 *  - Materiality is TRANSITIVE. If v3 removed a line and nobody has re-acknowledged it,
 *    then v4 — however innocuous v4's own diff looks — still contains v3's removal.
 *    Checking only "was the newest version material?" would let a DM launder a withdrawn
 *    protection through one cosmetic follow-up publish. Walking forward closes that.
 *  - NON-MATERIAL versions pass through without acknowledgment, which is what makes the
 *    additions-are-free rule actually free. A table that keeps adding lines never has to
 *    stop and re-consent.
 *
 * Returns `null` when even the first version is unacknowledged — a campaign whose opening
 * charter nobody has agreed to yet has no effective version, and callers treat that as
 * "not licensed for live AI or play". The first publish is stored with `material: false`
 * (nothing was withdrawn from a prior version), but consent is still required before it
 * becomes effective; only subsequent non-material versions may pass through without it.
 *
 * An acknowledgment of version N covers every earlier gated version for that participant
 * (see `hasAcknowledgedThrough`). That is what lets a new player join an already-consented
 * table by agreeing to the current charter without regressing the table's effective version.
 *
 * `required` is the set of participants whose agreement counts. `discuss` and `declined`
 * both fail to clear the gate: a participant who wants to talk about a line before
 * agreeing has not agreed, and quietly counting them as consenting is the precise failure
 * this feature exists to prevent.
 */
export function resolveEffectiveVersion(
  versions: SessionZeroCharterVersion[],
  required: string[],
  acksFor: AckLookup,
): SessionZeroCharterVersion | null {
  const ascending = [...versions].sort((a, b) => a.version - b.version);
  let effective: SessionZeroCharterVersion | null = null;

  for (const version of ascending) {
    const needsAcknowledgment = effective === null || version.material;
    if (needsAcknowledgment && !isFullyAcknowledged(version, required, ascending, acksFor)) {
      // Stop here: this version, and therefore everything built on top of it, is not
      // consented to. Whatever we had before it remains what the table is playing under.
      break;
    }
    effective = version;
  }
  return effective;
}

/** True when every required participant has cleared the gate for `version`. */
export function isFullyAcknowledged(
  version: SessionZeroCharterVersion,
  required: string[],
  versions: SessionZeroCharterVersion[],
  acksFor: AckLookup,
): boolean {
  if (required.length === 0) return true;
  return required.every((userId) => hasAcknowledgedThrough(userId, version, versions, acksFor));
}

/** Required participants who have not yet cleared the gate for `version`. */
export function outstandingAcknowledgers(
  version: SessionZeroCharterVersion,
  required: string[],
  versions: SessionZeroCharterVersion[],
  acksFor: AckLookup,
): Array<{ userId: string; state: CharterAcknowledgmentState | null }> {
  const direct = acksFor(version.id);
  return required
    .filter((userId) => !hasAcknowledgedThrough(userId, version, versions, acksFor))
    .map((userId) => ({ userId, state: direct.get(userId) ?? null }));
}
