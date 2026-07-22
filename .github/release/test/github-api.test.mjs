import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubApi } from '../github-api.mjs';

test('wraps a non-JSON GitHub response in a fail-closed ReleaseError', async () => {
  const api = new GitHubApi({
    owner: 'AwsomeFox',
    repo: 'campfire',
    token: 'test-token',
    fetchImpl: async () => new Response('<html>proxy failure</html>', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'content-type': 'text/html' },
    }),
  });

  await assert.rejects(
    api.getCommit('abc123'),
    (error) => {
      assert.equal(error.name, 'ReleaseError');
      assert.equal(error.code, 'GITHUB_API_ERROR');
      assert.equal(error.status, 502);
      assert.match(error.message, /returned non-JSON with 502/);
      assert.equal(error.details.responseBody, '<html>proxy failure</html>');
      return true;
    },
  );
});
