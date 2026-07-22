import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReleaseError,
  categoryForChange,
  compareSemver,
  extractClosingIssueNumbers,
  generateReleaseNotes,
  parseReleaseTag,
  selectHighestPreviousVersion,
  validateVersionDocuments,
  validateVersionTransition,
} from '../release-lib.mjs';
import { collectChanges } from '../publish-release.mjs';

test('strict tag parsing accepts stable SemVer and rejects ambiguous tags', () => {
  assert.deepEqual(parseReleaseTag('v12.34.56').parts, [12, 34, 56]);
  for (const invalid of ['1.2.3', 'v1.2', 'v1.2.3-rc.1', 'v01.2.3', 'v1.2.3.4', 'version-1.2.3']) {
    assert.throws(() => parseReleaseTag(invalid), (error) => error.code === 'INVALID_TAG');
  }
  assert.equal(compareSemver('v0.14.2', 'v0.14.1'), 1);
});

test('version consistency reports every missing or drifting source', () => {
  const documents = new Map([
    ['package.json', { version: '1.2.3' }],
    ['package-lock.json', { version: '1.2.2', packages: { '': {} } }],
  ]);
  const sources = [
    { label: 'root', path: 'package.json', pointer: ['version'] },
    { label: 'lock', path: 'package-lock.json', pointer: ['version'] },
    { label: 'lock root', path: 'package-lock.json', pointer: ['packages', '', 'version'] },
  ];
  assert.throws(
    () => validateVersionDocuments(documents, sources, '1.2.3'),
    (error) => error instanceof ReleaseError
      && error.code === 'VERSION_MISMATCH'
      && error.details.length === 2,
  );
});

test('release commit must move every metadata source forward', () => {
  const sources = [
    { label: 'root', path: 'package.json', pointer: ['version'] },
    { label: 'lock', path: 'package-lock.json', pointer: ['version'] },
  ];
  const forward = new Map([
    ['package.json', { version: '1.2.2' }],
    ['package-lock.json', { version: '1.2.1' }],
  ]);
  assert.equal(validateVersionTransition(forward, sources, 'v1.2.3'), undefined);
  forward.get('package-lock.json').version = '1.2.3';
  assert.throws(
    () => validateVersionTransition(forward, sources, 'v1.2.3'),
    (error) => error.code === 'INVALID_VERSION_TRANSITION' && error.message.includes('lock'),
  );
});

test('previous valid release selection is semantic, not lexicographic, and rejects stale tags', () => {
  const selected = selectHighestPreviousVersion([
    { tag: 'v0.9.0' },
    { tag: 'v0.14.0' },
    { tag: 'v0.10.0' },
  ], 'v0.14.2');
  assert.equal(selected.tag, 'v0.14.0');
  assert.throws(
    () => selectHighestPreviousVersion([{ tag: 'v0.15.0' }], 'v0.14.2'),
    (error) => error.code === 'STALE_TAG',
  );
});

test('note grouping prioritizes security and accessibility and de-duplicates changes', () => {
  assert.equal(categoryForChange({ title: 'fix auth privilege escalation', labels: [] }), 'Security');
  assert.equal(categoryForChange({ title: 'fix keyboard navigation', labels: [{ name: 'accessibility' }] }), 'Accessibility');
  assert.deepEqual(extractClosingIssueNumbers('Fixes #12. Resolves acme/campfire#13. fixes #12.'), [12, 13]);
  const change = {
    number: 9,
    sha: 'abc',
    title: 'Document configuration migration',
    body: 'Fixes #12',
    html_url: 'https://github.test/pull/9',
    labels: [{ name: 'documentation' }],
    author: { login: 'ada', html_url: 'https://github.test/ada' },
    closedIssueNumbers: [12],
  };
  const notes = generateReleaseNotes({
    tag: 'v1.2.3',
    previousTag: 'v1.2.2',
    changes: [change, change],
    issues: [{ number: 12, html_url: 'https://github.test/issues/12' }],
  });
  assert.equal(notes.match(/Document configuration migration/g)?.length, 1);
  assert.match(notes, /## Documentation/);
  assert.match(notes, /closes \[#12\]/);
  assert.match(notes, /\*\*Migrations:\*\* \[#9\]/);
  assert.match(notes, /\*\*Configuration:\*\* \[#9\]/);
  assert.match(notes, /## Contributors/);
});

test('configuration callouts recognize a standalone .env path', () => {
  const notes = generateReleaseNotes({
    tag: 'v1.2.3',
    previousTag: 'v1.2.2',
    changes: [{
      number: 10,
      sha: 'def',
      title: 'Document operator setup',
      body: 'Update `.env` before restarting the server.',
      html_url: 'https://github.test/pull/10',
      labels: [],
      author: { login: 'grace', html_url: 'https://github.test/grace' },
      closedIssueNumbers: [],
    }],
    issues: [],
  });
  assert.match(notes, /\*\*Configuration:\*\* \[#10\]/);
});

test('commit-range extraction omits merge and release noise and de-duplicates merged PRs', async () => {
  const commits = [
    { sha: 'feature', commit: { message: 'feat: useful' }, html_url: 'https://example/feature' },
    { sha: 'merge', commit: { message: 'Merge branch main' }, html_url: 'https://example/merge' },
    { sha: 'release', commit: { message: 'chore(release): v1.2.3' }, html_url: 'https://example/release' },
  ];
  const pr = {
    number: 10,
    title: 'Useful feature',
    body: '',
    html_url: 'https://example/pull/10',
    merged_at: '2026-01-01T00:00:00Z',
    merge_commit_sha: 'feature',
    labels: [],
    user: { login: 'dev' },
  };
  const releasePr = { ...pr, number: 11, title: 'Bump v1.2.3', merge_commit_sha: 'release' };
  const api = {
    compare: async () => ({ status: 'ahead', merge_base_commit: { sha: 'base' }, total_commits: 3, commits }),
    listPullRequestsForCommit: async (sha) => sha === 'release' ? [releasePr] : sha === 'feature' ? [pr, pr, releasePr] : [],
    getIssue: async () => null,
  };
  const result = await collectChanges(api, 'base', 'release', 'https://example/repo');
  assert.deepEqual(result.changes.map((change) => change.number), [10]);
});
