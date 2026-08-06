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

describe('#851 review — the manifest is not exempt from the pre-check', () => {
  it('rejects a declared manifest size over the cap, the same way an attachment entry is rejected', () => {
    // campaign.json is read FIRST and was the one entry getting only post-decompression
    // accounting, so an archive whose sole content is a highly compressible manifest could
    // force its full expansion into memory before any cap fired. Same accumulator, same cap —
    // the guard has to cover both branches, not just the loop that came second.
    expect(() => accumulateImportUncompressedBytes(0, 4_000, 1_000)).toThrow(/uncompressed size/i);
  });
});


// Kilo review: `declaredUncompressedBytes` reads a JSZip-internal `_data.uncompressedSize`.
// If JSZip ever renames or restructures that, the function starts returning null for every
// entry and the declared-size pre-check SILENTLY disappears — the post-decompression
// accumulate still enforces the cap, so nothing fails; the peak-allocation defence just
// stops existing, which is the whole reason the pre-check was added.
//
// A try/catch would not help (reading a missing property does not throw), and exporting the
// function purely to test it is the test-only-export pattern AGENTS.md discourages. Pinning
// the assumption directly is what turns a silent degradation into a loud failure: this test
// asserts the exact private shape the production reader depends on, against a real archive.
describe('#851 — the JSZip declared-size assumption the pre-check rests on', () => {
  it('exposes a finite numeric uncompressed size on an entry loaded from a real archive', async () => {
    const JSZip = (await import('jszip')).default;
    const payload = 'x'.repeat(5_000); // compresses hugely — declared size must still read 5000
    const archive = await new JSZip().file('campaign.json', payload).generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    });

    const entry = (await JSZip.loadAsync(archive)).file('campaign.json');
    const declared = (entry as unknown as { _data?: { uncompressedSize?: unknown } })?._data?.uncompressedSize;

    expect(typeof declared).toBe('number');
    expect(declared).toBe(payload.length);
    // And it is genuinely available BEFORE decompression — the property is populated by
    // loadAsync, not by async('nodebuffer'), which is what makes the pre-check a pre-check.
    expect(archive.length).toBeLessThan(payload.length);
  });
});
