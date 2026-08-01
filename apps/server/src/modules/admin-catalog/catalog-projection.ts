/**
 * Issue #587 — the single place that decides what a server operator may learn about a
 * campaign they are NOT a member of.
 *
 * WHY THIS FILE IS SEPARATE FROM THE SERVICE
 * ------------------------------------------
 * The acceptance criterion that carries the whole feature is negative: metadata access
 * must not be able to retrieve quests, notes, attachments, session-zero, or DM secrets.
 * A negative property is only maintainable if there is exactly one narrow place where
 * the answer to "what may be disclosed?" is written down. That is this file, and
 * `admin-catalog.isolation.e2e-spec.ts` asserts its contents directly.
 *
 * WHY AN ENUMERATED PROJECTION RATHER THAN `campaigns.*` MINUS A DENYLIST
 * ----------------------------------------------------------------------
 * `select().from(campaigns)` already returns `ics_token` today — a live, plaintext
 * capability secret that grants the public calendar feed for that campaign. A denylist
 * would have to have anticipated it. More importantly a denylist fails OPEN: the next
 * column someone adds to `campaigns` ships to every server operator on the next deploy,
 * silently, with no review. The allowlist below fails CLOSED — a new column is invisible
 * until somebody adds it here on purpose, and `catalog-projection.spec.ts` fails the
 * build if the two ever drift.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { CampaignCatalogFieldVisibility, CampaignCatalogPrivacy, CampaignCatalogPrivacyPolicy } from '@campfire/schema';
import { campaigns } from '../../db/schema';

/**
 * The ONLY `campaigns` columns the catalog may read. Enumerated on purpose — see the
 * file header. Every entry is operational metadata or an explicitly privacy-gated
 * string; none of it is campaign content, and none of it is derived from campaign
 * content.
 *
 * Deliberately absent, and each for a specific reason:
 *  - `ics_token` / `ics_token_expires_at` — a bearer capability for the campaign's
 *    calendar feed. Disclosing it would hand an operator ongoing read access to the
 *    schedule, which is exactly the "administrative label laundering content access"
 *    failure this feature exists to avoid.
 *  - `current_location_id` / `active_encounter_id` / `map_attachment_id` — pointers into
 *    campaign content. An id is a small leak, but it is still a leak: it confirms a
 *    location/encounter/attachment exists and gives an operator something to correlate.
 *  - `danger_level`, `narration_language`, `dm_controls_progression`,
 *    `dm_controls_turns`, `require_dm_turn_confirmation`,
 *    `public_recap_sharing_enabled` — table-play preferences. Not needed to locate or
 *    administer a campaign, so not disclosed. If a future operator workflow genuinely
 *    needs one, adding it here is a one-line, reviewable change.
 *  - `latest_session_number` — a denormalized session-position statistic.
 *    `session_count` is the operational summary; the highest live session number is not
 *    needed to locate or administer a campaign in the catalog.
 */
export const CATALOG_CAMPAIGN_COLUMNS = {
  id: campaigns.id,
  /** Privacy-gated: replaced by a non-identifying placeholder when redacted. */
  name: campaigns.name,
  /** Privacy-gated: dropped entirely (no placeholder) when redacted. */
  description: campaigns.description,
  status: campaigns.status,
  catalogPrivacy: campaigns.catalogPrivacy,
  ruleSystem: campaigns.ruleSystem,
  sessionCount: campaigns.sessionCount,
  storageQuotaBytes: campaigns.storageQuotaBytes,
  publicInvitesEnabled: campaigns.publicInvitesEnabled,
  aiExternalContentPolicy: campaigns.aiExternalContentPolicy,
  deletedAt: campaigns.deletedAt,
  createdAt: campaigns.createdAt,
  updatedAt: campaigns.updatedAt,
} as const;

/**
 * The same allowlist as a plain string array, for the guard spec. Kept adjacent to the
 * object above so a reviewer sees both change together.
 */
export const CATALOG_CAMPAIGN_COLUMN_NAMES: readonly string[] = Object.keys(CATALOG_CAMPAIGN_COLUMNS);

/** Settings key holding the server-wide catalog disclosure default. */
export const CATALOG_PRIVACY_SETTINGS_KEY = 'campaign.catalog.privacy';

/**
 * Server-wide defaults when no operator override is stored.
 *
 * `descriptions` defaults to `redacted` and `names` to `visible`, and the asymmetry is
 * the point: a name is the handle an operator needs in order to talk to a DM about
 * their campaign at all, while a description is free prose that routinely carries
 * pitch, premise, and content warnings — the thing the issue is actually worried about.
 * An operator who disagrees flips it, and flipping it is audited.
 */
export const CATALOG_PRIVACY_DEFAULTS: Readonly<{
  names: CampaignCatalogFieldVisibility;
  descriptions: CampaignCatalogFieldVisibility;
}> = { names: 'visible', descriptions: 'redacted' };

/**
 * What the catalog actually discloses for one campaign, combining the server default
 * with that campaign's own opt-out.
 *
 * TIGHTEN-ONLY: a campaign set to `redacted` is redacted no matter what the server
 * default says, and there is no per-campaign value that forces disclosure when the
 * server default is `redacted`. A privacy control that the more-privileged party can
 * relax is not a privacy control.
 */
export function effectiveVisibility(
  policy: Pick<CampaignCatalogPrivacyPolicy, 'names' | 'descriptions'>,
  campaignPrivacy: CampaignCatalogPrivacy,
): { names: CampaignCatalogFieldVisibility; descriptions: CampaignCatalogFieldVisibility } {
  if (campaignPrivacy === 'redacted') return { names: 'redacted', descriptions: 'redacted' };
  return { names: policy.names, descriptions: policy.descriptions };
}

/**
 * The stand-in shown for a redacted campaign name.
 *
 * Derived SOLELY from the id, which the row already discloses, so it carries exactly
 * zero additional bits. Deliberately NOT any of the tempting alternatives:
 *  - blank — an operator could no longer tell two rows apart or act on one confidently;
 *  - a truncation or initialism ("Tue…", "T.T.P.G.") — leaks the very string withheld;
 *  - a length hint ("████████ (17)") — same, in a form that looks responsible.
 */
export function redactedCampaignName(id: number): string {
  return `Campaign #${id}`;
}

/**
 * ORDER BY expression for `sort=name`, and the reason it is not simply `lower(name)`.
 *
 * Sorting redacted rows by their true names turns the ordering itself into an oracle:
 * an operator who can see where a redacted row lands alphabetically, and who can insert
 * campaigns with names of their choosing, can binary-search the hidden name one
 * comparison at a time. So redacted rows sort by the empty string — they cluster
 * together and are then ordered by id (the caller always appends the id tiebreaker),
 * which is the same information their placeholder already shows.
 */
export function nameSortExpression(namesVisible: boolean): SQL {
  if (!namesVisible) {
    // Every row is redacted server-wide — collapse the key entirely and let the id
    // tiebreaker do all the ordering.
    return sql`''`;
  }
  return sql`CASE WHEN ${campaigns.catalogPrivacy} = 'redacted' THEN '' ELSE lower(${campaigns.name}) END`;
}

/**
 * WHERE predicate for free-text `?q=`, and the reason it is visibility-aware.
 *
 * If search matched redacted names, an operator could recover a withheld name by
 * probing substrings and watching which queries return the row — the classic search
 * oracle, and a complete bypass of the opt-out. So a row is only matchable on a field
 * the operator is actually allowed to READ. Numeric input additionally matches the id
 * exactly, because "find campaign 412" is the one lookup that must keep working
 * regardless of privacy (the id is disclosed on every row anyway).
 *
 * Returns undefined when the query is empty, so callers can skip the predicate.
 */
export function searchPredicate(
  raw: string | undefined,
  policy: Pick<CampaignCatalogPrivacyPolicy, 'names' | 'descriptions'>,
): SQL | undefined {
  const q = (raw ?? '').trim();
  if (q === '') return undefined;

  // LIKE with the default (no ESCAPE clause) treats % and _ as wildcards; escape them
  // so a search for "100%" is a literal search rather than a match-everything.
  const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const pattern = `%${escaped}%`;

  const clauses: SQL[] = [];
  // A row whose name is redacted is only name-matchable through its placeholder, and
  // the placeholder is `Campaign #<id>` — covered by the numeric branch below.
  if (policy.names === 'visible') {
    clauses.push(
      sql`(${campaigns.catalogPrivacy} <> 'redacted' AND ${campaigns.name} LIKE ${pattern} ESCAPE '\\')`,
    );
  }
  if (policy.descriptions === 'visible') {
    clauses.push(
      sql`(${campaigns.catalogPrivacy} <> 'redacted' AND ${campaigns.description} LIKE ${pattern} ESCAPE '\\')`,
    );
  }
  // Rule system is an operational identifier, never human prose, so it is always
  // searchable — it is disclosed on every row regardless of privacy.
  clauses.push(sql`${campaigns.ruleSystem} LIKE ${pattern} ESCAPE '\\'`);

  const asId = Number(q);
  if (Number.isInteger(asId) && asId > 0) {
    clauses.push(sql`${campaigns.id} = ${asId}`);
  }

  // PARENTHESISE THE WHOLE CHAIN. This predicate is handed to drizzle's `and(...)`
  // alongside the trash and status filters. `and()` wraps the group it builds but does
  // NOT parenthesise each operand, and `AND` binds tighter than `OR` — so returning a
  // bare `a OR b OR c` here degrades the caller's WHERE into
  //   (deleted_at IS NULL AND status = ? AND a) OR b OR c
  // and every trailing branch escapes the filters entirely. A campaign in the trash
  // would then surface in an operator's search, and in the `total` COUNT beside it.
  // Covered by the "smuggle a trashed campaign past the trash filter" e2e regression.
  return sql`(${sql.join(clauses, sql` OR `)})`;
}
