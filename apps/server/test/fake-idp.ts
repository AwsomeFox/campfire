import express from 'express';
import type { Server } from 'node:http';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

/**
 * Minimal fake OIDC identity provider for e2e tests, run in-process on an
 * ephemeral port. Implements just enough of the spec for openid-client v6's
 * discovery + authorization_code + PKCE flow to succeed against it:
 *   GET /.well-known/openid-configuration
 *   GET /authorize   (immediately redirects back to redirect_uri with ?code&state — no real login UI)
 *   POST /token       (returns a real RS256-signed id_token, matching /jwks)
 *   GET /jwks
 *
 * openid-client validates the id_token signature against the issuer's JWKS,
 * so tokens must be real RS256 JWTs. This file deliberately uses ONLY
 * node:crypto (no `jose`): a dynamic ESM import here raced Jest's
 * environment teardown under --experimental-vm-modules ("Test environment
 * has been torn down"), consistently on CI runners. Node's crypto can
 * generate the keypair, export the JWK, and sign RS256 natively.
 */
export interface FakeIdpUser {
  sub: string;
  preferred_username?: string;
  email?: string;
  name?: string;
  groups?: string[];
}

export interface FakeIdp {
  issuer: string;
  server: Server;
  /** Queues the claims to return for the next /authorize -> /token round trip. Keyed by the `code` minted for that request. */
  setNextUser(user: FakeIdpUser): void;
  close(): Promise<void>;
}

const b64url = (input: Buffer | string): string =>
  (typeof input === 'string' ? Buffer.from(input) : input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function signRs256Jwt(payload: Record<string, unknown>, privateKey: KeyObject, kid: string): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${b64url(signer.sign(privateKey))}`;
}

export async function startFakeIdp(): Promise<FakeIdp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const jwk = publicKey.export({ format: 'jwk' }); // { kty, n, e }
  const publicJwks = { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };

  let nextUser: FakeIdpUser = { sub: 'default-sub', preferred_username: 'defaultuser', email: 'default@example.com', name: 'Default User' };
  const pendingCodes = new Map<string, FakeIdpUser>();

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  let issuer = '';

  app.get('/.well-known/openid-configuration', (_req, res) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      userinfo_endpoint: `${issuer}/userinfo`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'profile', 'email', 'groups'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
    });
  });

  app.get('/jwks', (_req, res) => {
    res.json(publicJwks);
  });

  // No real login screen: immediately "authenticates" as whatever setNextUser() queued and redirects back.
  app.get('/authorize', (req, res) => {
    const { redirect_uri, state } = req.query as Record<string, string>;
    const code = `code-${Math.random().toString(36).slice(2)}`;
    pendingCodes.set(code, nextUser);
    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  app.post('/token', (req, res) => {
    const { code } = req.body as Record<string, string>;
    const user = pendingCodes.get(code);
    if (!user) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
    pendingCodes.delete(code);

    const now = Math.floor(Date.now() / 1000);
    const idToken = signRs256Jwt(
      {
        iss: issuer,
        aud: (req.body as Record<string, string>).client_id ?? 'test-client',
        sub: user.sub,
        preferred_username: user.preferred_username,
        email: user.email,
        name: user.name,
        groups: user.groups ?? [],
        iat: now,
        exp: now + 300,
      },
      privateKey,
      kid,
    );

    res.json({
      access_token: `access-${Math.random().toString(36).slice(2)}`,
      token_type: 'Bearer',
      expires_in: 300,
      id_token: idToken,
    });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake IdP');
  issuer = `http://127.0.0.1:${address.port}`;

  return {
    issuer,
    server,
    setNextUser(user: FakeIdpUser) {
      nextUser = user;
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
