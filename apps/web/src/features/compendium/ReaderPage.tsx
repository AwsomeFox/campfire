import { useTranslation } from 'react-i18next';
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
import { api, API, translateApiError } from '../../lib/api';
import type { Character, RuleEntry, RulePack } from '@campfire/schema';
import { Card, ErrorNote, Skeleton, Btn } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { StatBlock, hasMonsterStatblock } from '../../components/StatBlock';
import { GameIcon } from '../../components/GameIcon';
import { IconPicker } from '../../components/IconPicker';
import { ruleEntryIconSlug } from '../../lib/ruleEntryIcon';
import { useCampaign } from '../../app/CampaignContext';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { PageTitle } from '../../components/PageTitle';
import {
  COMPENDIUM_SOURCE_COPIED_LABEL,
  COMPENDIUM_SOURCE_COPY_LABEL,
  resolveCompendiumSource,
} from './compendiumProvenance';

export default function ReaderPage() {
  const { t } = useTranslation();
  const { campaignId, entryId } = useParams<{ campaignId: string; entryId: string }>();
  const id = Number(campaignId);
  const navigate = useNavigate();
  // Resolve the statblock adapter from the active campaign's rule system (issue #234),
  // not the 5e default baked in at the call site.
  const ruleSystem = useCampaign(Number.isFinite(id) ? id : undefined)?.ruleSystem ?? null;
  // Only the DM (of this campaign) may set an entry's icon override (issue #305) — the
  // PATCH is server-side gated to admin/DM too; this just hides the control for players.
  const { isDm, canDmWrite, canPlayerWrite } = useCampaignAccess();

  const [entry, setEntry] = useState<RuleEntry | null>(null);
  const [pack, setPack] = useState<RulePack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickingIcon, setPickingIcon] = useState(false);
  const [savingIcon, setSavingIcon] = useState(false);
  const [iconError, setIconError] = useState<string | null>(null);
  const [acquiring, setAcquiring] = useState(false);
  const [acquireError, setAcquireError] = useState<string | null>(null);
  const [owners, setOwners] = useState<Character[]>([]);
  const [ownerId, setOwnerId] = useState('party');
  const [qty, setQty] = useState('1');
  const [notes, setNotes] = useState('');

  async function saveIcon(slug: string) {
    if (!entry) return;
    setPickingIcon(false);
    setSavingIcon(true);
    setIconError(null);
    try {
      const updated = await api.patch<RuleEntry>(`${API}/rules/entries/${entry.id}`, { iconSlug: slug });
      setEntry(updated);
    } catch (err) {
      setIconError(translateApiError(err, t, { fallbackKey: 'compendium.errors.updateIcon' }));
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
        if (!cancelled) setError(translateApiError(err, t, { fallbackKey: 'compendium.errors.loadEntry' }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  useEffect(() => { if (acquiring) void api.get<Character[]>(`${API}/campaigns/${id}/characters`).then(setOwners).catch(() => setOwners([])); }, [acquiring, id]);

  async function acquire(duplicateMode: 'confirm' | 'increment' | 'separate' = 'confirm') {
    if (!entry) return;
    try {
      setAcquireError(null);
      await api.post(`${API}/campaigns/${id}/inventory/from-compendium`, { ruleEntryId: entry.id, ownerType: ownerId === 'party' ? 'party' : 'character', characterId: ownerId === 'party' ? null : Number(ownerId), qty: Math.max(1, Number(qty) || 1), notes, duplicateMode });
      setAcquiring(false); navigate(`/c/${id}/inventory`);
    } catch (err) {
      const code = err instanceof Error && 'body' in err ? (err as any).body?.code : '';
      setAcquireError(code === 'INVENTORY_COMPENDIUM_DUPLICATE' ? 'That item is already here. Choose increment or create a separate copy.' : translateApiError(err, t, { fallbackKey: 'inventory.errors.load' }));
    }
  }

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message={t('common.noCampaign')} />
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
        <ErrorNote message={t('compendium.notFound')} />
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
            {entry.type === 'item' && canPlayerWrite && <Btn className="!min-h-0 !py-1.5 text-xs" onClick={() => setAcquiring(true)}>Add to inventory</Btn>}
            {isDm && canDmWrite && (
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
            <StatBlock data={entry.dataJson} ruleSystem={ruleSystem} headingLevel={2} />
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
      {acquiring && entry && (
        <div className="modal-backdrop"><Card className="max-w-md w-full space-y-3"><h2>Add {entry.name} to inventory</h2>
          <label>Owner <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}><option value="party">Party stash</option>{owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}</select></label>
          <label>Quantity <input value={qty} type="number" min="1" onChange={(e) => setQty(e.target.value)} /></label>
          <label>Notes <textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          {acquireError && <ErrorNote message={acquireError} />}
          <div className="flex gap-2"><Btn onClick={() => void acquire()}>Add</Btn>{acquireError?.startsWith('That item') && <><Btn ghost onClick={() => void acquire('increment')}>Increment existing</Btn><Btn ghost onClick={() => void acquire('separate')}>Create separate</Btn></>}<Btn ghost onClick={() => setAcquiring(false)}>Cancel</Btn></div>
        </Card></div>
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
