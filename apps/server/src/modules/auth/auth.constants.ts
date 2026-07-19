export const SESSION_COOKIE_NAME = 'campfire_session';
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_SLIDING_UPDATE_INTERVAL_MS = 60 * 60 * 1000; // update lastSeenAt at most once/hour
export const VERSION = '0.1.0';

/** Holds `state:codeVerifier` for the duration of the OIDC redirect round-trip. */
export const OIDC_FLOW_COOKIE_NAME = 'campfire_oidc_flow';
export const OIDC_FLOW_COOKIE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes — login -> callback should be fast
