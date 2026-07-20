/**
 * Reader — /c/:campaignId/compendium/:entryId.
 * Mirrors design/claude-design/Campfire.dc.html "Reader" (~1338-1367): entry
 * title, type/license tags, markdown body, back affordance. The design's
 * chapter TOC and prev/next are meaningful for long rulebook chapters; this
 * pass renders a single entry (no chapter graph in the BUILD spec's API
 * shape) with just the back link. RuleEntry only carries packId, so the
 * owning pack (for name + license) is resolved from GET /rules/packs.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, API } from '../../lib/api';
import type { RuleEntry, RulePack } from '@campfire/schema';
import { Card, ErrorNote, Skeleton } from '../../components/ui';
import { Markdown } from '../../components/Markdown';

export default function ReaderPage() {
  const { campaignId, entryId } = useParams<{ campaignId: string; entryId: string }>();
  const id = Number(campaignId);
  const navigate = useNavigate();

  const [entry, setEntry] = useState<RuleEntry | null>(null);
  const [pack, setPack] = useState<RulePack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!entryId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [data, packs] = await Promise.all([
          api.get<RuleEntry>(`${API}/rules/entries/${entryId}`),
          api.get<RulePack[]>(`${API}/rules/packs`).catch(() => []),
        ]);
        if (!cancelled) {
          setEntry(data);
          setPack(packs.find((p) => p.id === data.packId) ?? null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Couldn't load this entry.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  return (
    <div className="w-full mx-auto px-5 pt-7 pb-12 flex flex-col gap-3.5" style={{ maxWidth: 900 }}>
      <div className="flex items-center gap-2.5 flex-wrap">
        <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => navigate(`/c/${id}/compendium`)}>
          ← Compendium
        </button>
        <h3 style={{ margin: 0, fontSize: 17 }}>Reader</h3>
        {pack && (
          <span className="tag tag-accent-2" style={{ fontSize: 9.5 }}>
            {pack.name}{pack.license ? ` · ${pack.license}` : ''}
          </span>
        )}
      </div>

      {loading ? (
        <Card>
          <Skeleton lines={6} />
        </Card>
      ) : error ? (
        <ErrorNote message={error} />
      ) : !entry ? (
        <ErrorNote message="Entry not found." />
      ) : (
        <div className="card elev-sm" style={{ minWidth: 0, padding: '22px 26px', gap: 12 }}>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 style={{ margin: 0, fontFamily: 'var(--font-heading)' }}>{entry.name}</h3>
            <span className="tag tag-neutral" style={{ fontSize: 9.5 }}>{entry.type}</span>
          </div>
          {/* Older imports stored literal escape sequences (backslash-n) that break
              markdown tables/paragraphs; normalise defensively so already-installed
              packs render correctly without a reinstall. */}
          <Markdown>{entry.body.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t')}</Markdown>
          <p className="text-muted" style={{ margin: 0, fontSize: 11, borderTop: '1px solid var(--color-divider)', paddingTop: 12 }}>
            From {pack?.name ?? 'the installed rule system'}.
          </p>
        </div>
      )}
    </div>
  );
}
