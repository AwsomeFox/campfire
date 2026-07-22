import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function lintBasicWorkflowSchema(source, filename) {
  assert.equal(/^[ ]*\t/m.test(source), false, `${filename}: tabs are not valid indentation`);
  assert.match(source, /^name:\s*\S+/m, `${filename}: name is required`);
  assert.match(source, /^on:\s*$/m, `${filename}: on mapping is required`);
  assert.match(source, /^jobs:\s*$/m, `${filename}: jobs mapping is required`);
  const contexts = [];
  const seenByContext = new Map();
  let scalarIndent = null;
  for (const [index, line] of source.split('\n').entries()) {
    const spaces = line.match(/^ */)[0].length;
    assert.equal(spaces % 2, 0, `${filename}:${index + 1}: indentation must use two-space levels`);
    assert.equal((line.match(/\$\{\{/g) ?? []).length, (line.match(/\}\}/g) ?? []).length,
      `${filename}:${index + 1}: unbalanced expression`);
    if (scalarIndent !== null && (line.trim() === '' || spaces > scalarIndent)) continue;
    scalarIndent = null;
    if (/^\s*-\s+/.test(line)) {
      while (contexts.length > 0 && contexts.at(-1).indent >= spaces) contexts.pop();
      contexts.push({ indent: spaces, key: `[item-${index}]` });
      continue;
    }
    const keyMatch = /^( *)([A-Za-z_][A-Za-z0-9_-]*):(?:\s|$)/.exec(line);
    if (!keyMatch) continue;
    while (contexts.length > 0 && contexts.at(-1).indent >= spaces) contexts.pop();
    const parent = contexts.map((context) => context.key).join('/');
    const contextId = `${spaces}:${parent}`;
    const seen = seenByContext.get(contextId) ?? new Set();
    assert.equal(seen.has(keyMatch[2]), false, `${filename}:${index + 1}: duplicate ${keyMatch[2]} key`);
    seen.add(keyMatch[2]);
    seenByContext.set(contextId, seen);
    contexts.push({ indent: spaces, key: keyMatch[2] });
    if (/\|[-+]?\s*$/.test(line)) scalarIndent = spaces;
  }

  const topLevel = [...source.matchAll(/^([A-Za-z_][A-Za-z0-9_-]*):/gm)].map((match) => match[1]);
  const allowed = new Set(['name', 'run-name', 'on', 'permissions', 'env', 'defaults', 'concurrency', 'jobs']);
  for (const key of topLevel) assert.equal(allowed.has(key), true, `${filename}: unknown top-level key ${key}`);

  const jobsStart = source.search(/^jobs:\s*$/m);
  const jobsSource = source.slice(jobsStart);
  const jobs = [...jobsSource.matchAll(/^  ([A-Za-z_][A-Za-z0-9_-]*):\s*$/gm)];
  assert.ok(jobs.length > 0, `${filename}: at least one job is required`);
  for (const [jobIndex, job] of jobs.entries()) {
    const start = job.index;
    const end = jobs[jobIndex + 1]?.index ?? jobsSource.length;
    const block = jobsSource.slice(start, end);
    assert.match(block, /^    runs-on:\s*\S+/m, `${filename}: job ${job[1]} needs runs-on`);
    assert.match(block, /^    steps:\s*$/m, `${filename}: job ${job[1]} needs steps`);
  }

  for (const permission of source.matchAll(/^\s+(actions|checks|contents|deployments|discussions|id-token|issues|packages|pages|pull-requests|repository-projects|security-events|statuses):\s*(\S+)\s*$/gm)) {
    assert.match(permission[2], /^(read|write|none)$/, `${filename}: invalid ${permission[1]} permission`);
  }
}

test('release workflow is strict, least-privilege, and contains no release-decision automation', async () => {
  const release = await readFile(new URL('../../workflows/release.yml', import.meta.url), 'utf8');
  const ci = await readFile(new URL('../../workflows/ci.yml', import.meta.url), 'utf8');
  lintBasicWorkflowSchema(release, 'release.yml');
  lintBasicWorkflowSchema(ci, 'ci.yml');

  assert.match(release, /tags: \['v\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*'\]/);
  assert.match(release, /if: \$\{\{ !contains\(github\.ref_name, '-'\) && !contains\(github\.ref_name, '\+'\) \}\}/);
  assert.doesNotMatch(release, /^\s*schedule:/m);
  assert.doesNotMatch(release, /^\s*workflow_dispatch:/m);
  assert.doesNotMatch(release, /npm version|git tag|create.pull.request|merged PR count|ten merges/i);
  assert.match(release, /node \.github\/release\/publish-release\.mjs --dry-run/);
  assert.match(release, /publish-container:[\s\S]*needs: validate/);
  assert.match(release, /publish-github-release:[\s\S]*needs: \[validate, publish-container\]/);
  assert.equal((release.match(/contents: write/g) ?? []).length, 1, 'only the GitHub Release job may write contents');
  assert.equal((release.match(/packages: write/g) ?? []).length, 1, 'only the container job may write packages');
  assert.doesNotMatch(release, /pull-requests: write|issues: write|actions: write|checks: write/);
  assert.doesNotMatch(ci, /^\s+tags:/m, 'ordinary CI must not be the tag publisher');
  assert.match(ci, /^  release-automation:/m);
});
