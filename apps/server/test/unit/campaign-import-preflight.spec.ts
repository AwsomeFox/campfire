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
