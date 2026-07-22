import { ReleaseError } from './release-lib.mjs';

const API_VERSION = '2022-11-28';

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export class GitHubApi {
  constructor({ owner, repo, token, apiUrl = 'https://api.github.com', fetchImpl = globalThis.fetch }) {
    this.owner = owner;
    this.repo = repo;
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async request(method, path, { body, allow404 = false } = {}) {
    const response = await this.fetchImpl(`${this.apiUrl}/repos/${this.owner}/${this.repo}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'campfire-release-publisher',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allow404 && response.status === 404) return null;
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new ReleaseError(
        'GITHUB_API_ERROR',
        `GitHub API ${method} ${path} failed with ${response.status}: ${payload?.message ?? response.statusText}`,
        { status: response.status, payload },
      );
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  getRef(ref) {
    return this.request('GET', `/git/ref/${encodePath(ref)}`, { allow404: true });
  }

  getAnnotatedTag(sha) {
    return this.request('GET', `/git/tags/${encodeURIComponent(sha)}`);
  }

  getCommit(sha) {
    return this.request('GET', `/commits/${encodeURIComponent(sha)}`);
  }

  compare(base, head) {
    return this.request('GET', `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100`);
  }

  getJsonFile(path, ref) {
    return this.request('GET', `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`).then((payload) => {
      if (payload?.type !== 'file' || payload.encoding !== 'base64') {
        throw new ReleaseError('INVALID_CONTENT', `${path} at ${ref} is not a base64-encoded file.`);
      }
      try {
        return JSON.parse(Buffer.from(payload.content.replace(/\n/g, ''), 'base64').toString('utf8'));
      } catch (error) {
        throw new ReleaseError('INVALID_CONTENT', `${path} at ${ref} is not valid JSON: ${error.message}`);
      }
    });
  }

  async listReleases() {
    const releases = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request('GET', `/releases?per_page=100&page=${page}`);
      releases.push(...batch);
      if (batch.length < 100) return releases;
    }
  }

  getReleaseByTag(tag) {
    return this.request('GET', `/releases/tags/${encodeURIComponent(tag)}`, { allow404: true });
  }

  createRelease(input) {
    return this.request('POST', '/releases', { body: input });
  }

  listCheckRuns(sha) {
    return this.request('GET', `/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`);
  }

  listPullRequestsForCommit(sha) {
    return this.request('GET', `/commits/${encodeURIComponent(sha)}/pulls?per_page=100`);
  }

  getIssue(number) {
    return this.request('GET', `/issues/${number}`, { allow404: true });
  }
}
