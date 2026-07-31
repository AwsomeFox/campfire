import { useTranslation } from 'react-i18next';
/**
 * Public read-only recap view — the page behind a DM-minted share link
 * (/share/:token). Renders without an account: fetches the unauthenticated
 * GET /shared/recaps/:token endpoint and shows campaign name + one session
 * recap. Standalone route (outside AuthedLayout) so no login redirect and no
 * app chrome — an absent player just opens the link.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { SharedRecap } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { formatDate as formatLocaleDate, useFormattingLocale } from '../../lib/format';
import { Card, Skeleton, ErrorNote } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { PrintControl } from '../../components/PrintControl';
import { GameIcon } from '../../components/GameIcon';
import { PageTitle } from '../../components/PageTitle';
import { useAuth } from '../../app/auth';
import { loginHrefWithReturn } from '../../lib/safeInternalPath';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

export default function SharedRecapPage() {
  const { t } = useTranslation();
  useFormattingLocale();
  const { me, ready: authReady } = useAuth();
  const { token } = useParams<{ token: string }>();
  const [recap, setRecap] = useState<SharedRecap | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const unavailableHeadingRef = useRef<HTMLHeadingElement>(null);
  const sharePath = token ? `/share/${token}` : '/share';
  const signInHref = loginHrefWithReturn(sharePath);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      setNotFound(false);
      setRecap(null);
      try {
        const data = await api.get<SharedRecap>(`${API}/shared/recaps/${token}`);
        if (!cancelled) setRecap(data);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setNotFound(true);
        } else {
          setError(t('sessions.errors.loadRecapRetry'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (token) void load();
    return () => {
      cancelled = true;
    };
  }, [token, t, reloadKey]);

  useEffect(() => {
    if (!loading && notFound) {
      unavailableHeadingRef.current?.focus();
    }
  }, [loading, notFound]);

  return (
    <main className="max-w-3xl mx-auto px-4 py-8 space-y-4">
      <header className="flex items-baseline gap-2.5 flex-wrap">
        <span className="font-heading text-lg" style={{ color: 'var(--color-accent)' }}>
          <GameIcon slug="campfire" size={UI_ICON_SIZE.md} className="inline align-text-bottom mr-1" />Campfire
        </span>
        {recap && <span className="text-muted text-sm">{recap.campaignName}</span>}
        <span className="tag ml-auto">Read-only recap</span>
        {recap && (
          <PrintControl />
        )}
      </header>

      {loading && (
        <>
          <p
            className="text-muted text-sm m-0"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            {t('sessions.empty.shareLoading')}
          </p>
          <Card>
            <Skeleton lines={6} />
          </Card>
        </>
      )}

      {!loading && notFound && (
        <Card>
          <section
            className="text-center space-y-3"
            data-testid="shared-recap-unavailable"
          >
            <div
              role="alert"
              aria-labelledby="shared-recap-unavailable-title"
              aria-describedby="shared-recap-unavailable-hint"
              className="space-y-3"
            >
              <p className="flex justify-center text-slate-400 m-0">
                <GameIcon slug="candle-flame" size={32} reserveSpace />
              </p>
              <h1
                id="shared-recap-unavailable-title"
                ref={unavailableHeadingRef}
                tabIndex={-1}
                className="text-xl font-extrabold text-white m-0"
              >
                {t('sessions.empty.shareInactiveTitle')}
              </h1>
              <p id="shared-recap-unavailable-hint" className="text-sm text-slate-400 m-0 max-w-md mx-auto">
                {t('sessions.empty.shareInactiveHint')}
              </p>
            </div>
            <div className="flex flex-col gap-2 pt-1 max-w-sm mx-auto">
              <Link
                to="/"
                className="btn btn-primary btn-block"
                style={{ minHeight: 44 }}
              >
                {t('sessions.empty.shareInactiveHome')}
              </Link>
              {authReady && !me && (
                <Link
                  to={signInHref}
                  className="btn btn-secondary btn-block"
                  style={{ minHeight: 44 }}
                >
                  {t('sessions.empty.shareInactiveSignIn')}
                </Link>
              )}
            </div>
          </section>
        </Card>
      )}

      {!loading && error && (
        <ErrorNote message={error} onRetry={() => setReloadKey((key) => key + 1)} />
      )}

      {!loading && recap && (
        <div className="space-y-3">
          <div className="flex items-baseline gap-2.5 flex-wrap">
            <span className="tag tag-accent">Session {recap.sessionNumber}</span>
            <PageTitle className="text-xl text-white m-0" style={{ fontSize: 'inherit' }}>
              {recap.title || 'Untitled session'}
            </PageTitle>
            <span className="text-muted text-xs">{formatDate(recap.playedAt)}</span>
          </div>
          <Card>
            {recap.recap ? <Markdown>{recap.recap}</Markdown> : <p className="text-sm text-secondary">No recap written yet.</p>}
          </Card>
          <p className="text-[11px] text-secondary">
            Shared from a Campfire campaign. This page is read-only — no account needed.
          </p>
        </div>
      )}
    </main>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Undated';
  if (Number.isNaN(new Date(iso).getTime())) return 'Undated';
  // Pass the raw string (not a pre-parsed Date) so date-only values like
  // `2026-07-21` get calendar treatment in formatLocaleDate (issue #267).
  return formatLocaleDate(iso, { month: 'short', day: 'numeric', year: 'numeric' });
}
