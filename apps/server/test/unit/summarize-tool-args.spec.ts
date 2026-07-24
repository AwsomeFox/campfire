import { describe, it, expect } from '@jest/globals';
import { summarizeToolArgs } from '../../src/modules/ai-driver/ai-driver.service';

/**
 * #1072: Verify the tool-args summarizer produces redaction-safe, DM-readable output
 * for the audit log detail. Secrets must never appear in the summary; long strings
 * must be truncated; nested objects/arrays must render as shape-only placeholders.
 */
describe('summarizeToolArgs (#1072)', () => {
  it('handles primitives cleanly', () => {
    const summary = summarizeToolArgs({
      campaignId: 42,
      damage: 15,
      hidden: true,
      alive: false,
    });
    expect(summary).toContain('campaignId=42');
    expect(summary).toContain('damage=15');
    expect(summary).toContain('hidden=true');
    expect(summary).toContain('alive=false');
  });

  it('quotes short strings', () => {
    const summary = summarizeToolArgs({ label: 'DEX save' });
    expect(summary).toContain('label="DEX save"');
  });

  it('truncates long strings to 60 chars with ellipsis', () => {
    const long = 'x'.repeat(200);
    const summary = summarizeToolArgs({ note: long });
    expect(summary).toContain('…');
    // The 60-char truncated content stays under ~70 chars in the rendered "note=..." entry
    const noteEntry = summary.split(', ').find((s) => s.startsWith('note='));
    expect(noteEntry).toBeDefined();
    expect(noteEntry!.length).toBeLessThan(80);
  });

  it('renders arrays as shape-only', () => {
    const summary = summarizeToolArgs({ tags: ['a', 'b', 'c'] });
    expect(summary).toContain('tags=<array[3]>');
    // The actual values must not leak
    expect(summary).not.toContain('"a"');
  });

  it('renders nested objects as shape-only', () => {
    const summary = summarizeToolArgs({ payload: { secret: 'x', foo: 'bar' } });
    expect(summary).toContain('payload=<object>');
    expect(summary).not.toContain('"bar"');
  });

  it('redacts secret-like keys regardless of value', () => {
    const summary = summarizeToolArgs({
      apiKey: 'sk-abc123',
      password: 'hunter2',
      dmSecret: 'plot twist',
      Authorization: 'Bearer xyz',
      token: 'abc',
    });
    expect(summary).toContain('apiKey=<redacted>');
    expect(summary).toContain('password=<redacted>');
    expect(summary).toContain('dmSecret=<redacted>');
    expect(summary).toContain('Authorization=<redacted>');
    expect(summary).toContain('token=<redacted>');
    // Raw secret values must never leak
    expect(summary).not.toContain('sk-abc123');
    expect(summary).not.toContain('hunter2');
    expect(summary).not.toContain('plot twist');
    expect(summary).not.toContain('Bearer xyz');
  });

  it('handles null/undefined args safely', () => {
    expect(summarizeToolArgs(null)).toBe('');
    expect(summarizeToolArgs(undefined)).toBe('');
    expect(summarizeToolArgs({})).toBe('');
  });

  it('bounds total output length', () => {
    // Feed many long-string fields to force truncation
    const bigArgs: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      bigArgs[`field${i}`] = 'x'.repeat(30);
    }
    const summary = summarizeToolArgs(bigArgs);
    expect(summary.length).toBeLessThan(1000); // sanity cap
    expect(summary).toContain('…'); // truncation indicator
  });

  it('null values render as "null"', () => {
    const summary = summarizeToolArgs({ optional: null });
    expect(summary).toContain('optional=null');
  });
});
