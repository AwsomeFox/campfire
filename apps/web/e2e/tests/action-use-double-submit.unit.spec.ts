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

    // 5. Apply button is disabled when commitSubmitted is true or isPending
    expect(code).toMatch(/disabled=\{applyDisabled \|\| commit\.isPending \|\| commitSubmitted \|\| preview\.applied\}/);

    // 6. onClick guards against double dispatch
    expect(code).toMatch(/if \(commitSubmitted \|\| commit\.isPending\) return;/);
  });
});
