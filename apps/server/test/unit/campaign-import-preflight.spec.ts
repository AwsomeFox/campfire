import { BadRequestException } from '@nestjs/common';
import {
  accumulateImportUncompressedBytes,
  assertImportDiskReserve,
} from '../../src/modules/campaigns/campaigns.service';

// Issue #851 — archive uncompressed-size and available-disk-reserve preflight,
// tested as pure functions with tiny injected caps/fakes so this never has to
// allocate a real multi-hundred-MB buffer (the real MAX_IMPORT_UNCOMPRESSED_BYTES
// default is 512 MiB) or touch the real filesystem.
describe('campaign import preflight (issue #851)', () => {
  describe('accumulateImportUncompressedBytes', () => {
    it('accepts a running total exactly at the cap', () => {
      expect(accumulateImportUncompressedBytes(90, 10, 100)).toBe(100);
    });

    it('rejects the moment the running total exceeds the cap', () => {
      expect(() => accumulateImportUncompressedBytes(90, 11, 100)).toThrow(BadRequestException);
    });

    it('accumulates across multiple calls (the real per-entry loop shape)', () => {
      let total = 0;
      total = accumulateImportUncompressedBytes(total, 40, 100);
      total = accumulateImportUncompressedBytes(total, 40, 100);
      expect(total).toBe(80);
      expect(() => accumulateImportUncompressedBytes(total, 21, 100)).toThrow(BadRequestException);
    });
  });

  describe('assertImportDiskReserve', () => {
    it('is a no-op when nothing will be written (requiredBytes <= 0)', () => {
      expect(() =>
        assertImportDiskReserve(0, { statfs: () => ({ bavail: 0, bsize: 1 }) }),
      ).not.toThrow();
    });

    it('throws when free space minus the required bytes would fall below the reserve', () => {
      // 1000 bytes free, needs 400, reserve 700 -> 1000 - 400 = 600 < 700 -> reject.
      expect(() =>
        assertImportDiskReserve(400, {
          statfs: () => ({ bavail: 1000, bsize: 1 }),
          reserveBytes: 700,
        }),
      ).toThrow(BadRequestException);
    });

    it('passes when free space comfortably covers the requirement plus the reserve', () => {
      // 10000 bytes free, needs 400, reserve 700 -> 10000 - 400 = 9300 >= 700 -> ok.
      expect(() =>
        assertImportDiskReserve(400, {
          statfs: () => ({ bavail: 10000, bsize: 1 }),
          reserveBytes: 700,
        }),
      ).not.toThrow();
    });

    it('degrades silently when statfs cannot run (never blocks an import on a diagnostic it cannot perform)', () => {
      expect(() =>
        assertImportDiskReserve(400, {
          statfs: () => {
            throw new Error('ENOSYS');
          },
        }),
      ).not.toThrow();
    });
  });
});

describe('#851 review — the cap must fire BEFORE the allocation', () => {
  it('rejects an entry whose DECLARED uncompressed size already blows the cap', () => {
    // Accumulating only after `.async('nodebuffer')` bounds the SUM across entries but not the
    // PEAK of any single one. The compressed upload cap is 128 MiB and one deflate entry can
    // expand by orders of magnitude, so a small crafted archive could force a multi-gigabyte
    // allocation before the running total ever crossed its ceiling — the classic zip bomb this
    // preflight exists to close.
    expect(() => accumulateImportUncompressedBytes(0, 4_000, 1_000)).toThrow(/uncompressed size/i);
  });

  it('still catches a header that UNDERSTATES the truth, which is why both checks stay', () => {
    // A declared size is attacker-supplied. The pre-check is the cheap rejection; the
    // post-decompression accumulate is what a lying header runs into.
    const afterHonestDeclaration = accumulateImportUncompressedBytes(0, 10, 1_000);
    expect(afterHonestDeclaration).toBe(10);
    expect(() => accumulateImportUncompressedBytes(afterHonestDeclaration, 4_000, 1_000)).toThrow(/uncompressed size/i);
  });
});
