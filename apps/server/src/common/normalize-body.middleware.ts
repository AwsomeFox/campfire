/**
 * Normalize a MISSING request body to `{}` (issue #580).
 *
 * body-parser 1.x ran `req.body = req.body || {}` before its has-a-body check, so a POST
 * carrying no payload reached the handler as an empty object. body-parser 2.x — which
 * arrived with express 5 — instead assigns `req.body = undefined` (see its `read.js`).
 *
 * Every DTO here is a zod OBJECT schema, and zod rejects `undefined` against an object.
 * So under 2.x, any endpoint whose body is entirely optional 400s with a bare "Validation
 * failed" the moment a client posts nothing — even though posting nothing is exactly what
 * the endpoint is designed to accept. Both of this app's own clients do that routinely:
 * `api.post(url)` omits body AND content-type when there is no payload, and a plain
 * `fetch(url, { method: 'POST' })` does the same.
 *
 * Restoring the 1.x semantic once, here, fixes the whole class. The alternative — a
 * `.default({})` on every present and future optional-body DTO — is a rule someone has to
 * remember, and the failure mode when they forget is a dead endpoint in production that a
 * green test suite will not catch (the tests ran on the other parser until this issue).
 *
 * Safe by construction: it only ever replaces `undefined`, so no request that currently
 * succeeds changes shape. A body with REQUIRED fields still fails validation — it just
 * reports the missing fields instead of rejecting the whole body.
 */
export function normalizeMissingBody(req: { body?: unknown }, _res: unknown, next: () => void): void {
  if (req.body === undefined) req.body = {};
  next();
}
