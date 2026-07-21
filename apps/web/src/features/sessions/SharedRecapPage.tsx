/**
 * Public read-only recap view — the page behind a DM-minted share link
 * (/share/:token). Renders without an account: fetches the unauthenticated
 * GET /shared/recaps/:token endpoint and shows campaign name + one session
 * recap. Standalone route (outside AuthedLayout) so no login redirect and no
 * app chrome — an absent player just opens the link.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { SharedRecap } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { formatDate as formatLocaleDate } from '../../lib/format';
import { Card, EmptyState, Skeleton, ErrorNote } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { GameIcon } from '../../components/GameIcon';

export default function SharedRecapPage() {
  const { token } = useParams<{ token: string }>();
  const [recap, setRecap] = useState<SharedRecap | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      setNotFound(false);
      try {
        const data = await api.get<SharedRecap>(`${API}/shared/recaps/${token}`);
        if (!cancelled) setRecap(data);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setNotFound(true);
        } else {
          setError("Couldn't load this recap. Try again in a moment.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (token) void load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-4">
      <header className="flex items-baseline gap-2.5 flex-wrap">
        <span className="font-heading text-lg" style={{ color: 'var(--color-accent)' }}>
          <GameIcon slug="campfire" size={18} className="inline align-text-bottom mr-1" />Campfire
        </span>
        {recap && <span className="text-muted text-sm">{recap.campaignName}</span>}
        <span className="tag ml-auto">Read-only recap</span>
      </header>

      {loading && (
        <Card>
          <Skeleton lines={6} />
        </Card>
      )}

      {!loading && notFound && (
        <Card>
          <EmptyState
            icon="candle-flame"
            title="This share link is no longer active"
            hint="It may have been revoked, or the recap was removed. Ask your DM for a fresh link."
          />
        </Card>
      )}

      {!loading && error && <ErrorNote message={error} />}

      {!loading && recap && (
        <div className="space-y-3">
          <div className="flex items-baseline gap-2.5 flex-wrap">
            <span className="tag tag-accent">Session {recap.sessionNumber}</span>
            <h1 className="text-xl font-extrabold text-white m-0">{recap.title || 'Untitled session'}</h1>
            <span className="text-muted text-xs">{formatDate(recap.playedAt)}</span>
          </div>
          <Card>
            {recap.recap ? <Markdown>{recap.recap}</Markdown> : <p className="text-sm text-slate-600">No recap written yet.</p>}
          </Card>
          <p className="text-[11px] text-slate-500">
            Shared from a Campfire campaign. This page is read-only — no account needed.
          </p>
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Undated';
  if (Number.isNaN(new Date(iso).getTime())) return 'Undated';
  // Pass the raw string (not a pre-parsed Date) so date-only values like
  // `2026-07-21` get calendar treatment in formatLocaleDate (issue #267).
  return formatLocaleDate(iso, { month: 'short', day: 'numeric', year: 'numeric' });
}
