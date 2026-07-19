import { Link } from 'react-router-dom';
import type { Session } from '@campfire/schema';
import { EmptyState } from '../../components/ui';

/** First non-empty line of a markdown recap, with basic markdown syntax stripped for preview. */
function firstLinePlain(markdown: string): string {
  const line = markdown.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line
    .replace(/^#+\s*/, '')
    .replace(/[*_`>#-]/g, '')
    .trim();
}

export function SessionLog({ campaignId, sessions }: { campaignId: number; sessions: Session[] }) {
  const sorted = [...sessions].sort((a, b) => b.number - a.number);
  const latest3 = sorted.slice(0, 3);

  return (
    <section className="cf-card p-5 space-y-4">
      <div className="flex items-center justify-between border-b border-slate-700 pb-3">
        <h2 className="font-bold text-white flex items-center gap-2">📓 Session log</h2>
        <Link to={`/c/${campaignId}/sessions`} className="text-xs text-slate-400 hover:text-white">
          All sessions →
        </Link>
      </div>
      {latest3.length === 0 ? (
        <EmptyState icon="📓" title="No sessions logged yet" />
      ) : (
        <div className="space-y-4 max-h-72 overflow-y-auto pr-1">
          {latest3.map((s, i) => (
            <Link
              key={s.id}
              to={`/c/${campaignId}/sessions`}
              className={`block cf-timeline space-y-1 ${i === 0 ? 'active' : ''}`}
            >
              <div className="flex items-center justify-between">
                <p className={`font-bold text-sm ${i === 0 ? 'text-white' : 'text-slate-300'}`}>
                  S{s.number}
                  {s.title ? ` · ${s.title}` : ''}
                </p>
                {i === 0 && <span className="cf-chip cf-chip-active">Latest</span>}
              </div>
              <p className={`text-xs line-clamp-2 ${i === 0 ? 'text-slate-400' : 'text-slate-500'}`}>
                {firstLinePlain(s.recap) || 'No recap yet.'}
              </p>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
