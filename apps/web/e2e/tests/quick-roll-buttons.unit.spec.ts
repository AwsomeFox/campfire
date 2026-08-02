import { expect, test } from '@playwright/test';
import {
  parseToHitDisplay,
  parseDamageDisplay,
  getDamageTypeIcon,
} from '../../src/features/encounters/QuickRollButtons';

test.describe('QuickRollButtons unit tests (issue #1850)', () => {
  test.describe('parseToHitDisplay', () => {
    test('parses canonical +7 modifier', () => {
      expect(parseToHitDisplay('+7')).toBe('+7');
    });

    test('parses unsigned modifier 5 as +5', () => {
      expect(parseToHitDisplay('5')).toBe('+5');
    });

    test('parses to-hit with trailing text "+5 to hit"', () => {
      expect(parseToHitDisplay('+5 to hit')).toBe('+5');
    });

    test('parses negative modifier -1', () => {
      expect(parseToHitDisplay('-1')).toBe('-1');
    });

    test('returns empty string for empty input', () => {
      expect(parseToHitDisplay('')).toBe('');
      expect(parseToHitDisplay('   ')).toBe('');
    });
  });

  test.describe('getDamageTypeIcon', () => {
    test('returns correct emoji icons for damage types', () => {
      expect(getDamageTypeIcon('slashing')).toBe('⚔️');
      expect(getDamageTypeIcon('piercing')).toBe('⚔️');
      expect(getDamageTypeIcon('bludgeoning')).toBe('⚔️');
      expect(getDamageTypeIcon('fire')).toBe('🔥');
      expect(getDamageTypeIcon('cold')).toBe('❄️');
      expect(getDamageTypeIcon('ice')).toBe('❄️');
      expect(getDamageTypeIcon('lightning')).toBe('⚡');
      expect(getDamageTypeIcon('thunder')).toBe('🔊');
      expect(getDamageTypeIcon('acid')).toBe('🧪');
      expect(getDamageTypeIcon('poison')).toBe('🧪');
      expect(getDamageTypeIcon('radiant')).toBe('✨');
      expect(getDamageTypeIcon('necrotic')).toBe('💀');
      expect(getDamageTypeIcon('psychic')).toBe('🧠');
      expect(getDamageTypeIcon('force')).toBe('💥');
    });

    test('falls back to ⚔️ for untyped or unknown damage', () => {
      expect(getDamageTypeIcon('')).toBe('⚔️');
      expect(getDamageTypeIcon('untyped')).toBe('⚔️');
    });
  });

  test.describe('parseDamageDisplay', () => {
    test('parses 1d8+4 slashing into display with ⚔️ icon', () => {
      const res = parseDamageDisplay('1d8+4 slashing');
      expect(res.display).toBe('1d8+4 ⚔️');
      expect(res.icon).toBe('⚔️');
      expect(res.type).toBe('slashing');
    });

    test('parses 3d6 fire into display with 🔥 icon', () => {
      const res = parseDamageDisplay('3d6 fire');
      expect(res.display).toBe('3d6 🔥');
      expect(res.icon).toBe('🔥');
      expect(res.type).toBe('fire');
    });

    test('parses flat damage 5 acid into display with 🧪 icon', () => {
      const res = parseDamageDisplay('5 acid');
      expect(res.display).toBe('5 🧪');
      expect(res.icon).toBe('🧪');
      expect(res.type).toBe('acid');
    });

    test('returns empty for empty input', () => {
      const res = parseDamageDisplay('');
      expect(res.display).toBe('');
    });
  });
});
