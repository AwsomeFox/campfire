/**
 * Admin authentication settings copy (issue #447).
 *
 * The Users → Server settings card must describe current local-login and OIDC
 * behavior accurately — no stale "SSO coming later" promise — and stay aligned
 * with the operator docs in website/docs/administration/authentication.md.
 *
 * Pure source-level suite (pw-unit); no seeded server required.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SETTINGS_CARD = resolve(__dirname, '../../src/features/admin/SettingsCard.tsx');
const OIDC_CARD = resolve(__dirname, '../../src/features/admin/OidcCard.tsx');
const AUTH_DOCS = resolve(__dirname, '../../../../website/docs/administration/authentication.md');

const RETIRED_STALE_SSO_PROMISE = /SSO coming later/i;

function settingsCardSource(): string {
  return readFileSync(SETTINGS_CARD, 'utf8');
}

function authDocsSource(): string {
  return readFileSync(AUTH_DOCS, 'utf8');
}

test.describe('Admin auth settings copy — local login & OIDC (#447)', () => {
  test('removes the stale SSO-coming-later promise', () => {
    const source = settingsCardSource();
    expect(source).not.toMatch(RETIRED_STALE_SSO_PROMISE);
  });

  test('describes OIDC as available and links to Auth configuration/testing', () => {
    const source = settingsCardSource();
    expect(source).toMatch(/OIDC\/SSO/);
    expect(source).toMatch(/to="\/admin\/auth"/);
    expect(source).toMatch(/Test login \(end-to-end\)/);
  });

  test('warns that disabling local sign-in can lock out non-admins', () => {
    const source = settingsCardSource();
    expect(source).toMatch(/lockout/i);
    expect(source).toMatch(/only via OIDC\/SSO/i);
    expect(source).toMatch(/server admins can still sign in locally/i);
  });

  test('stays consistent with operator authentication docs', () => {
    const card = settingsCardSource();
    const oidcCard = readFileSync(OIDC_CARD, 'utf8');
    const docs = authDocsSource();

    // Docs: OIDC is configured from Admin → Auth and needs end-to-end testing first.
    expect(docs).toMatch(/Admin → Auth → OIDC single sign-on/);
    expect(docs).toMatch(/Test login \(end-to-end\)/);
    expect(card).toMatch(/Test login \(end-to-end\)/);

    // Docs + OidcCard: env vars can also configure OIDC — SettingsCard should not
    // imply SSO is unavailable or future-only.
    expect(oidcCard).toMatch(/OIDC_\*/);
    expect(card).not.toMatch(RETIRED_STALE_SSO_PROMISE);

    // Docs: admins retain local login when local sign-in is off for non-admins.
    expect(docs).toMatch(/local accounts/i);
    expect(card).toMatch(/server admins can still sign in locally/i);
  });
});
