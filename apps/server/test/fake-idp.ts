import express from 'express';
import type { Server } from 'node:http';
import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

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
  /** Controls one authorization round trip, then resets to success. */
  setNextMode(mode: FakeIdpMode): void;
  /** Override the issuer claim/field returned by discovery (for mismatch tests). Null = use the real listen URL. */
  setDiscoveryIssuer(issuer: string | null): void;
  /** Delay discovery responses (ms) — used to exercise probe timeouts. */
  setDiscoveryDelayMs(ms: number): void;
  /** When set, /authorize rejects redirect_uri values outside this allowlist. Null = accept any. */
  setAllowedRedirectUris(uris: string[] | null): void;
  /** Expected client credentials. Defaults to test-client / test-secret. */
  setClient(clientId: string, clientSecret: string): void;
  close(): Promise<void>;
}

export type FakeIdpMode = 'success' | 'cancel' | 'token_error' | 'missing_claims';

interface PendingAuthorization {
  user: FakeIdpUser;
  mode: FakeIdpMode;
  codeChallenge?: string;
  clientId: string;
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
  let nextMode: FakeIdpMode = 'success';
  let discoveryIssuerOverride: string | null = null;
  let discoveryDelayMs = 0;
  let allowedRedirectUris: string[] | null = null;
  let expectedClientId = 'test-client';
  let expectedClientSecret = 'test-secret';
  const pendingCodes = new Map<string, PendingAuthorization>();

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  let issuer = '';

  app.get('/.well-known/openid-configuration', async (_req, res) => {
    if (discoveryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, discoveryDelayMs));
    }
    const discoveryIssuer = discoveryIssuerOverride ?? issuer;
    res.json({
      issuer: discoveryIssuer,
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
    const { redirect_uri, state, code_challenge, client_id } = req.query as Record<string, string>;
    if (client_id && client_id !== expectedClientId) {
      res.status(400).json({ error: 'unauthorized_client' });
      return;
    }
    if (allowedRedirectUris && (!redirect_uri || !allowedRedirectUris.includes(redirect_uri))) {
      res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri not registered' });
      return;
    }
    const mode = nextMode;
    nextMode = 'success';
    const url = new URL(redirect_uri);
    if (state) url.searchParams.set('state', state);
    if (mode === 'cancel') {
      url.searchParams.set('error', 'access_denied');
      url.searchParams.set('error_description', 'PROVIDER_PRIVATE_CANCELLATION_DETAIL');
      res.redirect(url.toString());
      return;
    }
    const code = `code-${Math.random().toString(36).slice(2)}`;
    pendingCodes.set(code, {
      user: nextUser,
      mode,
      codeChallenge: code_challenge,
      clientId: client_id || expectedClientId,
    });
    url.searchParams.set('code', code);
    res.redirect(url.toString());
  });

  app.post('/token', (req, res) => {
    const body = req.body as Record<string, string>;
    // Support client_secret_post and (minimal) client_secret_basic.
    let clientId = body.client_id;
    let clientSecret = body.client_secret;
    const auth = req.headers.authorization;
    if (auth?.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon >= 0) {
        clientId = decoded.slice(0, colon);
        clientSecret = decoded.slice(colon + 1);
      }
    }
    if (clientId !== expectedClientId || clientSecret !== expectedClientSecret) {
      res.status(401).json({
        error: 'invalid_client',
        error_description: 'PROVIDER_PRIVATE_CLIENT_DETAIL',
      });
      return;
    }

    const { code, code_verifier } = body;
    const pending = pendingCodes.get(code);
    if (!pending) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
    pendingCodes.delete(code);
    const actualChallenge = code_verifier
      ? b64url(createHash('sha256').update(code_verifier).digest())
      : '';
    if (pending.codeChallenge && actualChallenge !== pending.codeChallenge) {
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'PROVIDER_PRIVATE_PKCE_DETAIL',
      });
      return;
    }
    if (pending.mode === 'token_error') {
      res.status(401).json({
        error: 'invalid_client',
        error_description: 'PROVIDER_PRIVATE_TOKEN_DETAIL',
      });
      return;
    }
    if (pending.mode === 'missing_claims') {
      res.json({
        access_token: `access-${Math.random().toString(36).slice(2)}`,
        token_type: 'Bearer',
        expires_in: 300,
      });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const user = pending.user;
    const idToken = signRs256Jwt(
      {
        iss: issuer,
        aud: pending.clientId,
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
    setNextMode(mode: FakeIdpMode) {
      nextMode = mode;
    },
    setDiscoveryIssuer(next: string | null) {
      discoveryIssuerOverride = next;
    },
    setDiscoveryDelayMs(ms: number) {
      discoveryDelayMs = ms;
    },
    setAllowedRedirectUris(uris: string[] | null) {
      allowedRedirectUris = uris;
    },
    setClient(clientId: string, clientSecret: string) {
      expectedClientId = clientId;
      expectedClientSecret = clientSecret;
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
