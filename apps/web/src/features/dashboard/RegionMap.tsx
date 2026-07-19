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
    <section className="cf-card p-5 space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-3">
        <h2 className="font-bold text-white flex items-center gap-2">
          <span className="text-amber-500">🗺</span> Region
        </h2>
        <Link to={`/c/${campaignId}/locations`} className="text-xs text-slate-400 hover:text-white">
          All locations →
        </Link>
      </div>
      <div className="relative cf-inset overflow-hidden h-56 md:h-64">
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
        <div className="flex flex-wrap gap-2 pt-1">
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
      <p className="text-[11px] text-slate-500">MVP: abstract pin canvas · P1: upload a map image, drag pins onto it.</p>
    </section>
  );
}
