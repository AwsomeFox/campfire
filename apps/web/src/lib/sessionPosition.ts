/**
 * Campaign position vs recap volume labels (issue #841).
 *
 * `sessionCount` is a COUNT(*) of live recap rows. `latestSessionNumber` is the
 * highest canonical session `number` among those rows. When numbering has gaps
 * (imports, skipped numbers, deleted high sessions), labeling the count as
 * "Session N" mis-states where the campaign is — so surfaces use this helper.
 *
 * Scheduled upcoming game nights live in a separate table and never affect these
 * fields; only logged session recaps do.
 */

export type CampaignSessionPosition = {
  sessionCount: number;
  latestSessionNumber: number;
};

function recapLabel(count: number): string {
  return count === 1 ? '1 recap' : `${count} recaps`;
}

/**
 * Human-readable campaign session position for cards / status chrome.
 *
 * - No live recaps → "No sessions yet"
 * - Contiguous (count === latest) → "Session N"
 * - Gaps / non-contiguous → "Session N · M recaps" (count is useful when it
 *   diverges from the canonical session number)
 */
export function formatCampaignSessionPosition(campaign: CampaignSessionPosition): string {
  const count = Math.max(0, campaign.sessionCount);
  const latest = Math.max(0, campaign.latestSessionNumber);

  if (count === 0 && latest === 0) return 'No sessions yet';

  if (latest > 0) {
    // Recap volume is useful when it disagrees with the session number (gaps,
    // deleted highs, imported sparse numbering). Otherwise "Session N" alone
    // already conveys both position and that N recaps exist.
    if (count > 0 && count !== latest) {
      return `Session ${latest} · ${recapLabel(count)}`;
    }
    return `Session ${latest}`;
  }

  // Defensive: count without a latest number shouldn't happen when stats are
  // recomputed together, but still label the count correctly as recaps.
  return count > 0 ? recapLabel(count) : 'No sessions yet';
}
