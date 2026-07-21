/**
 * "Get a map" affordance (issue #303): a curated, license-clean menu of open map SOURCES a
 * DM can pull a battle/location map from, shown wherever a map is attached (e.g. the empty
 * encounter battle-map state). Complements the first-party procedural generator (#306) with
 * EXTERNAL sources — it does NOT re-do generation.
 *
 * Two shapes, both license-clean:
 *   - generator LINKS (Watabou, donjon): open in a new tab; the DM generates a map client-
 *     side, exports an image, and imports it. Campfire never fetches/bundles these, so no
 *     NC/ND content can enter this way.
 *   - the One Page Dungeon Contest (CC-BY-SA): the DM downloads an entry image and imports it
 *     through the attribution form below, which stamps the required credit onto the map.
 *
 * The catalog itself comes from GET /campaigns/:id/maps/sources so the server stays the
 * single source of truth for what's license-clean.
 */
import { useEffect, useState } from 'react';
import type { MapSource } from '@campfire/schema';
import { api, API, ApiError } from '../lib/api';
import { importMapWithAttribution } from './ImageUpload';
import { Btn, TextInput } from './ui';
import { DraftWithAiButton } from '../features/ai-dm/DraftWithAiButton';
import { useAuth } from '../app/auth';
import { useAiDmSeat } from '../lib/query';

const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp'];

export function GetAMapPanel({
  campaignId,
  onImported,
  onError,
}: {
  campaignId: number;
  /** Called with the new hidden 'map' attachment id after a successful import. */
  onImported: (attachmentId: number) => void;
  onError?: (message: string) => void;
}) {
  const [sources, setSources] = useState<MapSource[] | null>(null);
  const [open, setOpen] = useState(false);
  const [importSource, setImportSource] = useState<MapSource | null>(null);

  // Same self-gate as DraftWithAiButton (DM + AI-DM seat enabled, co_dm/driver mode) —
  // checked here too so the panel doesn't collapse to nothing when there are no external
  // map sources configured but AI drafting (issue #341) is still available.
  const { roleIn } = useAuth();
  const isDm = roleIn(campaignId) === 'dm';
  const { data: seat } = useAiDmSeat(isDm ? campaignId : undefined);
  const canDraftWithAi = isDm && !!seat && seat.mode !== 'off' && seat.enabled;

  useEffect(() => {
    let alive = true;
    api
      .get<MapSource[]>(`${API}/campaigns/${campaignId}/maps/sources`)
      .then((s) => alive && setSources(s))
      .catch(() => alive && setSources([]));
    return () => {
      alive = false;
    };
  }, [campaignId]);

  const hasSources = !!sources && sources.length > 0;
  if (!hasSources && !canDraftWithAi) return null;

  const generators = (sources ?? []).filter((s) => s.kind === 'generator-external');
  const importable = (sources ?? []).filter((s) => s.importable);

  return (
    <div className="cf-inset" style={{ padding: '10px 12px', marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {hasSources ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, cursor: 'pointer', background: 'none', border: 0, padding: 0 }}
          >
            <span className="card-kicker">Get a map</span>
            <span className="text-muted" style={{ fontSize: 11 }}>
              open, license-clean sources
            </span>
            <span style={{ flex: 1 }} />
            <span className="text-muted" style={{ fontSize: 12 }}>{open ? '▾' : '▸'}</span>
          </button>
        ) : (
          <>
            <span className="card-kicker">Get a map</span>
            <span style={{ flex: 1 }} />
          </>
        )}
        {canDraftWithAi && <DraftWithAiButton campaignId={campaignId} target="map" />}
      </div>

      {open && hasSources && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p className="text-muted" style={{ fontSize: 11, margin: 0 }}>
            Generate a map on one of these sites, export it as an image, then import it below. Output is free to use;
            nothing is bundled or re-served.
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {generators.map((s) => (
              <a
                key={s.id}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="cf-chip"
                style={{ cursor: 'pointer', textDecoration: 'none' }}
                title={`${s.description} — ${s.license}`}
              >
                {s.name} ↗
              </a>
            ))}
          </div>

          {importable.map((s) => (
            <div key={s.id} style={{ borderTop: '1px solid var(--cf-border, rgba(255,255,255,0.08))', paddingTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 12 }}>{s.name}</strong>
                <span className="cf-chip" style={{ fontSize: 10 }}>{s.license}</span>
                {s.url && (
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-muted" style={{ fontSize: 11 }}>
                    browse entries ↗
                  </a>
                )}
              </div>
              <p className="text-muted" style={{ fontSize: 11, margin: '4px 0 6px' }}>{s.description}</p>
              {importSource?.id === s.id ? (
                <ImportForm
                  campaignId={campaignId}
                  source={s}
                  onImported={(id) => {
                    setImportSource(null);
                    onImported(id);
                  }}
                  onCancel={() => setImportSource(null)}
                  onError={onError}
                />
              ) : (
                <Btn ghost className="!min-h-0 !py-1 text-[11px]" onClick={() => setImportSource(s)}>
                  Import a downloaded map…
                </Btn>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The attribution form for importing an open-licensed map (CC-BY-SA requires the credit). */
function ImportForm({
  campaignId,
  source,
  onImported,
  onCancel,
  onError,
}: {
  campaignId: number;
  source: MapSource;
  onImported: (attachmentId: number) => void;
  onCancel: () => void;
  onError?: (message: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [sourceUrl, setSourceUrl] = useState(source.url ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = title.trim().length > 0 && author.trim().length > 0 && file != null && !busy;

  async function submit() {
    if (!file) return;
    setBusy(true);
    try {
      const result = await importMapWithAttribution(
        campaignId,
        { title: title.trim(), author: author.trim(), license: source.license, sourceUrl: sourceUrl.trim() || undefined, sourceId: source.id },
        file,
      );
      onImported(result.attachment.id);
    } catch (err) {
      onError?.(err instanceof ApiError ? err.message : "Couldn't import the map.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <TextInput placeholder="Map title (e.g. The Sunken Abbey)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <TextInput placeholder="Author to credit" value={author} onChange={(e) => setAuthor(e.target.value)} />
      <TextInput placeholder="Source URL (optional)" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
      <input
        type="file"
        accept={ACCEPTED_MIME.join(',')}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        style={{ fontSize: 11 }}
      />
      <p className="text-muted" style={{ fontSize: 10, margin: 0 }}>
        Imports under {source.license}. The credit is stamped onto the saved map, which stays DM-only until you reveal it.
      </p>
      <div style={{ display: 'flex', gap: 6 }}>
        <Btn className="!min-h-0 !py-1 text-[11px]" disabled={!canSubmit} onClick={() => void submit()}>
          {busy ? 'Importing…' : 'Import map'}
        </Btn>
        <Btn ghost className="!min-h-0 !py-1 text-[11px]" disabled={busy} onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}
