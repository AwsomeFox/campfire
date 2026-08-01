import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const TURN_WORKSPACE = resolve(ROOT, 'src/features/encounters/TurnWorkspace.tsx');

test.describe('Standard combat actions bar (#1852)', () => {
  test('TurnWorkspace defines accessible standard actions with GameIcon and 44px targets', () => {
    const source = readFileSync(TURN_WORKSPACE, 'utf8');

    expect(source).toMatch(/data-testid="standard-actions-bar"/);
    expect(source).toMatch(/aria-label=\{act\.label\}/);
    expect(source).toMatch(/min-h-\[44px\]/);
    expect(source).toMatch(/actionSlot \? actionSlot\.used >= actionSlot\.max : true/);
    expect(source).toMatch(/standardActions = useMemo\(/);
  });
});
