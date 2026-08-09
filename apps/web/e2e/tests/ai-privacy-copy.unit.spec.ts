/**
 * Policy-backed external-AI privacy copy test (issue #455).
 *
 * Login used to promise "your data never leaves your server" even though admins can
 * configure OpenAI-compatible or Anthropic providers that receive campaign context.
 * This test imports the canonical `AI_EXTERNAL_PROVIDER_PRIVACY` manifest from
 * @campfire/schema plus the actual login FEATURES/footer copy, and asserts:
 *   1. the retired unqualified promise is gone from every surface;
 *   2. login copy states the local-by-default boundary and external-provider exception;
 *   3. the manifest lists every outbound context category and exclusion;
 *   4. retention / provider responsibility is documented in the manifest (rendered by
 *      AiProviderPrivacyNotice before saving a provider).
 *
 * Pure unit test — no backend — runs under the Playwright `.unit.spec.ts` runner.
 */
import { expect, test } from '@playwright/test';
import { AI_EXTERNAL_PROVIDER_PRIVACY } from '@campfire/schema';
import { FEATURES as LOGIN_FEATURES, LOGIN_FOOTER_TAGLINE } from '../../src/features/auth/LoginPage';

const privacy = AI_EXTERNAL_PROVIDER_PRIVACY;

const RETIRED_UNQUALIFIED_PROMISE = 'your data never leaves your server';

/** Flattened text the AiProviderPrivacyNotice renders from the manifest. */
function privacyNoticeText(): string {
  return [
    privacy.noticeTitle,
    privacy.localByDefault,
    privacy.externalException,
    ...privacy.contextCategories.map((c) => `${c.label} ${c.description}`),
    ...privacy.exclusions,
    privacy.retentionNote,
  ].join(' ');
}

const PRIVACY_SURFACES: ReadonlyArray<{ name: string; text: string }> = [
  {
    name: 'login footer tagline',
    text: LOGIN_FOOTER_TAGLINE,
  },
  {
    name: 'login feature (Self-hosted & private)',
    text: LOGIN_FEATURES.find((f) => f.title === privacy.loginFeatureTitle)?.body ?? '',
  },
  {
    name: 'provider privacy notice (manifest-backed)',
    text: privacyNoticeText(),
  },
];

const contextKeywords = privacy.contextCategories
  .map((c) => c.copyKeyword)
  .filter((k): k is string => k.length > 0);

test.describe('External AI provider privacy copy (#455)', () => {
  test('no surface repeats the retired unqualified "never leaves your server" promise', () => {
    for (const surface of PRIVACY_SURFACES) {
      expect(
        surface.text.toLowerCase(),
        `${surface.name} must not reuse the unqualified promise`,
      ).not.toContain(RETIRED_UNQUALIFIED_PROMISE);
    }
  });

  test('login copy states local-by-default and external-provider exception', () => {
    const tagline = LOGIN_FOOTER_TAGLINE.toLowerCase();
    expect(tagline, 'login tagline must mention local/default storage').toMatch(
      /stays on your server|local|by default/,
    );
    expect(tagline, 'login tagline must mention external AI providers').toMatch(/external ai provider/);

    const featureBody =
      LOGIN_FEATURES.find((f) => f.title === privacy.loginFeatureTitle)?.body.toLowerCase() ?? '';
    expect(featureBody, 'login feature must mention opt-in to external providers').toMatch(
      /external ai provider|opt in/,
    );
    expect(featureBody, 'login feature must mention disclosed context').toMatch(/disclosed|only the/);
  });

  test('provider privacy notice names each context category from the manifest', () => {
    const notice = privacyNoticeText().toLowerCase();
    const missing: string[] = [];
    for (const keyword of contextKeywords) {
      if (!notice.includes(keyword.toLowerCase())) missing.push(keyword);
    }
    expect(
      missing,
      `Provider privacy notice must name every outbound context category; missing: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  test('provider privacy notice requires per-request opt-in for DM-only storyline prep', () => {
    const notice = privacyNoticeText().toLowerCase();
    expect(notice).toContain('storyline');
    expect(notice).toMatch(/opt in per rewrite request|opt in.*storyline rewrite/);
  });

  test('provider privacy notice documents retention and provider responsibility', () => {
    const notice = privacyNoticeText().toLowerCase();
    expect(notice, 'notice must mention retention').toMatch(/retention/);
    expect(notice, 'notice must mention vendor/provider policy').toMatch(/provider|vendor/);
    expect(
      privacy.retentionNote.toLowerCase(),
      'manifest retention note must warn Campfire does not control vendor retention',
    ).toMatch(/does not control/);
  });

  test('manifest lists explicit exclusions and a settings anchor for privacy controls', () => {
    expect(privacy.exclusions.length).toBeGreaterThan(0);
    expect(privacy.exclusions.join(' ').toLowerCase()).toMatch(/api key/);
    expect(privacy.exclusions.join(' ').toLowerCase()).toMatch(/dm-only|secret/);
    expect(privacy.settingsAnchorId).toBe('ai-provider-privacy');
  });
});
