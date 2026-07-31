import { Card } from '../../components/ui';
import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  OidcRecoveryCategory as OidcRecoveryCategorySchema,
  type OidcRecoveryCategory,
} from '@campfire/schema';
import { useAuthStatus } from '../../app/AuthStatusGate';
import { joinPublicBase } from '../../lib/public-base';
import { BrandMark } from '../../components/BrandMark';

interface RecoveryCopy {
  title: string;
  body: string;
  hint: string;
}

const RECOVERY_COPY: Record<OidcRecoveryCategory, RecoveryCopy> = {
  cancelled: {
    title: 'SSO sign-in was cancelled',
    body: 'Campfire did not create a session or change your account.',
    hint: 'When you are ready, start a new SSO sign-in.',
  },
  flow_expired: {
    title: 'Your sign-in session expired',
    body: 'The short-lived Campfire sign-in flow is missing or no longer valid.',
    hint: 'Start again to create a fresh, secure sign-in flow.',
  },
  state_pkce_mismatch: {
    title: 'Campfire could not verify this sign-in',
    body: 'The security checks for this SSO attempt did not match.',
    hint: 'Close any older sign-in tabs, then start a new SSO sign-in.',
  },
  provider_unavailable: {
    title: 'SSO is unavailable right now',
    body: 'Campfire could not reach or start a sign-in with the identity provider.',
    hint: 'Wait a moment and try again. If it continues, contact your server admin.',
  },
  client_token_failure: {
    title: 'SSO could not complete sign-in',
    body: 'The identity provider and Campfire could not complete the secure sign-in exchange.',
    hint: 'Try a fresh sign-in. Your server admin may need the support reference below.',
  },
  missing_claims: {
    title: 'Your SSO account is missing required information',
    body: 'Campfire did not receive the account information required to sign you in.',
    hint: 'Ask your server admin to check the identity-provider claim configuration.',
  },
  group_denied: {
    title: 'This account is not allowed to sign in',
    body: 'Your SSO account does not currently have access to this Campfire server.',
    hint: 'Ask your server admin about the required sign-in group.',
  },
  account_disabled: {
    title: 'Your Campfire account is disabled',
    body: 'Campfire did not create a session for this account.',
    hint: 'Contact your server admin if you believe the account should be enabled.',
  },
};

const GENERIC_COPY = RECOVERY_COPY.client_token_failure;
const SUPPORT_REFERENCE = /^[A-F0-9]{16}$/;

function safeRecoveryDetails(search: string): { copy: RecoveryCopy; reference: string | null } {
  const params = new URLSearchParams(search);
  const parsedCategory = OidcRecoveryCategorySchema.safeParse(params.get('category'));
  const rawReference = params.get('ref');
  return {
    copy: parsedCategory.success ? RECOVERY_COPY[parsedCategory.data] : GENERIC_COPY,
    reference: rawReference && SUPPORT_REFERENCE.test(rawReference) ? rawReference : null,
  };
}

export function OidcRecoveryPage() {
  const location = useLocation();
  const { status, loading } = useAuthStatus();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { copy, reference } = safeRecoveryDetails(location.search);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <main
      className="min-h-screen w-full grid place-items-center px-4 py-8"
      style={{
        background: 'radial-gradient(90% 55% at 15% 0%, var(--color-neutral-900) 0%, var(--color-bg) 65%)',
      }}
    >
      <Card
        density="compact" elev="md" className="w-full flex flex-col items-center text-center"
        aria-labelledby="oidc-recovery-title"
        aria-describedby="oidc-recovery-body oidc-recovery-hint"
        style={{ maxWidth: 480, padding: 'clamp(24px, 7vw, 38px)', gap: 16 }}
      >
        <BrandMark />
        <div className="flex flex-col gap-2">
          <p className="text-muted" style={{ margin: 0, fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Campfire sign-in
          </p>
          <h1
            id="oidc-recovery-title"
            ref={headingRef}
            tabIndex={-1}
            style={{ margin: 0, fontSize: 'clamp(24px, 7vw, 32px)', lineHeight: 1.15 }}
          >
            {copy.title}
          </h1>
        </div>

        <div className="flex flex-col gap-2" style={{ maxWidth: '42ch' }}>
          <p id="oidc-recovery-body" style={{ margin: 0, lineHeight: 1.55 }}>
            {copy.body}
          </p>
          <p id="oidc-recovery-hint" className="text-muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
            {copy.hint}
          </p>
        </div>

        <div className="w-full flex flex-col gap-3" style={{ marginTop: 4 }}>
          <a
            href={joinPublicBase('/api/v1/auth/oidc/login')}
            className="btn btn-primary btn-block"
            style={{ minHeight: 44 }}
          >
            Try SSO again
          </a>
          {!loading && status?.localLoginEnabled ? (
            <Link
              to="/login?local=1"
              className="btn btn-secondary btn-block"
              style={{ minHeight: 44 }}
            >
              Sign in with username and password
            </Link>
          ) : null}
        </div>

        {reference ? (
          <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 12, lineHeight: 1.5 }}>
            If you contact your server admin, include support reference{' '}
            <code style={{ color: 'var(--color-text)', overflowWrap: 'anywhere' }}>{reference}</code>.
          </p>
        ) : (
          <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 12, lineHeight: 1.5 }}>
            If this keeps happening, contact your server admin. No support reference is available for this attempt.
          </p>
        )}
      </Card>
    </main>
  );
}
