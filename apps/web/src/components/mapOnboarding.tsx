import type { CSSProperties } from 'react';

export type MapPurpose = 'world' | 'handout' | 'encounter';

export const MAP_PURPOSE_ORDER: MapPurpose[] = ['world', 'handout', 'encounter'];

export const MAP_PURPOSE_COPY: Record<
  MapPurpose,
  {
    label: string;
    shortLabel: string;
    description: string;
    storage: string;
    visibility: string;
    preview: string;
    route: string;
  }
> = {
  world: {
    label: 'World map',
    shortLabel: 'World',
    description: 'A campaign or region reference with location pins.',
    storage: 'Stores on the campaign RegionMap slot.',
    visibility: 'Visible on the dashboard with location status and pins; it is not fogged.',
    preview: 'Players see the world map and discovered/current location pins as a reference view.',
    route: 'Use the Dashboard world map panel.',
  },
  handout: {
    label: 'Handout',
    shortLabel: 'Handout',
    description: 'A picture, map, clue, or PDF you reveal as table art.',
    storage: 'Stores as a hidden attachment until you reveal it.',
    visibility: 'Reveal shares the raw file. Fog, tokens, and encounter redaction do not apply.',
    preview: 'Players only see revealed handouts; hidden uploads remain DM-only.',
    route: 'Use the Dashboard Handouts panel.',
  },
  encounter: {
    label: 'Encounter battle map',
    shortLabel: 'Encounter',
    description: 'A tactical map for combat with grid, tokens, pings, AoE, and fog.',
    storage: 'Stores as a hidden map attachment linked to this encounter.',
    visibility: 'Players load the encounter map through the role-safe fog endpoint, not the raw file.',
    preview: 'Cast/player view uses player-safe fog: unrevealed pixels, tokens, and AoE stay hidden.',
    route: 'Use an encounter Battle map panel.',
  },
};

const glossaryStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
};

const boxStyle: CSSProperties = {
  border: '1px solid var(--color-divider)',
  borderRadius: 'var(--radius-md)',
  padding: '8px 10px',
  background: 'rgba(15,23,42,.24)',
};

export function MapConceptGlossary({ compact = false }: { compact?: boolean }) {
  return (
    <div className="cf-inset" data-testid="map-concept-glossary" style={{ padding: compact ? '8px 10px' : 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span className="card-kicker">Map concepts</span>
        <span className="text-muted" style={{ fontSize: 11 }}>
          choose the purpose before saving so visibility is clear
        </span>
      </div>
      <div style={glossaryStyle}>
        {MAP_PURPOSE_ORDER.map((purpose) => {
          const copy = MAP_PURPOSE_COPY[purpose];
          return (
            <div key={purpose} style={boxStyle}>
              <strong style={{ display: 'block', fontSize: 12 }}>{copy.label}</strong>
              <p className="text-muted" style={{ fontSize: 11, margin: '2px 0 0' }}>
                {copy.description}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MapPurposePicker({
  value,
  onChange,
  surfacePurpose,
}: {
  value: MapPurpose;
  onChange: (value: MapPurpose) => void;
  surfacePurpose: MapPurpose;
}) {
  return (
    <fieldset
      data-testid="map-purpose-picker"
      style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      <legend className="card-kicker" style={{ marginBottom: 2 }}>
        Intended use
      </legend>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 6 }}>
        {MAP_PURPOSE_ORDER.map((purpose) => {
          const copy = MAP_PURPOSE_COPY[purpose];
          const active = value === purpose;
          const currentSurface = surfacePurpose === purpose;
          return (
            <label
              key={purpose}
              className="cf-inset"
              style={{
                padding: '8px 10px',
                cursor: 'pointer',
                borderColor: active ? 'var(--color-accent)' : 'var(--color-divider)',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="radio"
                  name="map-purpose"
                  value={purpose}
                  checked={active}
                  onChange={() => onChange(purpose)}
                />
                <strong style={{ fontSize: 12 }}>{copy.label}</strong>
              </span>
              <span className="text-muted" style={{ display: 'block', fontSize: 10, marginTop: 3 }}>
                {currentSurface ? 'This panel saves here.' : copy.route}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function MapPurposePreview({
  purpose,
  surfacePurpose,
  mode = 'save',
}: {
  purpose: MapPurpose;
  surfacePurpose?: MapPurpose;
  mode?: 'save' | 'upload' | 'reveal' | 'preview';
}) {
  const copy = MAP_PURPOSE_COPY[purpose];
  const mismatch = surfacePurpose != null && purpose !== surfacePurpose;
  return (
    <div
      data-testid={`map-purpose-preview-${purpose}`}
      className="cf-inset"
      style={{
        padding: '8px 10px',
        borderColor: mismatch ? 'rgba(251,191,36,.45)' : 'var(--color-divider)',
        background: mismatch ? 'rgba(251,191,36,.08)' : undefined,
      }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className="card-kicker">{copy.label}</span>
        <span className="text-muted" style={{ fontSize: 11 }}>
          {mode === 'reveal'
            ? 'visibility warning'
            : mode === 'upload'
              ? 'upload preview'
              : mode === 'preview'
                ? 'preview'
                : 'save preview'}
        </span>
      </div>
      <ul className="text-muted" style={{ fontSize: 11, margin: '4px 0 0', paddingLeft: 18 }}>
        <li>{copy.storage}</li>
        <li>{copy.visibility}</li>
        <li>{copy.preview}</li>
      </ul>
      {mismatch && surfacePurpose && (
        <p className="text-amber-300/90" style={{ fontSize: 11, margin: '6px 0 0' }} data-testid="map-purpose-route-warning">
          This panel saves as {MAP_PURPOSE_COPY[surfacePurpose].label}. To use this as {copy.label}, choose that route explicitly:
          {' '}
          {copy.route}
        </p>
      )}
    </div>
  );
}

export function mapPurposeMismatchMessage(purpose: MapPurpose, surfacePurpose: MapPurpose): string | null {
  if (purpose === surfacePurpose) return null;
  return `Choose ${MAP_PURPOSE_COPY[surfacePurpose].label} here, or switch to ${MAP_PURPOSE_COPY[purpose].route}`;
}
