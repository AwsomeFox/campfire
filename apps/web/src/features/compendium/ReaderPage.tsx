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
import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import { api, API, ApiError, translateApiError } from '../../lib/api';
import type { Character, RuleEntry, RulePack } from '@campfire/schema';
import { Card, ErrorNote, Skeleton, Btn } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { StatBlock, hasMonsterStatblock } from '../../components/StatBlock';
import { GameIcon } from '../../components/GameIcon';
import { IconPicker } from '../../components/IconPicker';
import { useDialog } from '../../components/useDialog';
import { ruleEntryIconSlug } from '../../lib/ruleEntryIcon';
import { useCampaign } from '../../app/CampaignContext';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { useAuth } from '../../app/auth';
import { PageTitle } from '../../components/PageTitle';
import {
  COMPENDIUM_SOURCE_COPIED_LABEL,
  COMPENDIUM_SOURCE_COPY_LABEL,
  resolveCompendiumSource,
} from './compendiumProvenance';
import { ruleEntryIconEndpoint, serializeHomebrewEditor } from './homebrewEditor';

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
  const { me } = useAuth();

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
  const acquireTitleId = useId();
  const [revisions, setRevisions] = useState<Array<{ id: number; createdAt: string; actor: string }> | null>(null);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editName, setEditName] = useState('');
  const [editDataJson, setEditDataJson] = useState('{}');
  const [editRaw, setEditRaw] = useState(true);
  const [editStructured, setEditStructured] = useState<Record<string, string>>({});
  const [editSlug, setEditSlug] = useState('');
  const [editType, setEditType] = useState('other');
  const [editRights, setEditRights] = useState('private_original');
  const [editLicense, setEditLicense] = useState('');
  const [editAttribution, setEditAttribution] = useState('');
  const [editAuthor, setEditAuthor] = useState('');
  const [editSourceUrl, setEditSourceUrl] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  async function saveIcon(slug: string) {
    if (!entry) return;
    setPickingIcon(false);
    setSavingIcon(true);
    setIconError(null);
    try {
      const updated = await api.patch<RuleEntry>(ruleEntryIconEndpoint(API, id, entry), entry.campaignId ? { iconSlug: slug, expectedUpdatedAt: entry.updatedAt } : { iconSlug: slug });
      setEntry(updated);
    } catch (err) {
      setIconError(translateApiError(err, t, { fallbackKey: 'compendium.errors.updateIcon' }));
    } finally {
      setSavingIcon(false);
    }
  }
  async function duplicateHomebrew() { if (!entry) return; setActing(true); setActionError(null); try { const copy = await api.post<RuleEntry>(`${API}/campaigns/${id}/homebrew/${entry.id}/duplicate`, {}); navigate(`/c/${id}/compendium/${copy.id}`); } catch (err) { setActionError(translateApiError(err, t, { fallbackKey: 'compendium.errors.loadEntry' })); } finally { setActing(false); } }
  async function archiveHomebrew() { if (!entry) return; setActing(true); setActionError(null); try { await api.post(`${API}/campaigns/${id}/homebrew/${entry.id}/archive`, {}); navigate(`/c/${id}/compendium`); } catch (err) { setActionError(translateApiError(err, t, { fallbackKey: 'compendium.errors.loadEntry' })); } finally { setActing(false); } }
  async function showRevisions() { if (!entry) return; setActing(true); setActionError(null); try { setRevisions(await api.get(`${API}/campaigns/${id}/homebrew/${entry.id}/revisions`)); } catch (err) { setActionError(translateApiError(err, t, { fallbackKey: 'compendium.errors.loadEntry' })); } finally { setActing(false); } }
  async function copyToLibrary() {
    if (!entry) return;
    setActing(true);
    setActionError(null);
    try {
      let statblockObj: Record<string, unknown> = {};
      try {
        statblockObj = JSON.parse(entry.dataJson || '{}');
      } catch {
        statblockObj = { name: entry.name };
      }
      await api.post(`${API}/campaigns/${id}/library/monsters`, {
        name: entry.name,
        statblock: statblockObj,
        sourceRuleEntryId: entry.id,
      });
      navigate(`/c/${id}/compendium`);
    } catch (err) {
      setActionError(translateApiError(err, t, { fallbackKey: 'compendium.errors.loadEntry' }));
    } finally {
      setActing(false);
    }
  }
  async function saveEdit() { if (!entry) return; setSavingEdit(true); setEditError(null); try { const serialized = serializeHomebrewEditor({ name: editName, slug: editSlug, type: editType, summary: editSummary, body: editBody, rightsStatus: editRights, license: editLicense, attribution: editAttribution, author: editAuthor, sourceUrl: editSourceUrl, dataJson: editDataJson }, editStructured, editRaw); if (!serialized.ok) { setEditError(serialized.error); return; } const payload = { ...serialized.value, expectedUpdatedAt: entry.updatedAt }; const updated = await api.patch<RuleEntry>(`${API}/campaigns/${id}/homebrew/${entry.id}${isDm ? '' : '?proposed=true'}`, payload); if (isDm) setEntry(updated); setEditing(false); } catch (err) { setEditError(translateApiError(err, t, { fallbackKey: 'compendium.errors.loadEntry' })); } finally { setSavingEdit(false); } }

  useEffect(() => {
    if (!entryId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [data, packs] = await Promise.all([
          // Campaign route is the privacy boundary for homebrew. It returns no
          // cross-campaign/private entry by id; global entries retain the legacy
          // reader fallback below for installed packs.
          api.get<RuleEntry>(`${API}/campaigns/${id}/homebrew/${entryId}`).catch((err: unknown) => {
            if (err instanceof ApiError && err.status === 404) return api.get<RuleEntry>(`${API}/rules/entries/${entryId}`);
            throw err;
          }),
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

  useEffect(() => { if (acquiring) void api.get<Character[]>(`${API}/campaigns/${id}/characters`).then((all) => setOwners(isDm ? all : all.filter((owner) => owner.ownerUserId === String(me?.user.id ?? '')))).catch(() => setOwners([])); }, [acquiring, id, isDm, me?.user.id]);

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
          ← {t('nav.compendium')}
        </button>
        {!entry && <PageTitle style={{ margin: 0, fontSize: 17 }}>{t('compendium.readerTitle')}</PageTitle>}
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
        <Card density="compact" elev="sm" style={{ minWidth: 0, padding: '22px 26px', gap: 12 }}>
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
            {entry.type === 'item' && canPlayerWrite && <Btn density="xs" className="text-xs" onClick={() => setAcquiring(true)}>Add to inventory</Btn>}
            {isDm && canDmWrite && (
              <span className="flex items-center gap-1.5" style={{ marginLeft: 'auto' }}>
                <Btn density="xs" ghost className="text-xs" disabled={savingIcon} onClick={() => setPickingIcon(true)}>
                  {savingIcon ? 'Saving…' : entry.iconSlug ? 'Change icon' : 'Set icon'}
                </Btn>
                {entry.iconSlug && (
                  <Btn density="xs" ghost className="text-xs" disabled={savingIcon} onClick={() => saveIcon('')}>
                    Reset
                  </Btn>
                )}
              </span>
            )}
            {!entry.campaignId && isDm && canDmWrite && (
              <span className="flex gap-1.5" style={{ marginLeft: 'auto' }}>
                <Btn density="xs" ghost className="text-xs" disabled={acting} onClick={copyToLibrary}>
                  Copy into my library
                </Btn>
              </span>
            )}
            {entry.campaignId && <span className="flex gap-1.5" style={{ marginLeft: 'auto' }}><Btn density="xs" ghost className="text-xs" disabled={acting} onClick={() => { const parsed = (() => { try { return JSON.parse(entry.dataJson ?? '{}') as Record<string, unknown>; } catch { return {}; } })(); setEditBody(entry.body); setEditName(entry.name); setEditSummary(entry.summary); setEditSlug(entry.slug); setEditType(entry.type); setEditRights(entry.rightsStatus); setEditLicense(entry.license); setEditAttribution(entry.attribution); setEditAuthor(entry.author); setEditSourceUrl(entry.sourceUrl); setEditDataJson(entry.dataJson ?? '{}'); setEditStructured(Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]))); setEditing(true); }}>{isDm && canDmWrite ? 'Edit' : 'Propose edit'}</Btn>{isDm && canDmWrite && <><Btn density="xs" ghost className="text-xs" disabled={acting} onClick={duplicateHomebrew}>Duplicate</Btn><Btn density="xs" ghost className="text-xs" disabled={acting} onClick={archiveHomebrew}>Archive</Btn><Btn density="xs" ghost className="text-xs" disabled={acting} onClick={showRevisions}>Revisions</Btn></>}</span>}
          </div>
          {iconError && <ErrorNote message={iconError} />}
          {actionError && <ErrorNote message={actionError} />}
          {editing && <div className="flex flex-col gap-2"><input className="input" aria-label="Edit homebrew name" value={editName} onChange={(e) => setEditName(e.target.value)} /><input className="input" aria-label="Edit homebrew slug" value={editSlug} onChange={(e) => setEditSlug(e.target.value)} /><select className="input" aria-label="Edit homebrew type" value={editType} onChange={(e) => setEditType(e.target.value)}><option value="spell">Spell</option><option value="monster">Monster</option><option value="item">Item</option><option value="other">Other</option></select><input className="input" aria-label="Edit homebrew summary" value={editSummary} onChange={(e) => setEditSummary(e.target.value)} /><textarea className="input" aria-label="Edit homebrew body" value={editBody} onChange={(e) => setEditBody(e.target.value)} /><label><input type="checkbox" checked={editRaw} onChange={(e) => setEditRaw(e.target.checked)} /> Raw JSON data</label>{editRaw ? <textarea className="input" aria-label="Edit homebrew JSON object" value={editDataJson} onChange={(e) => setEditDataJson(e.target.value)} /> : <div className="flex gap-2 flex-wrap">{(editType === 'spell' ? ['level','school','castingTime','range','duration'] : editType === 'monster' ? ['ac','hp','cr','abilities','actions'] : editType === 'item' ? ['category','rarity','weight','value'] : []).map((key) => <input key={key} className="input" aria-label={`Edit ${key}`} placeholder={key} value={editStructured[key] ?? ''} onChange={(e) => setEditStructured({ ...editStructured, [key]: e.target.value })} />)}</div>}<select className="input" aria-label="Edit rights status" value={editRights} onChange={(e) => setEditRights(e.target.value)}><option value="private_original">Private original</option><option value="permission_granted">Permission granted</option><option value="open_licensed">Open licensed</option></select><input className="input" aria-label="Edit license" value={editLicense} onChange={(e) => setEditLicense(e.target.value)} /><input className="input" aria-label="Edit attribution" value={editAttribution} onChange={(e) => setEditAttribution(e.target.value)} /><input className="input" aria-label="Edit author" value={editAuthor} onChange={(e) => setEditAuthor(e.target.value)} /><input className="input" aria-label="Edit source URL" value={editSourceUrl} onChange={(e) => setEditSourceUrl(e.target.value)} />{editError && <ErrorNote message={editError} />}<Btn onClick={saveEdit} disabled={savingEdit}>{savingEdit ? 'Saving…' : isDm ? 'Save' : 'Submit proposal'}</Btn></div>}
          {revisions && <div className="text-muted" style={{ fontSize: 12 }}>{revisions.map((revision) => <p key={revision.id} style={{ margin: 0 }}>{revision.createdAt} · {revision.actor}</p>)}</div>}
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
        </Card>
      )}
      {pickingIcon && entry && (
        <IconPicker value={entry.iconSlug} onSelect={saveIcon} onClose={() => setPickingIcon(false)} />
      )}
      {acquiring && entry && (
        <AcquireInventoryDialog
          titleId={acquireTitleId}
          entryName={entry.name}
          owners={owners}
          ownerId={ownerId}
          qty={qty}
          notes={notes}
          acquireError={acquireError}
          onOwnerIdChange={setOwnerId}
          onQtyChange={setQty}
          onNotesChange={setNotes}
          onAcquire={(mode) => void acquire(mode)}
          onClose={() => setAcquiring(false)}
        />
      )}
    </div>
  );
}

function AcquireInventoryDialog({
  titleId,
  entryName,
  owners,
  ownerId,
  qty,
  notes,
  acquireError,
  onOwnerIdChange,
  onQtyChange,
  onNotesChange,
  onAcquire,
  onClose,
}: {
  titleId: string;
  entryName: string;
  owners: Character[];
  ownerId: string;
  qty: string;
  notes: string;
  acquireError: string | null;
  onOwnerIdChange: (value: string) => void;
  onQtyChange: (value: string) => void;
  onNotesChange: (value: string) => void;
  onAcquire: (mode?: 'confirm' | 'increment' | 'separate') => void;
  onClose: () => void;
}) {
  const dialogRef = useDialog<HTMLDivElement>({ onClose, inertBackground: true });
  return createPortal(
    <div
      className="dialog-backdrop"
      data-overlay="dialog"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="dialog w-full max-w-md space-y-3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="dialog-title">Add {entryName} to inventory</h2>
        <label>Owner <select value={ownerId} onChange={(e) => onOwnerIdChange(e.target.value)}><option value="party">Party stash</option>{owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}</select></label>
        <label>Quantity <input value={qty} type="number" min="1" onChange={(e) => onQtyChange(e.target.value)} /></label>
        <label>Notes <textarea value={notes} onChange={(e) => onNotesChange(e.target.value)} /></label>
        {acquireError && <ErrorNote message={acquireError} />}
        <div className="flex gap-2 flex-wrap">
          <Btn onClick={() => onAcquire()}>Add</Btn>
          {acquireError?.startsWith('That item') && (
            <>
              <Btn ghost onClick={() => onAcquire('increment')}>Increment existing</Btn>
              <Btn ghost onClick={() => onAcquire('separate')}>Create separate</Btn>
            </>
          )}
          <Btn ghost onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </div>,
    document.body,
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
