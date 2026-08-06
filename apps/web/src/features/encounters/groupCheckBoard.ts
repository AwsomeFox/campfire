/**
 * Pure grouping/tally logic for the DM group-check board (issue #1943).
 *
 * `CheckRequest` carries the REQUESTED dc but not the roll's outcome — only `rollId` once
 * resolved. To show a per-character pass/fail chip the board joins each resolved row against
 * the campaign's recent dice-roll feed (`GET /campaigns/:id/rolls`, the same shared log already
 * rendered alongside the check-request panel) by `rollId`, recovering the roll's
 * server-computed `success`. A roll that has aged out of the fetched window — or a request sent
 * with no `dc` — reports `success: null`; the board shows it as resolved with no pass/fail chip
 * rather than guessing.
 */
import type { CheckRequest, DiceRoll } from '@campfire/schema';

export interface GroupCheckMember {
  characterId: number;
  characterName: string;
  status: CheckRequest['status'];
  /** null = undeterminable (still pending, no dc was requested, or the roll fell out of the fetched window). */
  success: boolean | null;
}

export interface GroupCheckSummary {
  groupId: string;
  checkLabel: string;
  dc: number | null;
  createdAt: string;
  members: GroupCheckMember[];
  totalCount: number;
  resolvedCount: number;
  passCount: number;
}

/**
 * Groups check requests sharing a non-null `groupId` into one summary per group, newest group
 * first (by the highest row id in the group — rows within one `requestChecks` call are inserted
 * together, so this is stable creation order). Rows with a null `groupId` (pre-#1943 history)
 * are excluded — there is no group to show them under.
 */
export function buildGroupCheckSummaries(
  requests: readonly CheckRequest[],
  rolls: readonly DiceRoll[],
): GroupCheckSummary[] {
  const rollById = new Map<number, DiceRoll>();
  for (const roll of rolls) rollById.set(roll.id, roll);

  const rowsByGroup = new Map<string, CheckRequest[]>();
  for (const req of requests) {
    if (!req.groupId) continue;
    const rows = rowsByGroup.get(req.groupId);
    if (rows) rows.push(req);
    else rowsByGroup.set(req.groupId, [req]);
  }

  const summaries: Array<{ summary: GroupCheckSummary; maxRowId: number }> = [];
  for (const [groupId, rows] of rowsByGroup) {
    const sorted = [...rows].sort((a, b) => a.id - b.id);
    const members: GroupCheckMember[] = sorted.map((row) => {
      let success: boolean | null = null;
      if (row.status === 'resolved' && row.rollId != null) {
        success = rollById.get(row.rollId)?.success ?? null;
      }
      return { characterId: row.characterId, characterName: row.characterName, status: row.status, success };
    });
    const resolvedCount = members.filter((m) => m.status === 'resolved').length;
    const passCount = members.filter((m) => m.success === true).length;
    summaries.push({
      summary: {
        groupId,
        checkLabel: sorted[0].checkLabel,
        dc: sorted[0].dc,
        createdAt: sorted[0].createdAt,
        members,
        totalCount: members.length,
        resolvedCount,
        passCount,
      },
      maxRowId: sorted[sorted.length - 1].id,
    });
  }

  summaries.sort((a, b) => b.maxRowId - a.maxRowId);
  return summaries.map((s) => s.summary);
}

/**
 * Whether the "Group succeeds (half or more)" advisory should render for a group (issue #1943):
 * only once every member has resolved, at least half passed, AND the adapter's system endorses
 * the convention (see `groupCheckMajorityAdvisoryForAdapter` in @campfire/schema). A group with
 * any DC-less member never reaches this — `passCount` only counts members with a known `success`.
 */
export function groupCheckMajoritySucceeds(summary: GroupCheckSummary, adapterHasMajorityAdvisory: boolean): boolean {
  if (!adapterHasMajorityAdvisory) return false;
  if (summary.resolvedCount !== summary.totalCount) return false;
  return summary.passCount * 2 >= summary.totalCount;
}
