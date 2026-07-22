import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OAuthService, type ClientRow, type OAuthTokenResponse } from '../../src/modules/oauth/oauth.service';
import { openDatabase, type DrizzleDb } from '../../src/db/db.module';
import { makeTempDataDir } from './fixtures';

const WORKER = path.resolve(__dirname, '..', 'helpers', 'oauth-race-worker.cjs');
const REDIRECT_URI = 'https://client.example.test/oauth/callback';

interface WorkerResult {
  ok: boolean;
  response: OAuthTokenResponse | { error: string; error_description: string };
}

function challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function runWorker(input: Record<string, unknown>): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, OAUTH_RACE_INPUT: JSON.stringify(input) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`OAuth race worker exited ${code}: ${stderr || stdout}`));
        return;
      }
      const line = stdout.split('\n').find((candidate) => candidate.startsWith('RESULT '));
      if (!line) {
        reject(new Error(`OAuth race worker returned no result: ${stderr || stdout}`));
        return;
      }
      resolve(JSON.parse(line.slice('RESULT '.length)) as WorkerResult);
    });
  });
}

describe('OAuth atomic consumption (real SQLite, separate processes)', () => {
  let dataDir: string;
  let db: ReturnType<typeof openDatabase>;
  let service: OAuthService;
  let client: ClientRow;

  beforeEach(async () => {
    dataDir = makeTempDataDir();
    db = openDatabase(dataDir);
    service = new OAuthService(db.orm as DrizzleDb);
    const now = new Date().toISOString();
    db.sqlite
      .prepare("INSERT INTO users (username, display_name, password_hash, server_role, disabled, created_at, updated_at) VALUES ('oauth-racer', 'OAuth Racer', NULL, 'user', 0, ?, ?)")
      .run(now, now);
    const registered = await service.registerClient({ redirectUris: [REDIRECT_URI] });
    client = (await service.getClient(registered.clientId))!;
  });

  afterEach(() => {
    if (db.sqlite.open) db.sqlite.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function race(kind: 'authorization_code' | 'refresh_token', token: string, extra: Record<string, unknown> = {}) {
    const barrierDir = fs.mkdtempSync(path.join(dataDir, 'barrier-'));
    const common = {
      kind,
      token,
      dataDir,
      barrierDir,
      participantCount: 2,
      clientId: client.clientId,
      ...extra,
    };
    return Promise.all([
      runWorker({ ...common, participantId: 'a' }),
      // Exercise the source-loading fallback used by `test:watch` in the same
      // real cross-process race as the normal compiled-module worker.
      runWorker({ ...common, participantId: 'b', forceSource: true }),
    ]);
  }

  async function freshGrant(): Promise<OAuthTokenResponse> {
    const verifier = 'oauth-race-verifier-with-enough-entropy-0123456789';
    const code = await service.issueAuthorizationCode({
      clientId: client.clientId,
      userId: 1,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge(verifier),
      codeChallengeMethod: 'S256',
      scope: 'mcp dm',
      resource: null,
      roleScope: 'dm',
      campaignId: null,
    });
    return service.exchangeAuthorizationCode({ client, code, codeVerifier: verifier, redirectUri: REDIRECT_URI });
  }

  it('lets exactly one process redeem an authorization code', async () => {
    const verifier = 'authorization-code-race-verifier-0123456789';
    const code = await service.issueAuthorizationCode({
      clientId: client.clientId,
      userId: 1,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge(verifier),
      codeChallengeMethod: 'S256',
      scope: 'mcp dm',
      resource: null,
      roleScope: 'dm',
      campaignId: null,
    });

    const results = await race('authorization_code', code, { verifier, redirectUri: REDIRECT_URI });

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, response: { error: 'invalid_grant', error_description: 'Authorization code not found' } },
    ]);
    expect((db.sqlite.prepare('SELECT COUNT(*) AS count FROM oauth_auth_codes').get() as { count: number }).count).toBe(0);
    expect((db.sqlite.prepare('SELECT COUNT(*) AS count FROM oauth_access_tokens').get() as { count: number }).count).toBe(1);
  });

  it('lets one process rotate a refresh token, then revokes and audits the family on replay', async () => {
    const initial = await freshGrant();

    const results = await race('refresh_token', initial.refresh_token!);

    const winners = results.filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, response: { error: 'invalid_grant', error_description: 'Refresh token not found' } },
    ]);

    const family = db.sqlite
      .prepare('SELECT refresh_consumed_at, revoked_at, family_revoked_at FROM oauth_access_tokens ORDER BY id')
      .all() as Array<{ refresh_consumed_at: string | null; revoked_at: string | null; family_revoked_at: string | null }>;
    expect(family).toHaveLength(2);
    expect(family[0].refresh_consumed_at).not.toBeNull();
    expect(family.every((row) => row.revoked_at !== null && row.family_revoked_at !== null)).toBe(true);
    expect(
      (db.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'oauth.refresh_replay'").get() as { count: number }).count,
    ).toBe(1);

    const winner = winners[0].response as OAuthTokenResponse;
    await expect(service.resolveAccessToken(winner.access_token)).resolves.toBeNull();
  });
});
