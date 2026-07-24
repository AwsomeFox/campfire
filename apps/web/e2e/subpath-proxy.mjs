/**
 * Issue #798 — a tiny reverse-proxy that STRIPS a path prefix before forwarding,
 * modeling the production deployment contract ("strip prefix, then forward")
 * for the subpath E2E suite.
 *
 * Browser -> http://127.0.0.1:<proxyPort>/campfire/...
 *         -> this proxy strips /campfire
 *         -> forwards to http://127.0.0.1:<backendPort>/...
 *
 * The SPA served by the backend was BUILT with PUBLIC_BASE=/campfire, so its
 * asset URLs, manifest, SW, router basename, and API client all emit
 * /campfire-prefixed paths. The browser fetches those prefixed URLs, the proxy
 * strips the prefix, and the backend serves from root — exactly the production
 * topology minus TLS. This lets the E2E assert the full stack works end-to-end
 * under a subpath without standing up Traefik/Caddy/nginx.
 *
 * Deliberately dependency-free (Node's built-in http) so it adds nothing to the
 * install footprint and starts in milliseconds.
 */
import { createServer, request as httpRequest } from 'node:http';

const BACKEND_PORT = Number(process.env.CAMPFIRE_SUBPATH_BACKEND_PORT || 8131);
const PROXY_PORT = Number(process.env.CAMPFIRE_SUBPATH_PROXY_PORT || 8132);
const PREFIX = '/campfire';

const server = createServer((clientReq, clientRes) => {
  // Strip the prefix from the URL. The browser sends /campfire/api/v1/me;
  // the backend needs /api/v1/me.
  const url = clientReq.url || '/';
  let backendUrl;
  if (url === PREFIX || url === PREFIX + '/') {
    backendUrl = '/';
  } else if (url.startsWith(PREFIX + '/')) {
    backendUrl = url.slice(PREFIX.length); // keep the leading /
  } else if (url.startsWith(PREFIX)) {
    // e.g. /campfire?x=1 -> /?x=1
    backendUrl = '/' + url.slice(PREFIX.length);
  } else {
    // A request that didn't come through the prefix — pass it through
    // unchanged so /healthz etc. still work for the webServer.url probe.
    backendUrl = url;
  }

  const headers = { ...clientReq.headers };
  // Reflect the hop so Express's trust proxy (default 1) sees the real client.
  headers['x-forwarded-for'] = headers['x-forwarded-for'] || '127.0.0.1';
  headers['x-forwarded-proto'] = headers['x-forwarded-proto'] || 'http';
  headers['x-forwarded-host'] = headers['host'] || `127.0.0.1:${PROXY_PORT}`;

  const proxyReq = httpRequest(
    {
      hostname: '127.0.0.1',
      port: BACKEND_PORT,
      path: backendUrl,
      method: clientReq.method,
      headers,
    },
    (backendRes) => {
      clientRes.writeHead(backendRes.statusCode || 200, backendRes.headers);
      backendRes.pipe(clientRes);
    },
  );

  proxyReq.on('error', (err) => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'text/plain' });
      clientRes.end(`subpath-proxy: backend error: ${err.message}`);
    }
  });

  clientReq.pipe(proxyReq);
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
  const { port } = server.address();
  // Log so the webServer health probe knows the process is alive.
  console.log(`subpath-proxy listening on http://127.0.0.1:${port} -> http://127.0.0.1:${BACKEND_PORT} (strip ${PREFIX})`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
