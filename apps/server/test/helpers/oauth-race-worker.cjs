'use strict';

require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');

const input = JSON.parse(process.env.OAUTH_RACE_INPUT || '{}');

function loadServerModules() {
  const distDb = path.resolve(__dirname, '../../dist/db/db.module.js');
  const distOAuth = path.resolve(__dirname, '../../dist/modules/oauth/oauth.service.js');
  if (!input.forceSource && fs.existsSync(distDb) && fs.existsSync(distOAuth)) {
    return {
      openDatabase: require(distDb).openDatabase,
      OAuthService: require(distOAuth).OAuthService,
    };
  }

  // `test` builds before Jest, while `test:watch` intentionally does not. Keep
  // this cross-process harness usable in both workflows without requiring stale
  // dist output. The schema workspace is already a prerequisite of server tests.
  process.env.TS_NODE_PROJECT ||= path.resolve(__dirname, '../../tsconfig.json');
  require('ts-node/register/transpile-only');
  return {
    openDatabase: require('../../src/db/db.module.ts').openDatabase,
    OAuthService: require('../../src/modules/oauth/oauth.service.ts').OAuthService,
  };
}

const { openDatabase, OAuthService } = loadServerModules();

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function waitForAllReaders(barrierDir, participantCount, participantId) {
  fs.writeFileSync(path.join(barrierDir, `ready-${participantId}`), '');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = fs.readdirSync(barrierDir).filter((name) => name.startsWith('ready-')).length;
    if (ready >= participantCount) return;
    Atomics.wait(sleepCell, 0, 0, 10);
  }
  throw new Error('timed out waiting for the OAuth race barrier');
}

async function main() {
  const opened = openDatabase(input.dataDir);
  const service = new OAuthService(opened.orm);

  const methodName = input.kind === 'authorization_code' ? 'findAuthorizationCode' : 'findRefreshToken';
  const original = service[methodName].bind(service);
  service[methodName] = async (...args) => {
    const row = await original(...args);
    waitForAllReaders(input.barrierDir, input.participantCount, input.participantId);
    return row;
  };

  try {
    const client = await service.getClient(input.clientId);
    if (!client) throw new Error('race fixture client not found');
    const response = input.kind === 'authorization_code'
      ? await service.exchangeAuthorizationCode({
          client,
          code: input.token,
          codeVerifier: input.verifier,
          redirectUri: input.redirectUri,
        })
      : await service.exchangeRefreshToken({ client, refreshToken: input.token });
    process.stdout.write(`RESULT ${JSON.stringify({ ok: true, response })}\n`);
  } catch (error) {
    const response = error && typeof error.getResponse === 'function'
      ? error.getResponse()
      : { error: 'worker_failure', error_description: error instanceof Error ? error.message : String(error) };
    process.stdout.write(`RESULT ${JSON.stringify({ ok: false, response })}\n`);
  } finally {
    opened.sqlite.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
