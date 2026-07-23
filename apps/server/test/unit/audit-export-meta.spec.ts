import { computeCampaignAuditExportTruncated } from '../../src/modules/audit/audit.service';

describe('computeCampaignAuditExportTruncated (#731)', () => {
  it('is zero when the full snapshot was exported and nothing appended', () => {
    expect(computeCampaignAuditExportTruncated(500, 500, 0)).toBe(0);
  });

  it('counts rows appended after the snapshot ceiling', () => {
    expect(computeCampaignAuditExportTruncated(100, 100, 8)).toBe(8);
  });

  it('counts snapshot gaps from pruning during the walk', () => {
    expect(computeCampaignAuditExportTruncated(100, 80, 0)).toBe(20);
  });

  it('sums pruning gaps and post-snapshot appends', () => {
    expect(computeCampaignAuditExportTruncated(100, 80, 5)).toBe(25);
  });
});
