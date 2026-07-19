import { Link } from 'react-router-dom';
import type { Location } from '@campfire/schema';

const VIEW_W = 500;
const VIEW_H = 260;

const STATUS_COLOR: Record<Location['status'], string> = {
  current: '#f59e0b',
  explored: '#10b981',
  unexplored: '#64748b',
};
const STATUS_TEXT_COLOR: Record<Location['status'], string> = {
  current: '#fbbf24',
  explored: '#34d399',
  unexplored: '#94a3b8',
};

export function RegionMap({ campaignId, locations }: { campaignId: number; locations: Location[] }) {
  const pinned = locations.filter((l) => l.mapX != null && l.mapY != null);
  const unpinned = locations.filter((l) => l.mapX == null || l.mapY == null);

  return (
    <div className="card elev-sm" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px 0' }}>
        <span className="card-kicker">World map</span>
        <div style={{ flex: 1 }} />
        <Link to={`/c/${campaignId}/locations`} className="btn btn-ghost" style={{ fontSize: 12 }}>
          All locations →
        </Link>
      </div>
      <div className="relative overflow-hidden h-56 md:h-64" style={{ margin: '8px 14px' }}>
        <div
          className="absolute inset-0 opacity-35"
          style={{
            backgroundImage: 'radial-gradient(#334155 1px, transparent 1px)',
            backgroundSize: '16px 16px',
          }}
        />
        <svg className="w-full h-full" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} xmlns="http://www.w3.org/2000/svg">
          {pinned.map((loc) => {
            const x = ((loc.mapX ?? 0) / 100) * VIEW_W;
            const y = ((loc.mapY ?? 0) / 100) * VIEW_H;
            const isCurrent = loc.status === 'current';
            const isExplored = loc.status === 'explored';
            const r = isCurrent ? 5.5 : loc.status === 'unexplored' ? 3.5 : 4.5;
            const glowR = isCurrent ? 12 : isExplored ? 9 : 7;
            const suffix = isCurrent ? ' 📍' : isExplored ? ' ✓' : ' ?';
            return (
              <g key={loc.id} transform={`translate(${x}, ${y})`}>
                <Link to={`/c/${campaignId}/locations/${loc.id}`}>
                  <circle r={glowR} fill={STATUS_COLOR[loc.status]} fillOpacity={isCurrent ? 0.25 : isExplored ? 0.2 : 0.3}>
                    {isCurrent && (
                      <animate attributeName="fill-opacity" values=".25;.5;.25" dur="2s" repeatCount="indefinite" />
                    )}
                  </circle>
                  <circle r={r} fill={STATUS_COLOR[loc.status]} />
                  <text
                    x={isCurrent ? -12 : isExplored ? 13 : 12}
                    y={isCurrent ? -12 : isExplored ? 4 : 4}
                    fontSize="11"
                    fill={STATUS_TEXT_COLOR[loc.status]}
                    fontWeight={isCurrent ? 'bold' : undefined}
                    textAnchor={isCurrent ? 'end' : 'start'}
                  >
                    {loc.name}
                    {suffix}
                  </text>
                </Link>
              </g>
            );
          })}
        </svg>
      </div>
      {unpinned.length > 0 && (
        <div className="flex flex-wrap gap-2" style={{ padding: '0 14px 10px' }}>
          {unpinned.map((loc) => (
            <Link
              key={loc.id}
              to={`/c/${campaignId}/locations/${loc.id}`}
              className="cf-chip"
              style={{ background: 'rgb(100 116 139 / .2)', color: STATUS_TEXT_COLOR[loc.status] }}
            >
              {loc.name}
            </Link>
          ))}
        </div>
      )}
      <div
        className="text-muted"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          padding: '10px 14px',
          borderTop: '1px solid var(--color-divider)',
          fontSize: 11,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent)' }} />
          Current
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-neutral-500)' }} />
          Explored
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', border: '1px dashed var(--color-neutral-600)' }} />
          Unexplored
        </span>
        <span style={{ marginLeft: 'auto' }}>Drag to pan · tap a pin</span>
      </div>
    </div>
  );
}
