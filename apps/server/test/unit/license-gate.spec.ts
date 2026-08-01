import {
  isOpenLicense,
  isSelfAuthoredLicense,
  licenseForbidsRedistribution,
  isValidUploadLicense,
} from '@campfire/schema';

describe('License Gate Helpers (Issue #1504)', () => {
  it('correctly identifies self-authored licenses', () => {
    expect(isSelfAuthoredLicense('My own work')).toBe(true);
    expect(isSelfAuthoredLicense('Custom')).toBe(true);
    expect(isSelfAuthoredLicense('Self')).toBe(true);
    expect(isSelfAuthoredLicense('Homebrew')).toBe(true);
    expect(isSelfAuthoredLicense('Original work')).toBe(true);
    expect(isSelfAuthoredLicense('OGL 1.0a')).toBe(false);
  });

  it('rejects CC-BY-NC-ND from open licenses and marks redistribution forbidden', () => {
    expect(isOpenLicense('CC-BY-NC-ND-4.0')).toBe(false);
    expect(licenseForbidsRedistribution('CC-BY-NC-ND-4.0')).toBe(true);
    expect(licenseForbidsRedistribution('CC-BY-4.0')).toBe(false);
    expect(isOpenLicense('CC-BY-4.0')).toBe(true);
  });

  it('validates upload licenses accepting open and self-authored but rejecting NC-ND / proprietary', () => {
    expect(isValidUploadLicense('My own work')).toBe(true);
    expect(isValidUploadLicense('OGL 1.0a')).toBe(true);
    expect(isValidUploadLicense('CC-BY-4.0')).toBe(true);
    expect(isValidUploadLicense('CC-BY-NC-ND-4.0')).toBe(false);
    expect(isValidUploadLicense('Proprietary / All Rights Reserved')).toBe(false);
  });
});
