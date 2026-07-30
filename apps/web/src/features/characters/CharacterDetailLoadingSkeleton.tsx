/**
 * Character detail loading shell (issue #460).
 *
 * Preserves the sheet header, tab strip, and card geometry so direct navigation
 * and slow networks never paint an empty `<main>`. A single named status region
 * exposes aria-busy without an h1 — route-change focus stays on main until data
 * arrives and the real heading mounts.
 */
import type { ReactNode } from 'react';

const CHARACTER_DETAIL_LOADING_LABEL = 'Loading character…';

function SkeletonBar({
  width = '100%',
  className = 'h-3',
}: {
  width?: string;
  className?: string;
}) {
  return (
    <div
      className={`rounded animate-pulse bg-[var(--color-neutral-800)] ${className}`}
      style={{ width }}
      aria-hidden="true"
    />
  );
}

function CharacterDetailLoadingStatus({
  children,
  className = 'space-y-4',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`reading-surface max-w-5xl mx-auto px-4 mt-5 pb-20 md:pb-10 ${className}`}
      role="status"
      aria-busy="true"
      aria-label={CHARACTER_DETAIL_LOADING_LABEL}
      data-testid="character-detail-loading"
    >
      <span className="sr-only">{CHARACTER_DETAIL_LOADING_LABEL}</span>
      {children}
    </div>
  );
}

/** Geometry-preserving placeholder for CharacterPage while the core fetch is in flight. */
export function CharacterDetailLoadingSkeleton() {
  return (
    <CharacterDetailLoadingStatus>
      <SkeletonBar width="132px" className="h-4" />

      <div className="flex items-center gap-3 flex-wrap">
        <SkeletonBar width="56px" className="h-14 w-14 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1 space-y-2">
          <SkeletonBar width="min(100%, 220px)" className="h-7" />
          <SkeletonBar width="min(100%, 280px)" className="h-4" />
        </div>
      </div>

      <div
        className="sticky z-20 -mx-4 px-4 py-2 bg-[var(--color-surface)]/95 backdrop-blur border-b border-slate-800/80"
        aria-hidden="true"
        style={{ top: 'var(--app-header-h)' }}
      >
        <div className="inline-flex gap-2">
          <SkeletonBar width="72px" className="h-10 rounded-md" />
          <SkeletonBar width="80px" className="h-10 rounded-md" />
        </div>
      </div>

      <div className="card elev-sm space-y-3 p-4" aria-hidden="true">
        <SkeletonBar width="28%" className="h-2.5" />
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))' }}>
          {Array.from({ length: 6 }, (_, i) => (
            <SkeletonBar key={i} width="100%" className="h-16" />
          ))}
        </div>
      </div>

      <div className="card elev-sm space-y-3 p-4" aria-hidden="true">
        <SkeletonBar width="36%" className="h-2.5" />
        <SkeletonBar width="min(100%, 180px)" className="h-9" />
        <SkeletonBar width="100%" className="h-2" />
      </div>
    </CharacterDetailLoadingStatus>
  );
}

export { CHARACTER_DETAIL_LOADING_LABEL };
