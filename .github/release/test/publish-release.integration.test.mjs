import assert from 'node:assert/strict';
import test from 'node:test';
import { executeRelease, selectPreviousValidRelease } from '../publish-release.mjs';
import { FakeGitHub, SHAS, testConfig } from './fake-github.mjs';

const repositoryUrl = 'https://github.test/acme/campfire';

async function run(fake, options = {}) {
  return executeRelease({
    api: fake.api(),
    config: options.config ?? testConfig(),
    tag: options.tag ?? 'v0.14.2',
    dryRun: options.dryRun ?? true,
    repositoryUrl,
  });
}

test('no prior release uses only the explicitly pinned bootstrap baseline', async () => {
  const fake = new FakeGitHub();
  const result = await run(fake);
  assert.equal(result.status, 'dry-run');
  assert.equal(result.previous.source, 'bootstrap');
  assert.equal(result.previous.tag, 'v0.14.0');
  assert.equal(result.previous.commitSha, SHAS.bootstrap);
});

test('a divergent pushed tag fails closed before any mutation', async () => {
  const fake = new FakeGitHub();
  fake.tags.set('v0.14.2', { type: 'tag', sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', commitSha: SHAS.divergent });
  await assert.rejects(run(fake), (error) => error.code === 'STALE_MAIN_TAG');
  assert.equal(fake.requests.some((request) => request.method !== 'GET'), false);
});

test('an old tag without a GitHub Release is not guessed as the baseline', async () => {
  const fake = new FakeGitHub();
  fake.tags.set('v0.14.1', { type: 'commit', sha: SHAS.feature });
  await assert.rejects(run(fake, { config: testConfig({ bootstrap: false }) }), (error) => error.code === 'NO_BASELINE');
});

test('a GitHub Release without its tag is rejected as a baseline', async () => {
  const fake = new FakeGitHub();
  fake.releases.push({ tag_name: 'v0.14.1', draft: false, html_url: 'https://example/release' });
  await assert.rejects(
    run(fake, { config: testConfig({ bootstrap: false }) }),
    (error) => error.code === 'NO_BASELINE' && error.message.includes('v0.14.1: MISSING_TAG'),
  );
});

test('a prerelease is never selected as the previous stable baseline', async () => {
  const fake = new FakeGitHub();
  fake.tags.set('v0.14.1', { type: 'commit', sha: SHAS.feature });
  fake.files.set(SHAS.feature, {
    'package.json': { version: '0.14.1' },
    'apps/server/package.json': { version: '0.14.1' },
    'apps/web/package.json': { version: '0.14.1' },
    'packages/schema/package.json': { version: '0.14.1' },
    'package-lock.json': {
      version: '0.14.1',
      packages: {
        '': { version: '0.14.1' },
        'apps/server': { version: '0.14.1' },
        'apps/web': { version: '0.14.1' },
        'packages/schema': { version: '0.14.1' },
      },
    },
  });
  fake.releases.push({ tag_name: 'v0.14.1', draft: false, prerelease: true });
  await assert.rejects(
    run(fake, { config: testConfig({ bootstrap: false }) }),
    (error) => error.code === 'NO_BASELINE' && error.message.includes('v0.14.1: prerelease'),
  );
});

test('duplicate and retried runs create exactly one release', async () => {
  const fake = new FakeGitHub();
  const first = await run(fake, { dryRun: false });
  const second = await run(fake, { dryRun: false });
  assert.equal(first.status, 'published');
  assert.equal(second.status, 'already-published');
  assert.equal(fake.releases.filter((release) => release.tag_name === 'v0.14.2').length, 1);
  assert.equal(fake.requests.filter((request) => request.method === 'POST' && request.path === '/releases').length, 1);
});

test('a create-response race recovers by finding the one completed release', async () => {
  const fake = new FakeGitHub();
  fake.raceOnCreate = true;
  const result = await run(fake, { dryRun: false });
  assert.equal(result.status, 'already-published');
  assert.equal(fake.releases.length, 1);
  assert.equal(fake.requests.filter((request) => request.method === 'POST').length, 1);
});

test('a conflicting pre-existing release fails instead of being treated as a retry', async () => {
  const fake = new FakeGitHub();
  fake.releases.push({
    tag_name: 'v0.14.2',
    target_commitish: SHAS.feature,
    name: 'Manual release',
    body: '',
    draft: false,
    prerelease: false,
  });
  await assert.rejects(run(fake, { dryRun: false }), (error) => error.code === 'EXISTING_RELEASE_MISMATCH');
  assert.equal(fake.requests.some((request) => request.method === 'POST'), false);
});

test('a stale semantic version is rejected even when its commit is on main', async () => {
  const fake = new FakeGitHub();
  fake.tags.set('v0.15.0', { type: 'commit', sha: SHAS.feature });
  fake.files.set(SHAS.feature, {
    'package.json': { version: '0.15.0' },
    'apps/server/package.json': { version: '0.15.0' },
    'apps/web/package.json': { version: '0.15.0' },
    'packages/schema/package.json': { version: '0.15.0' },
    'package-lock.json': {
      version: '0.15.0',
      packages: {
        '': { version: '0.15.0' },
        'apps/server': { version: '0.15.0' },
        'apps/web': { version: '0.15.0' },
        'packages/schema': { version: '0.15.0' },
      },
    },
  });
  fake.releases.push({ tag_name: 'v0.15.0', draft: false });
  await assert.rejects(
    selectPreviousValidRelease(fake.api(), 'v0.14.2', SHAS.release, testConfig()),
    (error) => error.code === 'STALE_TAG',
  );
});

test('a synchronized tag that is not the exact current main head is rejected', async () => {
  const fake = new FakeGitHub();
  fake.mainSha = SHAS.feature;
  await assert.rejects(run(fake), (error) => error.code === 'STALE_MAIN_TAG');
});

test('missing, failed, or non-GitHub required CI fails closed', async () => {
  const fake = new FakeGitHub();
  const checks = fake.successfulChecks();
  checks.find((check) => check.name === 'build-test').conclusion = 'failure';
  checks.find((check) => check.name === 'lint').app.slug = 'untrusted-app';
  fake.checks.set(SHAS.release, checks);
  await assert.rejects(
    run(fake),
    (error) => error.code === 'REQUIRED_CI_FAILED'
      && error.message.includes('build-test=completed/failure')
      && error.message.includes('lint=missing'),
  );
});

test('inconsistent package, workspace, runtime, UI, or lock metadata fails closed', async () => {
  const fake = new FakeGitHub();
  fake.files.get(SHAS.release)['apps/web/package.json'].version = '0.14.1';
  await assert.rejects(run(fake), (error) => error.code === 'VERSION_MISMATCH' && error.message.includes('web package/UI'));
});

test('lightweight release tags are rejected', async () => {
  const fake = new FakeGitHub();
  fake.tags.set('v0.14.2', { type: 'commit', sha: SHAS.release });
  await assert.rejects(run(fake), (error) => error.code === 'LIGHTWEIGHT_TAG');
});

test('successful release includes categorized PRs, closed issues, contributors, and callouts', async () => {
  const fake = new FakeGitHub();
  const result = await run(fake, { dryRun: false });
  assert.equal(result.status, 'published');
  const body = fake.releases[0].body;
  assert.match(body, /## Accessibility/);
  assert.match(body, /\[#100\]\(https:\/\/github\.test\/acme\/campfire\/pull\/100\)/);
  assert.match(body, /closes \[#42\]/);
  assert.match(body, /## Operational notes/);
  assert.match(body, /\*\*Known limitations:\*\* \[#100\]/);
  assert.match(body, /\[@helper\]/);
  assert.doesNotMatch(body, /chore\(release\)/);
});

test('dry-run performs no GitHub mutation', async () => {
  const fake = new FakeGitHub();
  const result = await run(fake, { dryRun: true });
  assert.equal(result.status, 'dry-run');
  assert.equal(fake.requests.some((request) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)), false);
  assert.equal(fake.releases.length, 0);
});
