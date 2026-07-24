import { historicalAvatarAttachmentId, safeHistoricalAvatarUrl } from '../../src/common/avatar-url';

describe('safeHistoricalAvatarUrl', () => {
  it('keeps relative attachment routes and safe HTTPS remotes', () => {
    expect(safeHistoricalAvatarUrl('/api/v1/attachments/12/file')).toBe('/api/v1/attachments/12/file');
    expect(safeHistoricalAvatarUrl('https://images.example.test/portrait.png')).toBe(
      'https://images.example.test/portrait.png',
    );
  });

  it('normalizes absolute attachment URLs to the canonical relative route', () => {
    expect(safeHistoricalAvatarUrl('https://cdn.example.test/api/v1/attachments/42/file')).toBe(
      '/api/v1/attachments/42/file',
    );
    expect(safeHistoricalAvatarUrl('https://cdn.example.test/api/v1/attachments/42/file?v=1#face')).toBe(
      '/api/v1/attachments/42/file',
    );
  });

  it('rejects active-content and credentialed schemes', () => {
    expect(safeHistoricalAvatarUrl('javascript:alert(1)')).toBeNull();
    expect(safeHistoricalAvatarUrl('data:image/png;base64,abc')).toBeNull();
    expect(safeHistoricalAvatarUrl('http://images.example.test/portrait.png')).toBeNull();
    expect(safeHistoricalAvatarUrl('https://user:pass@images.example.test/portrait.png')).toBeNull();
  });
});

describe('historicalAvatarAttachmentId', () => {
  it('extracts ids from relative and absolute attachment routes', () => {
    expect(historicalAvatarAttachmentId('/api/v1/attachments/7/file')).toBe(7);
    expect(historicalAvatarAttachmentId('/api/v1/attachments/7/file?cache=1')).toBe(7);
    expect(historicalAvatarAttachmentId('https://host.example/api/v1/attachments/99/file')).toBe(99);
    expect(historicalAvatarAttachmentId('https://host.example/api/v1/attachments/99/file?x=1#y')).toBe(99);
  });

  it('ignores non-attachment URLs', () => {
    expect(historicalAvatarAttachmentId('https://images.example.test/portrait.png')).toBeNull();
    expect(historicalAvatarAttachmentId('/api/v1/characters/7')).toBeNull();
    expect(historicalAvatarAttachmentId('/api/v1/attachments/0/file')).toBeNull();
  });
});
