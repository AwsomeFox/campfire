import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ACTION_USE_FLOW_FILE = resolve(__dirname, '../../src/features/encounters/ActionUseFlow.tsx');

test.describe('ActionUseFlow double-submit guard & error handling (issue #1474)', () => {
  test('ActionUseFlow source enforces double-submit locking and ambiguous failure handling', () => {
    const code = readFileSync(ACTION_USE_FLOW_FILE, 'utf8');

    // 1. Double-submit lock state exists
    expect(code).toMatch(/const \[commitSubmitted, setCommitSubmitted\] = useState\(false\);/);
    expect(code).toMatch(/const \[isUnconfirmed, setIsUnconfirmed\] = useState\(false\);/);

    // 2. Lock Apply button immediately on dispatch in onMutate
    expect(code).toMatch(/onMutate: \(\) => \{[\s\S]*?setCommitSubmitted\(true\);/);

    // 3. Re-enable button ONLY on definitive 4xx client errors
    expect(code).toMatch(/const is4xx = err instanceof ApiError && err\.status >= 400 && err\.status < 500;/);
    expect(code).toMatch(/if \(is4xx\) \{[\s\S]*?setCommitSubmitted\(false\);/);

    // 4. Handle ambiguous network/server errors with unconfirmed state and invalidateEncounter
    expect(code).toMatch(/setIsUnconfirmed\(true\);/);
    expect(code).toMatch(/void invalidateEncounter\(queryClient, encounterId\);/);

    // 5. Apply button is disabled when commitSubmitted is true or isPending.
    //    Asserted term-by-term rather than as one literal expression: issue #1933 added
    //    `applyGateReason` (the Apply-only safety-hold blocker) to this guard and reflowed
    //    it across lines, which broke a whole-expression regex that was really pinning
    //    formatting. What this test owns is that the double-submit terms are present, not
    //    the order or line breaks of the disjunction.
    //    Scoped to the Apply button's own guard by anchoring on its testid — a bare
    //    `disabled={...term...}` search would match any other control's guard in the file
    //    and could not fail.
    const applyAnchor = code.indexOf('data-testid="action-use-apply"');
    expect(applyAnchor).toBeGreaterThan(-1);
    const applyGuard = code.slice(applyAnchor, code.indexOf('}', code.indexOf('disabled={', applyAnchor) + 10) + 1);
    for (const term of ['applyDisabled', 'commit.isPending', 'commitSubmitted', 'preview.applied']) {
      expect(applyGuard).toContain(term);
    }

    // 6. onClick guards against double dispatch
    expect(code).toMatch(/if \(commitSubmitted \|\| commit\.isPending\) return;/);

    // 7. Unconfirmed state offers Retry button with same chainId and disables Back button
    expect(code).toMatch(/data-testid="action-use-retry"/);
    expect(code).toMatch(/disabled=\{commit\.isPending \|\| isUnconfirmed\}/);

    // 8. Cancel button disabled when commit is pending, submitted, or unconfirmed
    expect(code).toMatch(/disabled=\{commit\.isPending \|\| commitSubmitted \|\| isUnconfirmed\}/);
  });
});
