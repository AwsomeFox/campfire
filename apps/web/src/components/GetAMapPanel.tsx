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
import type { GenerateMapParams, MapSource } from '@campfire/schema';
import { api, API, ApiError } from '../lib/api';
import { importMapWithAttribution } from './ImageUpload';
import { GenerateMapPanel } from './GenerateMapPanel';
import { ExternalGeneratorCard } from './ExternalGeneratorCard';
import {
  clearAcquisition,
  loadAndPruneAcquisition,
  saveAcquisition,
  type AcquisitionState,
} from './externalGeneratorAcquisition';
import { Field } from './Field';
import {
  MAP_AUTHOR_HELP,
  MAP_AUTHOR_LABEL,
  MAP_FILE_ACCEPT,
  MAP_FILE_HELP,
  MAP_FILE_LABEL,
  MAP_IMPORT_FIELD,
  MAP_IMPORT_PREFIX,
  MAP_SOURCE_URL_HELP,
  MAP_SOURCE_URL_LABEL,
  MAP_TITLE_HELP,
  MAP_TITLE_LABEL,
} from './formFieldLabels';
import { Btn } from './ui';
import { DraftWithAiButton } from '../features/ai-dm/DraftWithAiButton';
import { AiMapButton } from '../features/ai-dm/AiMapWizard';
import { useAuth } from '../app/auth';
import { useAiDmSeat } from '../lib/query';
import { useDisclosure } from './useDisclosure';

export function GetAMapPanel({
  campaignId,
  onImported,
  onGenerate,
  onError,
}: {
  campaignId: number;
  /** Called with the new hidden 'map' attachment id after a successful import. */
  onImported: (attachmentId: number) => void;
  /**
   * Atomically attach a generated map by replaying its previewed seed/params through the
   * persisting endpoint (issue #409). When provided, the first-party procedural generator
   * (`generator-builtin`) becomes discoverable here beside upload/import and its wizard
   * (preview → reroll → use) is wired to this handler. Omit it on surfaces that can't
   * attach a generated map. The surface owns the atomic attach so it can apply the
   * returned grid/scale in the same operation.
   */
  onGenerate?: (params: GenerateMapParams) => Promise<void>;
  onError?: (message: string) => void;
}) {
  const [sources, setSources] = useState<MapSource[] | null>(null);
  // A persisted, in-progress external-generator round trip (issue #411): the DM opened a
  // generator and hasn't imported yet. Restored in the effect below so a reload / navigation
  // lands them back on the same card with its return checklist, not a blank menu.
  const [acquisition, setAcquisition] = useState<AcquisitionState | null>(null);
  const { open, setOpen, buttonProps, regionProps } = useDisclosure({
    regionLabel: 'Open, license-clean map sources',
    initialOpen: false,
  });
  const generatorDisclosure = useDisclosure({
    regionLabel: 'Map generator',
    focusManagement: false,
  });
  const generatorOpen = generatorDisclosure.open;
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
    // Re-read the persisted round trip for this campaign (the id can change without a remount).
    const restored = loadAndPruneAcquisition(campaignId, Date.now());
    setAcquisition(restored);
    if (restored) setOpen(true);
    return () => {
      alive = false;
    };
  }, [campaignId]);

  // The first-party procedural generator (#306) — surfaced as its own wizard (#409) rather
  // than the external-source list, which is why GetAMapPanel historically filtered it out.
  const builtinGenerator = (sources ?? []).find((s) => s.kind === 'generator-builtin');
  // Discoverability is driven by the SURFACE opting in (providing onGenerate), not by the
  // /maps/sources fetch: the wizard talks to the dedicated preview endpoint, so it must stay
  // reachable even while sources are still loading or if that request fails.
  const canGenerate = !!onGenerate;

  const hasSources = !!sources && sources.length > 0;
  if (!hasSources && !canDraftWithAi && !canGenerate) return null;

  const generators = (sources ?? []).filter((s) => s.kind === 'generator-external');
  const importable = (sources ?? []).filter((s) => s.importable);

  return (
    <div className="cf-inset" style={{ padding: '10px 12px', marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {hasSources ? (
          <button
            type="button"
            data-testid="get-a-map-toggle"
            {...buttonProps}
            style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, cursor: 'pointer', background: 'none', border: 0, padding: 0 }}
          >
            <span className="card-kicker">Get a map</span>
            <span className="text-muted" style={{ fontSize: 11 }}>
              open, license-clean sources
            </span>
            <span style={{ flex: 1 }} />
            <span className="text-muted" style={{ fontSize: 12 }} aria-hidden="true">{open ? '▾' : '▸'}</span>
          </button>
        ) : (
          <>
            <span className="card-kicker">Get a map</span>
            <span style={{ flex: 1 }} />
          </>
        )}
        {canGenerate && (
          <button
            type="button"
            data-testid="generate-map-toggle"
            className="cf-chip"
            {...generatorDisclosure.buttonProps}
            style={{ cursor: 'pointer' }}
            title={builtinGenerator?.description}
          >
            {generatorOpen ? 'Close generator' : '✨ Generate a map'}
          </button>
        )}
        {/* Genuine AI map generation (issue #410): capability-routed image/procedural
            candidates with cost/readiness + honest provenance. Available to any DM (falls
            back to the offline procedural renderer when no image provider is configured). */}
        {isDm && <AiMapButton campaignId={campaignId} onAttached={onImported} />}
        {canDraftWithAi && <DraftWithAiButton campaignId={campaignId} target="map" />}
      </div>

      {/* First-party procedural generator wizard (issue #409): preview → reroll → use,
          without attaching or revealing until the DM commits. */}
      {canGenerate && generatorOpen && (
        <div {...generatorDisclosure.regionProps}>
          <GenerateMapPanel
            campaignId={campaignId}
            onError={onError}
            onCancel={() => generatorDisclosure.setOpen(false)}
            onUse={async (params) => {
              await onGenerate!(params);
              generatorDisclosure.setOpen(false);
            }}
          />
        </div>
      )}

      {open && hasSources && (
        <div {...regionProps} style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p className="text-muted" style={{ fontSize: 11, margin: 0 }}>
            Generate a map on one of these sites, export it as an image, then import it right here.
            Output is free to use; Campfire never fetches or re-serves anything on your behalf.
          </p>

          {/* External generators as a guided round trip (issue #411): open → export → return →
              import → calibrate → attach, all in the one card — no separate dropzone to hunt for. */}
          {generators.map((s) => (
            <ExternalGeneratorCard
              key={s.id}
              campaignId={campaignId}
              source={s}
              acquisitionActive={acquisition?.sourceId === s.id}
              onOpenGenerator={() => setAcquisition(saveAcquisition(campaignId, s.id, Date.now()))}
              onCancelAcquisition={() => {
                clearAcquisition(campaignId);
                setAcquisition(null);
              }}
              onImported={(id) => {
                clearAcquisition(campaignId);
                setAcquisition(null);
                onImported(id);
              }}
              onError={onError}
            />
          ))}

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="map-import-form">
      <Field
        idPrefix={MAP_IMPORT_PREFIX}
        name={MAP_IMPORT_FIELD.title}
        label={MAP_TITLE_LABEL}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        help={MAP_TITLE_HELP}
        placeholder="The Sunken Abbey"
        required
      />
      <Field
        idPrefix={MAP_IMPORT_PREFIX}
        name={MAP_IMPORT_FIELD.author}
        label={MAP_AUTHOR_LABEL}
        value={author}
        onChange={(e) => setAuthor(e.target.value)}
        help={MAP_AUTHOR_HELP}
        placeholder="Cartographer name"
        required
      />
      <Field
        idPrefix={MAP_IMPORT_PREFIX}
        name={MAP_IMPORT_FIELD.sourceUrl}
        label={MAP_SOURCE_URL_LABEL}
        value={sourceUrl}
        onChange={(e) => setSourceUrl(e.target.value)}
        help={MAP_SOURCE_URL_HELP}
        placeholder="https://"
        optional
      />
      <Field
        idPrefix={MAP_IMPORT_PREFIX}
        name={MAP_IMPORT_FIELD.file}
        as="file"
        label={MAP_FILE_LABEL}
        accept={MAP_FILE_ACCEPT}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        help={`${MAP_FILE_HELP} Imports under ${source.license}.`}
        required
      />
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
