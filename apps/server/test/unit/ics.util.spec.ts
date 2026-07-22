import ICAL from 'ical.js';
import type { ScheduledSession } from '@campfire/schema';
import { buildCampaignIcs, foldIcsContentLine } from '../../src/modules/sessions/ics.util';

const OCTET_LIMIT = 75;
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

function physicalLines(value: string): string[] {
  return value.split('\r\n');
}

function unfold(value: string): string {
  return value.replace(/\r\n[ \t]/g, '');
}

function graphemeBoundaries(value: string): Set<number> {
  const boundaries = new Set<number>([0, value.length]);
  for (const part of segmenter.segment(value)) boundaries.add(part.index);
  return boundaries;
}

function expectValidFold(source: string, folded = foldIcsContentLine(source)): void {
  const lines = physicalLines(folded);
  expect(unfold(folded)).toBe(source);
  lines.forEach((line, index) => {
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(OCTET_LIMIT);
    expect(Buffer.from(line, 'utf8').toString('utf8')).toBe(line);
    if (index > 0) expect(line.startsWith(' ')).toBe(true);
  });

  // Every normal fold point lands between user-perceived graphemes. A single
  // grapheme may exceed the RFC payload, in which case scalar-safe splitting
  // is intentionally permitted and covered separately below.
  const boundaries = graphemeBoundaries(source);
  let sourceOffset = 0;
  for (let index = 0; index < lines.length - 1; index += 1) {
    sourceOffset += lines[index].slice(index === 0 ? 0 : 1).length;
    if (boundaries.has(sourceOffset)) continue;
    const enclosing = [...segmenter.segment(source)].find(
      ({ index: start, segment }) => start < sourceOffset && sourceOffset < start + segment.length,
    );
    expect(enclosing && Buffer.byteLength(enclosing.segment, 'utf8')).toBeGreaterThan(74);
  }
}

function schedule(overrides: Partial<ScheduledSession> = {}): ScheduledSession {
  return {
    id: 7,
    campaignId: 3,
    scheduledAt: '2099-10-01T18:00:00.000Z',
    durationMinutes: 240,
    title: 'A short title',
    location: '',
    notes: '',
    createdAt: '2099-01-01T00:00:00.000Z',
    updatedAt: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('RFC 5545 UTF-8 content-line folding', () => {
  it.each([
    { line: '', label: 'empty' },
    { line: 'SUMMARY:short', label: 'short ASCII' },
    { line: 'x'.repeat(75), label: 'exactly 75 ASCII octets' },
    { line: 'SUMMARY:' + 'مرحبا بالعالم '.repeat(8), label: 'Arabic / RTL' },
    { line: 'SUMMARY:' + '漢字仮名交じり文'.repeat(10), label: 'CJK' },
    { line: 'SUMMARY:' + 'Cafe\u0301 '.repeat(20), label: 'combining sequences' },
    { line: 'SUMMARY:' + '👩‍🚀🏳️‍🌈🇺🇳'.repeat(12), label: 'emoji, ZWJ, and flags' },
    { line: 'URL:https://example.test/' + 'campaign/session/'.repeat(12), label: 'long URL' },
  ])('folds $label content within the octet ceiling', ({ line }) => {
    expectValidFold(line);
  });

  it('uses 75 octets on the first line and reserves one octet for each continuation prefix', () => {
    const folded = foldIcsContentLine('x'.repeat(224));
    const lines = physicalLines(folded);
    expect(lines.map((line) => Buffer.byteLength(line, 'utf8'))).toEqual([75, 75, 75, 2]);
    expect(lines.slice(1).every((line) => line[0] === ' ' && line[1] !== ' ')).toBe(true);
  });

  it('keeps deterministic boundary positions valid across ASCII and multibyte graphemes', () => {
    const tokens = ['a', '界', 'e\u0301', '👩‍🚀', '🇨🇦'];
    for (const token of tokens) {
      for (let prefixLength = 0; prefixLength <= 80; prefixLength += 1) {
        expectValidFold('P'.repeat(prefixLength) + token.repeat(24));
      }
    }
  });

  it('falls back to Unicode scalar boundaries when one grapheme exceeds a continuation payload', () => {
    const oversizedGrapheme = `e${'\u0301'.repeat(90)}`;
    const source = `DESCRIPTION:${oversizedGrapheme}`;
    const folded = foldIcsContentLine(source);
    expectValidFold(source, folded);
    expect(physicalLines(folded).length).toBeGreaterThan(2);
  });

  it('emits canonical CRLF and parses folded Unicode TEXT with an independent RFC parser', () => {
    const title = 'بوابة النجوم، 星の門 👩‍🚀🇺🇳 ' + 'é'.repeat(60);
    const location = 'https://example.test/مكان/星?' + 'q=🚀'.repeat(30);
    const notes = `First line; with comma, slash \\ and emoji 👨‍👩‍👧‍👦\rSecond line\n${'Cafe\u0301 世界 '.repeat(30)}`;
    const ics = buildCampaignIcs(
      { id: 3, name: 'حملة 星の旅団' },
      [schedule({ title, location, notes })],
    );

    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    for (const line of physicalLines(ics).slice(0, -1)) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(OCTET_LIMIT);
    }

    const calendar = new ICAL.Component(ICAL.parse(ics));
    const event = calendar.getFirstSubcomponent('vevent');
    expect(event).not.toBeNull();
    expect(event!.getFirstPropertyValue('summary')).toBe(title);
    expect(event!.getFirstPropertyValue('location')).toBe(location);
    expect(event!.getFirstPropertyValue('description')).toBe(notes.replace(/\r\n|\r|\n/g, '\n'));
  });
});
