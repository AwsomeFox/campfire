/**
 * Issue #748 — SSE client framing: CRLF/CR/LF, multiline data, heartbeats,
 * chunk boundaries, UTF-8 splits, malformed-frame recovery.
 *
 * Pure parser tests (no browser / no seeded server). Run with:
 *   npx playwright test --config pw-unit.config.ts e2e/tests/sse-parse.unit.spec.ts
 */
import { expect, test } from '@playwright/test';
import { SseParser, parseSseText, type SseParseSignal } from '../../src/lib/sseParse';

function messages(signals: SseParseSignal[]): string[] {
  return signals.filter((s): s is Extract<SseParseSignal, { kind: 'message' }> => s.kind === 'message').map((s) => s.message.data);
}

function recoveries(signals: SseParseSignal[]): number[] {
  return signals.filter((s): s is Extract<SseParseSignal, { kind: 'recovered' }> => s.kind === 'recovered').map((s) => s.discardedBytes);
}

const EVENT = JSON.stringify({
  type: 'encounter.updated',
  campaignId: 1,
  encounterId: 9,
  at: '2026-07-23T00:00:00.000Z',
});

test.describe('SseParser (#748)', () => {
  test('parses LF-delimited frames', () => {
    const signals = parseSseText(`data: ${EVENT}\n\n`);
    expect(messages(signals)).toEqual([EVENT]);
  });

  test('parses CRLF-delimited frames (the standards-compliant case the old client missed)', () => {
    const signals = parseSseText(`data: ${EVENT}\r\n\r\n`);
    expect(messages(signals)).toEqual([EVENT]);
  });

  test('parses CR-only line endings', () => {
    const signals = parseSseText(`data: ${EVENT}\r\r`);
    expect(messages(signals)).toEqual([EVENT]);
  });

  test('joins multiline data fields with a single LF between them', () => {
    const signals = parseSseText('data: {"a":1\ndata: ,"b":2}\n\n');
    expect(messages(signals)).toEqual(['{"a":1\n,"b":2}']);
  });

  test('ignores comment/heartbeat frames (proxy keepalives) without emitting messages', () => {
    const signals = parseSseText(`: keepalive\n\n: \n\ndata: ${EVENT}\n\n`);
    expect(messages(signals)).toEqual([EVENT]);
  });

  test('ignores comment-only CRLF heartbeats mixed with real frames', () => {
    const signals = parseSseText(`: ping\r\n\r\ndata: ${EVENT}\r\n\r\n: ping\r\n\r\n`);
    expect(messages(signals)).toEqual([EVENT]);
  });

  test('delivers multiple frames from a single chunk', () => {
    const a = JSON.stringify({ type: 'ping' });
    const b = EVENT;
    const signals = parseSseText(`data: ${a}\n\ndata: ${b}\n\n`);
    expect(messages(signals)).toEqual([a, b]);
  });

  test('assembles a frame split across chunk boundaries (including the blank-line delimiter)', () => {
    const parser = new SseParser();
    const part1 = `data: ${EVENT.slice(0, 12)}`;
    const part2 = `${EVENT.slice(12)}\n`;
    const part3 = `\n`;
    expect(messages(parser.pushText(part1))).toEqual([]);
    expect(messages(parser.pushText(part2))).toEqual([]);
    expect(messages(parser.pushText(part3))).toEqual([EVENT]);
  });

  test('pairs a CR at the end of one chunk with an LF at the start of the next (split CRLF)', () => {
    const parser = new SseParser();
    expect(messages(parser.pushText(`data: ${EVENT}\r`))).toEqual([]);
    expect(messages(parser.pushText('\n\r\n'))).toEqual([EVENT]);
  });

  test('handles mixed line endings within one stream', () => {
    const a = '{"n":1}';
    const b = '{"n":2}';
    const c = '{"n":3}';
    const signals = parseSseText(`data: ${a}\n\ndata: ${b}\r\n\r\ndata: ${c}\r\r`);
    expect(messages(signals)).toEqual([a, b, c]);
  });

  test('flushes a partial UTF-8 sequence at EOF via TextDecoder', () => {
    // U+2713 CHECK MARK is the 3-byte UTF-8 sequence E2 9C 93.
    const parser = new SseParser();
    const payload = '{"ok":"✓"}';
    const bytes = new TextEncoder().encode(`data: ${payload}\n\n`);
    // Split inside the multi-byte character (byte index of ✓ starts after `data: {"ok":"`).
    const checkIdx = bytes.indexOf(0xe2);
    expect(checkIdx).toBeGreaterThan(0);

    expect(messages(parser.push(bytes.slice(0, checkIdx + 1)))).toEqual([]);
    expect(messages(parser.push(bytes.slice(checkIdx + 1)))).toEqual([payload]);
  });

  test('flush() completes a dangling CR line ending and still requires a blank line to dispatch', () => {
    const parser = new SseParser();
    // One field line ended by CR, no blank line yet — incomplete event is discarded at flush.
    expect(messages(parser.pushText(`data: ${EVENT}\r`))).toEqual([]);
    expect(messages(parser.flush())).toEqual([]);
  });

  test('holds a trailing CR across chunks, then flush() treats it as a blank line at EOF', () => {
    const parser = new SseParser();
    // Final CR is held (might yet pair with LF). flush() completes it as an
    // empty line so a CR-only blank delimiter at EOF still dispatches.
    expect(messages(parser.pushText(`data: ${EVENT}\r\r`))).toEqual([]);
    expect(messages(parser.flush())).toEqual([EVENT]);
  });

  test('flush() after a mid-character UTF-8 split still yields a well-formed frame', () => {
    const parser = new SseParser();
    const payload = '{"ok":"✓"}';
    const bytes = new TextEncoder().encode(`data: ${payload}\n\n`);
    const checkIdx = bytes.indexOf(0xe2);
    expect(messages(parser.push(bytes.slice(0, checkIdx + 2)))).toEqual([]);
    expect(messages(parser.push(bytes.slice(checkIdx + 2)))).toEqual([payload]);
    expect(messages(parser.flush())).toEqual([]);
  });

  test('bounds malformed-frame buffer growth and exposes recovery', () => {
    const parser = new SseParser({ maxBufferedBytes: 64 });
    // Never send a blank line — unfinished text must not grow without bound.
    const signals = parser.pushText(`data: ${'x'.repeat(200)}`);
    expect(recoveries(signals).length).toBe(1);
    expect(recoveries(signals)[0]).toBeGreaterThan(64);
    expect(parser.bufferedBytes).toBe(0);

    // Recovery leaves the parser usable for subsequent well-formed frames.
    expect(messages(parser.pushText(`data: ${EVENT}\n\n`))).toEqual([EVENT]);
  });

  test('recovery also fires for a huge single line without any terminator', () => {
    const parser = new SseParser({ maxBufferedBytes: 32 });
    const signals = parser.pushText('data: ' + 'y'.repeat(100));
    expect(recoveries(signals).length).toBe(1);
    expect(messages(signals)).toEqual([]);
  });

  test('a large in-progress message does not trip unfinished-frame recovery', () => {
    // Old policy counted assembled `data` against maxBufferedBytes, so a single
    // legitimate payload larger than that limit was discarded mid-frame.
    const parser = new SseParser({ maxBufferedBytes: 64, maxMessageBytes: 8_192 });
    const payload = 'z'.repeat(500);
    const mid = parser.pushText(`data: ${payload}\n`);
    expect(recoveries(mid)).toEqual([]);
    expect(messages(mid)).toEqual([]);
    expect(parser.messageBytes).toBeGreaterThan(64);
    expect(parser.unfinishedBytes).toBe(0);

    const done = parser.pushText('\n');
    expect(recoveries(done)).toEqual([]);
    expect(messages(done)).toEqual([payload]);
  });

  test('in-progress message fields are still bounded by maxMessageBytes', () => {
    const parser = new SseParser({ maxBufferedBytes: 256, maxMessageBytes: 80 });
    // Terminated field lines accumulate in dataBuffer (not unfinished text).
    const signals = parser.pushText(`data: ${'w'.repeat(200)}\n`);
    expect(recoveries(signals).length).toBe(1);
    expect(recoveries(signals)[0]).toBeGreaterThan(80);
    expect(parser.bufferedBytes).toBe(0);
    expect(messages(parser.pushText(`data: ${EVENT}\n\n`))).toEqual([EVENT]);
  });

  test('strips one leading space after the field colon (WHATWG)', () => {
    const signals = parseSseText(`data:${EVENT}\n\ndata: ${EVENT}\n\n`);
    expect(messages(signals)).toEqual([EVENT, EVENT]);
  });

  test('preserves event / id / retry metadata on the message signal', () => {
    const signals = parseSseText('event: notice\nid: 42\nretry: 1500\ndata: hi\n\n');
    const msg = signals.find((s): s is Extract<SseParseSignal, { kind: 'message' }> => s.kind === 'message');
    expect(msg?.message).toEqual({ event: 'notice', data: 'hi', id: '42', retry: 1500 });
  });

  test('byte-chunk push path matches the text path for CRLF frames', () => {
    const parser = new SseParser();
    const bytes = new TextEncoder().encode(`data: ${EVENT}\r\n\r\n`);
    expect(messages(parser.push(bytes))).toEqual([EVENT]);
  });

  test('buffer caps measure UTF-8 bytes, not UTF-16 code units', () => {
    // U+2713 CHECK MARK is 1 UTF-16 code unit but 3 UTF-8 bytes.
    const parser = new SseParser({ maxBufferedBytes: 20 });
    // "data: " (6) + 5 check marks (15 bytes) = 21 UTF-8 bytes, 11 code units.
    const signals = parser.pushText(`data: ${'✓'.repeat(5)}`);
    expect(recoveries(signals).length).toBe(1);
    expect(recoveries(signals)[0]).toBeGreaterThan(20);
    // If caps used .length (code units), 11 would not have tripped a 20-byte cap.
    expect('data: '.length + 5).toBeLessThanOrEqual(20);
  });

  test('recovery preserves stream-level id and retry', () => {
    const parser = new SseParser({ maxBufferedBytes: 32 });
    expect(messages(parser.pushText('id: 99\nretry: 2500\ndata: hello\n\n'))).toEqual(['hello']);

    const recovered = parser.pushText('data: ' + 'z'.repeat(100));
    expect(recoveries(recovered).length).toBe(1);

    const after = parser.pushText('data: again\n\n');
    const msg = after.find((s): s is Extract<SseParseSignal, { kind: 'message' }> => s.kind === 'message');
    expect(msg?.message).toEqual({ event: '', data: 'again', id: '99', retry: 2500 });
  });

  test('full reset() clears stream-level id and retry', () => {
    const parser = new SseParser();
    expect(messages(parser.pushText('id: 7\nretry: 1000\ndata: hi\n\n'))).toEqual(['hi']);
    parser.reset();
    const after = parser.pushText('data: next\n\n');
    const msg = after.find((s): s is Extract<SseParseSignal, { kind: 'message' }> => s.kind === 'message');
    expect(msg?.message).toEqual({ event: '', data: 'next', id: null, retry: null });
  });
});
