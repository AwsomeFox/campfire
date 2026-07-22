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
import { useCallback, useEffect, useState } from 'react';
import type { Attachment, Role } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Btn, Chip, ErrorNote, Skeleton } from '../../components/ui';
import { ImageUpload, attachmentFileUrl } from '../../components/ImageUpload';
import { GameIcon } from '../../components/GameIcon';

export function HandoutsCard({
  campaignId,
  role,
}: {
  campaignId: number;
  role: Role | null;
}) {
  const isDm = role === 'dm';
  const [items, setItems] = useState<Attachment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.get<Attachment[]>(`${API}/campaigns/${campaignId}/attachments`);
      setItems(list);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load handouts.");
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleReveal(a: Attachment) {
    setBusyId(a.id);
    setError(null);
    try {
      await api.post(`${API}/attachments/${a.id}/${a.hidden ? 'reveal' : 'hide'}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update the handout.");
    } finally {
      setBusyId(null);
    }
  }

  // Players/viewers don't manage portraits here — only shared visual handouts.
  const visible = (items ?? []).filter((a) => (isDm ? true : a.kind !== 'portrait'));

  return (
    <div className="card elev-sm" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px' }}>
        <span className="card-kicker">Handouts</span>
        <div style={{ flex: 1 }} />
        {isDm && <span className="text-[11px] text-[var(--color-neutral-500)]">Upload stays DM-only until revealed</span>}
      </div>

      {error && (
        <div style={{ padding: '0 14px 8px' }}>
          <ErrorNote message={error} onRetry={() => setError(null)} />
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
            visible.map((a) => (
              <div
                key={a.id}
                className="cf-inset"
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 8, borderRadius: 10 }}
              >
                <img
                  src={attachmentFileUrl(a.id, { hidden: a.hidden, updatedAt: a.updatedAt }, { size: 'thumb' })}
                  alt=""
                  style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="text-[12px] truncate" title={a.filename}>
                    {a.filename}
                  </div>
                  <div style={{ marginTop: 2 }}>
                    <Chip variant={a.hidden ? 'dm' : 'party'}>{a.hidden ? <><GameIcon slug="padlock" size={12} className="inline align-text-bottom" /> DM only</> : <><GameIcon slug="eyeball" size={12} className="inline align-text-bottom" /> Revealed</>}</Chip>
                  </div>
                </div>
                {isDm && (
                  <Btn
                    ghost
                    className="!min-h-0 !py-1 text-[11px]"
                    disabled={busyId === a.id}
                    onClick={() => void toggleReveal(a)}
                  >
                    {busyId === a.id ? '…' : a.hidden ? 'Reveal' : 'Hide'}
                  </Btn>
                )}
              </div>
            ))
          )}

          {isDm && (
            <div style={{ marginTop: 4 }}>
              <ImageUpload
                campaignId={campaignId}
                kind="image"
                shape="rect"
                label="Drop a handout image, or click to choose (stays hidden until you reveal it)"
                onUploaded={() => void load()}
                onError={setError}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
