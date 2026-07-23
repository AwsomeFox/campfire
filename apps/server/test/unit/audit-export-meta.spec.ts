import { computeCampaignAuditExportTruncated } from '../../src/modules/audit/audit.service';

describe('computeCampaignAuditExportTruncated (#731)', () => {
  it('is zero when the snapshot is complete and nothing was appended after the ceiling', () => {
    expect(computeCampaignAuditExportTruncated(500, 500, 500, 500)).toBe(0);
  });

  it('counts rows appended after snapshotMaxId', () => {
    expect(computeCampaignAuditExportTruncated(100, 100, 108, 100)).toBe(8);
  });

  it('counts snapshot gaps when retention pruning drops rows during export', () => {
    // Old formula `retainedNow - exported` would report 0 here and hide the gap.
    expect(computeCampaignAuditExportTruncated(100, 80, 80, 80)).toBe(20);
  });

  it('sums snapshot gaps and post-ceiling appends', () => {
    expect(computeCampaignAuditExportTruncated(100, 80, 85, 80)).toBe(25);
  });
});
