import { Link } from 'react-router-dom';
import type { Character } from '@campfire/schema';
import { HpBar, EmptyState } from '../../components/ui';

const AVATAR_PALETTE = [
  { bg: 'bg-purple-500/15', border: 'border-purple-500/60', text: 'text-purple-400', hover: 'hover:border-purple-500/50' },
  { bg: 'bg-emerald-500/15', border: 'border-emerald-500/60', text: 'text-emerald-400', hover: 'hover:border-emerald-500/50' },
  { bg: 'bg-amber-500/15', border: 'border-amber-500/60', text: 'text-amber-400', hover: 'hover:border-amber-500/50' },
  { bg: 'bg-rose-500/15', border: 'border-rose-500/60', text: 'text-rose-400', hover: 'hover:border-rose-500/50' },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function PartyCard({ campaignId, characters }: { campaignId: number; characters: Character[] }) {
  return (
    <section className="cf-card p-5 space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-3">
        <h2 className="font-bold text-white flex items-center gap-2">🛡 Party</h2>
        <Link to={`/c/${campaignId}/party`} className="text-xs text-slate-400 hover:text-white">
          Roster →
        </Link>
      </div>
      {characters.length === 0 ? (
        <EmptyState icon="🛡" title="No characters yet" />
      ) : (
        characters.map((c, i) => {
          const palette = AVATAR_PALETTE[i % AVATAR_PALETTE.length];
          const isCrit = c.hpMax > 0 && c.hpCurrent / c.hpMax < 0.25;
          return (
            <Link
              key={c.id}
              to={`/c/${campaignId}/characters/${c.id}`}
              className={`cf-inset p-3.5 flex gap-3 items-center ${palette.hover}`}
            >
              <div
                className={`h-10 w-10 rounded-lg ${palette.bg} border ${palette.border} flex items-center justify-center font-bold ${palette.text} text-xs shrink-0`}
              >
                {initials(c.name)}
              </div>
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-bold text-white text-sm truncate">{c.name}</p>
                  <span className="cf-chip" style={{ background: 'rgb(167 139 250/.15)', color: '#c4b5fd' }}>
                    {c.className || 'Adventurer'} {c.level}
                  </span>
                  {c.conditions.map((cond) => (
                    <span key={cond} className="cf-chip cf-chip-failed">
                      {cond}
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <HpBar current={c.hpCurrent} max={c.hpMax} />
                  <span className={`text-[10px] font-semibold ${isCrit ? 'text-rose-400' : 'text-slate-400'}`}>
                    {c.hpCurrent}/{c.hpMax}
                    {isCrit ? ' ⚠' : ''}
                  </span>
                </div>
              </div>
            </Link>
          );
        })
      )}
    </section>
  );
}
