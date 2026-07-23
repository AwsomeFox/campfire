export const SESSION_COOKIE_NAME = 'campfire_session';
/** Idle lifetime: each qualifying activity slides `expiresAt` to now + this. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/**
 * Absolute lifetime from `createdAt`. Sliding idle extension cannot push a
 * session past this — stolen cookies cannot live forever under continuous use.
 */
export const SESSION_ABSOLUTE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
/** Rate-limit for sliding `lastSeenAt` / `expiresAt` writes (and cookie re-issue). */
export const SESSION_SLIDING_UPDATE_INTERVAL_MS = 60 * 60 * 1000; // at most once/hour
/** @deprecated Prefer {@link APP_VERSION} from common/build-metadata — re-exported for existing imports. */
export { APP_VERSION as VERSION } from '../../common/build-metadata';

/** Approved password-reset codes die after this — the admin hands the code to the user out-of-band, so give it a real (but bounded) window. */
export const RESET_CODE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/** Holds `state:codeVerifier` for the duration of the OIDC redirect round-trip. */
export const OIDC_FLOW_COOKIE_NAME = 'campfire_oidc_flow';
/**
 * Optional post-SSO return path (issue #478). Set alongside the flow cookie when
 * `/oidc/login?redirect=` carries a validated in-app path; cleared on callback.
 */
export const OIDC_RETURN_COOKIE_NAME = 'campfire_oidc_return';
export const OIDC_FLOW_COOKIE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes — login -> callback should be fast

/**
 * Admin-only end-to-end OIDC diagnostic flow (issue #848). Cookie value is a
 * random handle referencing server-side pending state — never carries secrets.
 */
export const OIDC_TEST_FLOW_COOKIE_NAME = 'campfire_oidc_test_flow';
export const OIDC_TEST_FLOW_COOKIE_MAX_AGE_MS = 5 * 60 * 1000;
