/**
 * Handouts panel (issue #97 — staged reveal of DM-uploaded maps/images).
 *
 * Lists the campaign's attachments via GET /campaigns/:id/attachments (which the
 * server already visibility-filters: a player only ever receives revealed rows).
 *  - DM sees every attachment with a "DM only" / "Revealed" badge and a
 *    Reveal / Hide toggle — the prep→reveal moment. Uploading a map/image here
 *    stages it hidden by default; Reveal shares it with the party.
 *  - Players/viewers see only revealed maps/images (portraits are omitted — those
 *    live on character cards).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import type { Attachment } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { shareInFlightRef } from '../../lib/shareInFlight';
import { Card, Btn, Chip, ErrorNote, Skeleton } from '../../components/ui';
import { ImageUpload, attachmentFileUrl } from '../../components/ImageUpload';
import { GameIcon } from '../../components/GameIcon';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { MapConceptGlossary, MapPurposePreview } from '../../components/mapOnboarding';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

// Kept local until every consumer has rebuilt its generated schema declaration.
type MetadataDraft = Pick<Attachment, 'title' | 'caption' | 'altText' | 'creator' | 'sourceUrl' | 'license' | 'rights' | 'attribution'>;
const blankMetadata: MetadataDraft = { title: '', caption: '', altText: '', creator: '', sourceUrl: '', license: '', rights: '', attribution: '' };
const draftFor = (attachment: Attachment): MetadataDraft => ({ title: attachment.title, caption: attachment.caption, altText: attachment.altText, creator: attachment.creator, sourceUrl: attachment.sourceUrl, license: attachment.license, rights: attachment.rights, attribution: attachment.attribution });

export function HandoutsCard({ campaignId }: { campaignId: number }) {
  const { isDm, canDmWrite } = useCampaignAccess();
  const [items, setItems] = useState<Attachment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [pendingReveal, setPendingReveal] = useState<Attachment | null>(null);
  const [editing, setEditing] = useState<Attachment | null>(null);
  const [draft, setDraft] = useState<MetadataDraft>(blankMetadata);
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [uploadMetadata, setUploadMetadata] = useState<MetadataDraft>(blankMetadata);
  // Concurrent load()/Retry callers share one promise so `await load()` never
  // resolves before the in-flight attachments fetch settles (#691).
  const loadInFlight = useRef<Promise<Attachment[] | null> | null>(null);
  // Tracks which campaign the card is currently bound to so a late response
  // from a previous campaignId cannot overwrite items/error/loading.
  const activeCampaignIdRef = useRef(campaignId);

  const load = useCallback(() => {
    return shareInFlightRef(loadInFlight, async () => {
      const forCampaignId = campaignId;
      setLoading(true);
      try {
        const list = await api.get<Attachment[]>(`${API}/campaigns/${forCampaignId}/attachments`);
        if (activeCampaignIdRef.current !== forCampaignId) return null;
        setItems(list);
        setError(null);
        return list;
      } catch (err) {
        if (activeCampaignIdRef.current !== forCampaignId) return null;
        setError(err instanceof ApiError ? err.message : "Couldn't load handouts.");
        return null;
      } finally {
        if (activeCampaignIdRef.current === forCampaignId) {
          setLoading(false);
        }
      }
    });
  }, [campaignId]);

  useEffect(() => {
    activeCampaignIdRef.current = campaignId;
    // Drop any prior campaign's shared promise so the new campaign never awaits
    // (or applies) the wrong in-flight fetch.
    loadInFlight.current = null;
    void load();
  }, [load, campaignId]);

  async function commitVisibilityToggle(a: Attachment): Promise<boolean> {
    setBusyId(a.id);
    setError(null);
    try {
      await api.post(`${API}/attachments/${a.id}/${a.hidden ? 'reveal' : 'hide'}`);
      await load();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update the handout.");
      return false;
    } finally {
      setBusyId(null);
    }
  }

  function toggleReveal(a: Attachment) {
    if (a.hidden) {
      setPendingReveal(a);
      return;
    }
    void commitVisibilityToggle(a);
  }

  async function saveMetadata() {
    if (!editing) return;
    setSavingMetadata(true); setError(null);
    try {
      await api.patch(`${API}/attachments/${editing.id}/metadata`, { ...draft, updatedAt: editing.updatedAt });
      setEditing(null); await load();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? 'This handout changed elsewhere. Reloaded the latest version; review and save again.' : err instanceof ApiError ? err.message : "Couldn't save handout metadata.");
      if (err instanceof ApiError && err.status === 409) {
        // Refresh the open editor's updatedAt (and row) so Retry can succeed;
        // keep the local draft so the DM can review their pending edits.
        const list = await load();
        const fresh = list?.find((a) => a.id === editing.id) ?? null;
        setEditing(fresh);
      }
    } finally { setSavingMetadata(false); }
  }

  // Players/viewers don't manage portraits here — only shared visual handouts.
  const visible = (items ?? []).filter((a) => (isDm ? true : a.kind !== 'portrait'));

  return (
    <Card density="compact" elev="sm" data-testid="dashboard-handouts" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px' }}>
        <span className="card-kicker">Handouts</span>
        <div style={{ flex: 1 }} />
        {isDm && <span className="text-[11px] text-[var(--color-neutral-500)]">Upload stays DM-only until revealed</span>}
      </div>

      {error && (
        <div style={{ padding: '0 14px 8px' }}>
          <ErrorNote message={error} pending={loading} onRetry={() => { void load(); }} />
        </div>
      )}
      {isDm && (
        <div style={{ padding: '0 14px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <MapConceptGlossary compact />
          <MapPurposePreview purpose="handout" surfacePurpose="handout" mode="upload" />
        </div>
      )}

      {items === null ? (
        <div style={{ padding: '0 14px 12px' }}>
          <Skeleton lines={2} />
        </div>
      ) : (
        <div style={{ padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {visible.length === 0 ? (
            <p className="text-[12px] text-[var(--color-neutral-500)]">
              {isDm ? 'No handouts yet — upload a map or image below to stage it.' : 'No handouts have been shared yet.'}
            </p>
          ) : (
            visible.map((a) => {
              const meta = a;
              return (
              <div
                key={a.id}
                className="cf-inset"
                // `flex-wrap` + `align-items: flex-start`: the DM buttons are `shrink-0`,
                // so on a narrow card they crushed the info column to a few characters
                // ("fog-security-map.png" rendered as "f…") and the DM-only badge landed
                // on top of "Edit details". They now drop to their own line instead.
                style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 10, padding: 10, borderRadius: 10 }}
              >
                {a.mime === 'application/pdf' ? (
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 6,
                      flexShrink: 0,
                      background: 'var(--color-surface)',
                      fontSize: 10,
                      fontWeight: 600,
                      color: 'var(--color-neutral-500)',
                    }}
                  >
                    PDF
                  </div>
                ) : (
                  <img
                    src={attachmentFileUrl(a.id, { hidden: a.hidden, updatedAt: a.updatedAt }, { size: 'thumb' })}
                    alt={meta.altText || meta.title || a.filename}
                    style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
                  />
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="text-[12px] truncate" title={meta.title || a.filename}>
                    {meta.title || a.filename}
                  </div>
                  {meta.caption && <div className="text-[11px] text-[var(--color-neutral-500)]">{meta.caption}</div>}
                  {(meta.attribution || meta.license || meta.sourceUrl) && (
                    <div className="text-[11px] text-[var(--color-neutral-500)]" style={{ marginTop: 2 }}>
                      {meta.attribution || meta.creator}
                      {meta.license ? `${meta.attribution || meta.creator ? ' · ' : ''}${meta.license}` : ''}
                      {meta.sourceUrl && <><span>{meta.attribution || meta.creator || meta.license ? ' · ' : ''}</span><a href={meta.sourceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: 'var(--color-accent)' }}>Source</a></>}
                    </div>
                  )}
                  <div style={{ marginTop: 2 }}>
                    <Chip variant={a.hidden ? 'dm' : 'party'}>{a.hidden ? <><GameIcon slug="padlock" size={UI_ICON_SIZE.xs} className="inline align-text-bottom" /> DM only</> : <><GameIcon slug="eyeball" size={UI_ICON_SIZE.xs} className="inline align-text-bottom" /> Revealed</>}</Chip>
                  </div>
                  {/* The visible labels are bare verbs: they used to repeat the filename
                      three times ("View fog-security-map.png", "Download …", "Print …"),
                      which in this narrow card wrapped each link across four lines and
                      buried the badge and the DM buttons. The name is one line above and
                      still reaches assistive tech via aria-label. */}
                  <div style={{ marginTop: 4, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <a
                      className="text-[11px] hover:underline"
                      href={attachmentFileUrl(a.id, { hidden: a.hidden, updatedAt: a.updatedAt })}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`View ${meta.title || a.filename}`}
                      style={{ color: 'var(--color-accent)' }}
                    >
                      View
                    </a>
                    <a
                      className="text-[11px] hover:underline"
                      href={attachmentFileUrl(a.id, { hidden: a.hidden, updatedAt: a.updatedAt }, { download: '1' })}
                      download={a.filename}
                      aria-label={`Download ${meta.title || a.filename}`}
                      style={{ color: 'var(--color-accent)' }}
                    >
                      Download
                    </a>
                    {a.mime !== 'application/pdf' && (
                      <button
                        className="text-[11px] hover:underline"
                        onClick={() => {
                          const win = window.open(attachmentFileUrl(a.id, { hidden: a.hidden, updatedAt: a.updatedAt }), '_blank');
                          if (win) {
                            win.opener = null;
                            win.addEventListener('load', () => win.print(), { once: true });
                          }
                        }}
                        aria-label={`Print ${meta.title || a.filename}`}
                        style={{ color: 'var(--color-accent)' }}
                      >
                        Print
                      </button>
                    )}
                  </div>
                </div>
                {canDmWrite && (
                  <div className="flex items-center gap-1.5 flex-wrap" style={{ marginInlineStart: 'auto' }}>
                  <Btn density="xs" ghost className="text-[11px]" onClick={() => { setEditing(a); setDraft(draftFor(a)); }}>Edit details</Btn>
                {canDmWrite && (
                  <Btn density="xs"
                    ghost
                    className="text-[11px]"
                    disabled={busyId === a.id}
                    onClick={() => void toggleReveal(a)}
                    title={a.hidden ? 'Warn before revealing the raw handout file' : undefined}
                  >
                    {busyId === a.id ? '…' : a.hidden ? 'Reveal' : 'Hide'}
                  </Btn>
                )}
                  </div>
                )}
              </div>
              );
            })
          )}

          {canDmWrite && (
            <div style={{ marginTop: 4 }}>
              <details className="text-[12px]" style={{ marginBottom: 8 }}>
                <summary>Handout details (optional)</summary>
                <MetadataFields value={uploadMetadata} onChange={setUploadMetadata} />
              </details>
              <ImageUpload
                campaignId={campaignId}
                kind="image"
                shape="rect"
                label="Drop a handout image, or click to choose (PDFs also accepted; stays hidden until you reveal it)"
                onUploaded={() => void load()}
                onError={setError}
                metadata={uploadMetadata}
              />
            </div>
          )}
        </div>
      )}
      {pendingReveal && (
        <ConfirmDialog
          title="Reveal raw handout?"
          body={
            <div className="space-y-3 text-sm text-slate-300" data-testid="handout-reveal-warning">
              <p className="m-0">
                <strong className="text-slate-100">{pendingReveal.filename}</strong>
              </p>
              <MapPurposePreview purpose="handout" surfacePurpose="handout" mode="reveal" />
              <p className="m-0 text-xs text-amber-300/90 border border-amber-500/30 bg-amber-500/10 rounded px-2.5 py-2">
                Revealing a handout exposes the raw image or PDF to players. Encounter fog,
                hidden tokens, AoE filtering, and Cast player-safe projection do not protect
                this file.
              </p>
            </div>
          }
          confirmLabel="Reveal raw file"
          pendingLabel="Revealing…"
          busy={busyId === pendingReveal.id}
          onConfirm={() => void commitVisibilityToggle(pendingReveal).then((ok) => {
            if (ok) setPendingReveal(null);
          })}
          onCancel={() => setPendingReveal(null)}
        />
      )}
      {editing && (
        <ConfirmDialog
          title="Edit handout details"
          body={<MetadataFields value={draft} onChange={setDraft} />}
          confirmLabel="Save details"
          pendingLabel="Saving…"
          busy={savingMetadata}
          onConfirm={() => void saveMetadata()}
          onCancel={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function MetadataFields({ value, onChange }: { value: MetadataDraft; onChange: (next: MetadataDraft) => void }) {
  const fields: Array<[keyof MetadataDraft, string]> = [['title', 'Title'], ['caption', 'Caption'], ['altText', 'Alt text'], ['creator', 'Creator'], ['sourceUrl', 'Source URL'], ['license', 'License'], ['rights', 'Rights'], ['attribution', 'Attribution']];
  return <div className="space-y-2" data-testid="handout-metadata-fields">{fields.map(([key, label]) => <label key={key} className="block text-xs">{label}<input aria-label={label} value={value[key]} onChange={(e) => onChange({ ...value, [key]: e.target.value })} className="w-full rounded px-2 py-1 text-slate-900" /></label>)}</div>;
}
