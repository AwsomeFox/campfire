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
import { Card, ErrorNote, Skeleton, Btn } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { StatBlock, hasMonsterStatblock } from '../../components/StatBlock';
import { GameIcon } from '../../components/GameIcon';
import { IconPicker } from '../../components/IconPicker';
import { ruleEntryIconSlug } from '../../lib/ruleEntryIcon';
import { useCampaign } from '../../app/CampaignContext';
import { useAuth } from '../../app/auth';
import { PageTitle } from '../../components/PageTitle';
import {
  COMPENDIUM_SOURCE_COPIED_LABEL,
  COMPENDIUM_SOURCE_COPY_LABEL,
  resolveCompendiumSource,
} from './compendiumProvenance';

export default function ReaderPage() {
  const { campaignId, entryId } = useParams<{ campaignId: string; entryId: string }>();
  const id = Number(campaignId);
  const navigate = useNavigate();
  // Resolve the statblock adapter from the active campaign's rule system (issue #234),
  // not the 5e default baked in at the call site.
  const ruleSystem = useCampaign(Number.isFinite(id) ? id : undefined)?.ruleSystem ?? null;
  // Only the DM (of this campaign) may set an entry's icon override (issue #305) — the
  // PATCH is server-side gated to admin/DM too; this just hides the control for players.
  const { roleIn } = useAuth();
  const isDm = Number.isFinite(id) && roleIn(id) === 'dm';

  const [entry, setEntry] = useState<RuleEntry | null>(null);
  const [pack, setPack] = useState<RulePack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickingIcon, setPickingIcon] = useState(false);
  const [savingIcon, setSavingIcon] = useState(false);
  const [iconError, setIconError] = useState<string | null>(null);

  async function saveIcon(slug: string) {
    if (!entry) return;
    setPickingIcon(false);
    setSavingIcon(true);
    setIconError(null);
    try {
      const updated = await api.patch<RuleEntry>(`${API}/rules/entries/${entry.id}`, { iconSlug: slug });
      setEntry(updated);
    } catch (err) {
      setIconError(err instanceof ApiError ? err.message : "Couldn't update the icon.");
    } finally {
      setSavingIcon(false);
    }
  }

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
        {!entry && <PageTitle style={{ margin: 0, fontSize: 17 }}>Reader</PageTitle>}
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
          <div className="flex items-center gap-2.5 flex-wrap">
            {/* Statblock-title glyph (issue #305): the DM's override, else the
                type/school-derived default. Decorative — the heading names the entry. */}
            <span
              aria-hidden="true"
              style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, color: 'var(--color-accent)' }}
            >
              <GameIcon slug={ruleEntryIconSlug(entry)} size={30} />
            </span>
            <PageTitle style={{ margin: 0 }}>{entry.name}</PageTitle>
            <span className="tag tag-neutral" style={{ fontSize: 9.5 }}>{entry.type}</span>
            {isDm && (
              <span className="flex items-center gap-1.5" style={{ marginLeft: 'auto' }}>
                <Btn ghost className="!min-h-0 !py-1.5 text-xs" disabled={savingIcon} onClick={() => setPickingIcon(true)}>
                  {savingIcon ? 'Saving…' : entry.iconSlug ? 'Change icon' : 'Set icon'}
                </Btn>
                {entry.iconSlug && (
                  <Btn ghost className="!min-h-0 !py-1.5 text-xs" disabled={savingIcon} onClick={() => saveIcon('')}>
                    Reset
                  </Btn>
                )}
              </span>
            )}
          </div>
          {iconError && <ErrorNote message={iconError} />}
          {/* Monster entries carry an empty `body` — their stats live in `dataJson`
              (issue #142). Render the structured statblock when there's no prose body
              and the JSON has renderable fields; otherwise fall back to the markdown
              body. Older imports stored literal escape sequences (backslash-n) that
              break markdown tables/paragraphs; normalise defensively so
              already-installed packs render correctly without a reinstall. */}
          {entry.body.trim() ? (
            <Markdown>{entry.body.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t')}</Markdown>
          ) : hasMonsterStatblock(entry.dataJson, ruleSystem) ? (
            <StatBlock data={entry.dataJson} ruleSystem={ruleSystem} headingLevel={4} />
          ) : (
            <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>No details available for this entry.</p>
          )}
          <div
            className="text-muted"
            style={{ margin: 0, fontSize: 11, borderTop: '1px solid var(--color-divider)', paddingTop: 12 }}
          >
            {/* Per-entry provenance (issue #734): credit the entry under its OWN license
                rather than the pack's — a pack may mix OGL/ORC/CC entries, and the reader
                previously labelled every entry with the pack license. The entry's effective
                license falls back to the pack's only when the entry didn't carry one
                (older imports, or a uniformly-licensed pack). Attribution/author are shown
                when the source data recorded the credit line the licence obliges. */}
            <p style={{ margin: 0 }}>
              From {entry.source || pack?.name || 'the installed rule system'}
              {entry.source && pack?.name && entry.source !== pack.name ? ` (${pack.name})` : ''}
              {entry.author ? ` · by ${entry.author}` : ''}
              {(entry.license || pack?.license) ? ` · ${entry.license || pack?.license}` : ''}
              {entry.attribution ? `. ${entry.attribution}` : ''}.
            </p>
            {/* Actionable source URL (issue #740): labeled http(s) link + copy, or an
                honest "Source unavailable" — never dead text that implies traceability. */}
            <CompendiumSourceRow entrySourceUrl={entry.sourceUrl} packSourceUrl={pack?.sourceUrl} />
          </div>
        </div>
      )}
      {pickingIcon && entry && (
        <IconPicker value={entry.iconSlug} onSelect={saveIcon} onClose={() => setPickingIcon(false)} />
      )}
    </div>
  );
}

/**
 * Source provenance row (issue #740). Renders a labeled external link when the
 * stored URL is a safe http(s) value, distinguishes entry-specific deep links
 * from the pack/API homepage, and offers copy-link. Missing/malformed/non-http
 * values say "Source unavailable" instead of implying a working upstream.
 */
function CompendiumSourceRow({
  entrySourceUrl,
  packSourceUrl,
}: {
  entrySourceUrl?: string | null;
  packSourceUrl?: string | null;
}) {
  const source = resolveCompendiumSource({ entrySourceUrl, packSourceUrl });
  const [copied, setCopied] = useState(false);

  if (source.unavailable) {
    return <p style={{ margin: '6px 0 0' }}>{source.label}</p>;
  }

  // Capture narrowed fields so the copy closure keeps `string` (TS does not
  // carry early-return narrowing into nested function declarations).
  const href = source.href;
  const label = source.label;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the href is still selectable via the link */
    }
  }

  return (
    <p style={{ margin: '6px 0 0' }}>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="underline"
        style={{ color: 'inherit' }}
        title={href}
      >
        {label} ↗
      </a>
      {' · '}
      <button
        type="button"
        onClick={copyLink}
        title="Copy source URL"
        className="underline"
        style={{ background: 'transparent', border: 0, padding: 0, font: 'inherit', cursor: 'pointer', color: 'inherit' }}
      >
        {copied ? COMPENDIUM_SOURCE_COPIED_LABEL : COMPENDIUM_SOURCE_COPY_LABEL}
      </button>
    </p>
  );
}
