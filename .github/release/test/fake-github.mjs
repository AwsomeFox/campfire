import { GitHubApi } from '../github-api.mjs';

export const SHAS = {
  old: '0000000000000000000000000000000000000001',
  bootstrap: '2bf2303ff73573819d006b9c7f95ee99ef30d1e0',
  feature: '1111111111111111111111111111111111111111',
  release: '2222222222222222222222222222222222222222',
  divergent: '3333333333333333333333333333333333333333',
};

const VERSION_PATHS = [
  'package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'packages/schema/package.json',
  'package-lock.json',
];

function versionFiles(version) {
  return {
    'package.json': { name: 'campfire', version },
    'apps/server/package.json': { name: '@campfire/server', version },
    'apps/web/package.json': { name: '@campfire/web', version },
    'packages/schema/package.json': { name: '@campfire/schema', version },
    'package-lock.json': {
      name: 'campfire',
      version,
      packages: {
        '': { version },
        'apps/server': { version },
        'apps/web': { version },
        'packages/schema': { version },
      },
    },
  };
}

function response(status, payload) {
  return new Response(payload === undefined ? null : JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clone(value) {
  return structuredClone(value);
}

export class FakeGitHub {
  constructor() {
    this.mainSha = SHAS.release;
    this.requests = [];
    this.releases = [];
    this.raceOnCreate = false;
    this.issues = new Map([[42, {
      number: 42,
      title: 'Keyboard navigation is incomplete',
      state: 'closed',
      html_url: 'https://github.test/acme/campfire/issues/42',
    }]]);
    this.tags = new Map([
      ['v0.14.0', { type: 'commit', sha: SHAS.bootstrap }],
      ['v0.14.2', { type: 'tag', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', commitSha: SHAS.release }],
    ]);
    this.commits = new Map([
      [SHAS.old, this.commit(SHAS.old, [], 'Initial history', [])],
      [SHAS.bootstrap, this.commit(SHAS.bootstrap, [SHAS.old], 'v0.14.0', VERSION_PATHS)],
      [SHAS.feature, this.commit(SHAS.feature, [SHAS.bootstrap], 'feat(a11y): improve keyboard navigation (#100)', ['apps/web/src/App.tsx'])],
      [SHAS.release, this.commit(SHAS.release, [SHAS.feature], 'chore(release): bump version to v0.14.2 (#101)', VERSION_PATHS)],
      [SHAS.divergent, this.commit(SHAS.divergent, [SHAS.bootstrap], 'chore(release): bump version to v0.14.2', VERSION_PATHS)],
    ]);
    this.files = new Map([
      [SHAS.bootstrap, versionFiles('0.14.0')],
      [SHAS.feature, versionFiles('0.14.1')],
      [SHAS.release, versionFiles('0.14.2')],
      [SHAS.divergent, versionFiles('0.14.2')],
    ]);
    this.pullRequests = new Map([[SHAS.feature, [{
      number: 100,
      title: 'Improve keyboard navigation and focus polish',
      body: 'Adds complete keyboard navigation. Fixes #42.\n\n## Known limitations\nTouch testing remains a follow-up.',
      html_url: 'https://github.test/acme/campfire/pull/100',
      merged_at: '2026-07-22T12:00:00Z',
      merge_commit_sha: SHAS.feature,
      labels: [{ name: 'accessibility' }],
      user: { login: 'helper', html_url: 'https://github.test/helper' },
    }]]]);
    this.checks = new Map([[SHAS.release, this.successfulChecks()]]);
  }

  commit(sha, parents, message, files) {
    return {
      sha,
      html_url: `https://github.test/acme/campfire/commit/${sha}`,
      commit: { message },
      parents: parents.map((parentSha) => ({ sha: parentSha })),
      files: files.map((filename) => ({ filename, status: 'modified' })),
    };
  }

  successfulChecks() {
    return ['lint', 'build-test', 'coverage', 'e2e-web', 'release-automation'].map((name, index) => ({
      name,
      status: 'completed',
      conclusion: 'success',
      completed_at: `2026-07-22T12:0${index}:00Z`,
      app: { slug: 'github-actions' },
    }));
  }

  isAncestor(ancestor, descendant) {
    let cursor = descendant;
    while (cursor) {
      if (cursor === ancestor) return true;
      cursor = this.commits.get(cursor)?.parents?.[0]?.sha;
    }
    return false;
  }

  commonAncestor(left, right) {
    const leftAncestors = new Set();
    let cursor = left;
    while (cursor) {
      leftAncestors.add(cursor);
      cursor = this.commits.get(cursor)?.parents?.[0]?.sha;
    }
    cursor = right;
    while (cursor) {
      if (leftAncestors.has(cursor)) return cursor;
      cursor = this.commits.get(cursor)?.parents?.[0]?.sha;
    }
    return null;
  }

  range(base, head) {
    const commits = [];
    let cursor = head;
    while (cursor && cursor !== base) {
      const commit = this.commits.get(cursor);
      if (!commit) break;
      commits.push(commit);
      cursor = commit.parents?.[0]?.sha;
    }
    return cursor === base ? commits.reverse() : [];
  }

  async fetch(url, options = {}) {
    const parsed = new URL(url);
    const method = options.method ?? 'GET';
    const path = parsed.pathname.replace('/repos/acme/campfire', '');
    this.requests.push({ method, path, body: options.body ? JSON.parse(options.body) : undefined });

    if (method === 'GET' && path === '/git/ref/heads/main') {
      return response(200, { ref: 'refs/heads/main', object: { type: 'commit', sha: this.mainSha } });
    }
    if (method === 'GET' && path.startsWith('/git/ref/tags/')) {
      const tag = decodeURIComponent(path.slice('/git/ref/tags/'.length));
      const ref = this.tags.get(tag);
      return ref ? response(200, { ref: `refs/tags/${tag}`, object: { type: ref.type, sha: ref.sha } }) : response(404, { message: 'Not Found' });
    }
    if (method === 'GET' && path.startsWith('/git/tags/')) {
      const objectSha = path.slice('/git/tags/'.length);
      const entry = [...this.tags.entries()].find(([, value]) => value.type === 'tag' && value.sha === objectSha);
      return entry
        ? response(200, { tag: entry[0], object: { type: 'commit', sha: entry[1].commitSha } })
        : response(404, { message: 'Not Found' });
    }
    if (method === 'GET' && path.startsWith('/contents/')) {
      const ref = parsed.searchParams.get('ref');
      const filePath = decodeURIComponent(path.slice('/contents/'.length));
      const document = this.files.get(ref)?.[filePath];
      return document
        ? response(200, { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(document)).toString('base64') })
        : response(404, { message: 'Not Found' });
    }
    const compare = /^\/compare\/([^.]*)\.\.\.([^?]*)$/.exec(path);
    if (method === 'GET' && compare) {
      const base = decodeURIComponent(compare[1]);
      const head = decodeURIComponent(compare[2]);
      const commits = this.range(base, head);
      const ancestor = this.isAncestor(base, head);
      return response(200, {
        status: base === head ? 'identical' : ancestor ? 'ahead' : 'diverged',
        merge_base_commit: { sha: ancestor ? base : this.commonAncestor(base, head) },
        total_commits: commits.length,
        commits: clone(commits),
      });
    }
    let match = /^\/commits\/([^/]+)\/check-runs$/.exec(path);
    if (method === 'GET' && match) {
      return response(200, { check_runs: clone(this.checks.get(match[1]) ?? []) });
    }
    match = /^\/commits\/([^/]+)\/pulls$/.exec(path);
    if (method === 'GET' && match) {
      return response(200, clone(this.pullRequests.get(match[1]) ?? []));
    }
    match = /^\/commits\/([^/]+)$/.exec(path);
    if (method === 'GET' && match) {
      const commit = this.commits.get(match[1]);
      return commit ? response(200, clone(commit)) : response(404, { message: 'Not Found' });
    }
    if (method === 'GET' && path === '/releases/tags/v0.14.2') {
      const release = this.releases.find((item) => item.tag_name === 'v0.14.2');
      return release ? response(200, clone(release)) : response(404, { message: 'Not Found' });
    }
    if (method === 'GET' && path === '/releases') return response(200, clone(this.releases));
    match = /^\/issues\/(\d+)$/.exec(path);
    if (method === 'GET' && match) {
      const issue = this.issues.get(Number(match[1]));
      return issue ? response(200, clone(issue)) : response(404, { message: 'Not Found' });
    }
    if (method === 'POST' && path === '/releases') {
      const input = JSON.parse(options.body);
      if (this.releases.some((item) => item.tag_name === input.tag_name)) {
        return response(422, { message: 'Validation Failed' });
      }
      const release = {
        id: this.releases.length + 1,
        ...input,
        html_url: `https://github.test/acme/campfire/releases/tag/${input.tag_name}`,
      };
      this.releases.push(release);
      if (this.raceOnCreate) return response(422, { message: 'Validation Failed' });
      return response(201, clone(release));
    }
    return response(500, { message: `Unhandled fake route: ${method} ${path}${parsed.search}` });
  }

  api() {
    return new GitHubApi({
      owner: 'acme',
      repo: 'campfire',
      token: 'fake-token',
      apiUrl: 'https://api.github.test',
      fetchImpl: this.fetch.bind(this),
    });
  }
}

export function testConfig({ bootstrap = true } = {}) {
  return {
    mainBranch: 'main',
    requiredChecks: ['lint', 'build-test', 'coverage', 'e2e-web', 'release-automation'],
    bootstrap: bootstrap ? { tag: 'v0.14.0', commitSha: SHAS.bootstrap } : undefined,
    versionSources: [
      { label: 'root package', path: 'package.json', pointer: ['version'] },
      { label: 'server package/runtime', path: 'apps/server/package.json', pointer: ['version'] },
      { label: 'web package/UI', path: 'apps/web/package.json', pointer: ['version'] },
      { label: 'schema package', path: 'packages/schema/package.json', pointer: ['version'] },
      { label: 'lockfile', path: 'package-lock.json', pointer: ['version'] },
      { label: 'lockfile root', path: 'package-lock.json', pointer: ['packages', '', 'version'] },
      { label: 'lockfile server', path: 'package-lock.json', pointer: ['packages', 'apps/server', 'version'] },
      { label: 'lockfile web', path: 'package-lock.json', pointer: ['packages', 'apps/web', 'version'] },
      { label: 'lockfile schema', path: 'package-lock.json', pointer: ['packages', 'packages/schema', 'version'] },
    ],
  };
}
