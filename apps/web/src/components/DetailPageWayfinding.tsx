/**
 * Shared detail-page return link (issue #652).
 *
 * Uses an explicit destination label and a stable list URL — never `navigate(-1)` —
 * so in-app return is predictable and preserves search/filter query strings. Browser
 * Back/Forward still follows history independently.
 */
import { Link, useLocation } from 'react-router-dom';
import {
  listOriginRestoreState,
  resolveDetailReturnTarget,
  type DetailListOriginState,
} from '../lib/detailListOrigin';

export type DetailBreadcrumbSegment = {
  label: string;
  to: string;
};

type DetailPageWayfindingProps = {
  campaignId: number;
  /** Fallback list path when there is no preserved list origin (deep links, nav rail). */
  defaultPath: string;
  /** Fallback label paired with `defaultPath`. */
  defaultLabel: string;
  /** Optional hierarchical trail rendered below the return link (locations). */
  trail?: DetailBreadcrumbSegment[];
  /** Current page title for the terminal breadcrumb segment. */
  currentLabel?: string;
};

export function DetailPageWayfinding({
  campaignId,
  defaultPath,
  defaultLabel,
  trail,
  currentLabel,
}: DetailPageWayfindingProps) {
  const location = useLocation();
  const { to, label, scrollY } = resolveDetailReturnTarget(
    location.state,
    campaignId,
    defaultPath,
    defaultLabel,
  );
  const returnState = listOriginRestoreState(to, scrollY) as DetailListOriginState | undefined;

  return (
    <div className="space-y-1">
      <nav aria-label="Return to list">
        <Link
          to={to}
          state={returnState}
          className="btn btn-ghost !min-h-0 !py-1.5 text-xs"
          style={{ width: 'fit-content' }}
        >
          {label}
        </Link>
      </nav>
      {trail && trail.length > 0 && currentLabel && (
        <nav aria-label="Location breadcrumb" className="flex items-center gap-1.5 flex-wrap text-xs text-slate-400">
          {trail.map((segment) => (
            <span key={segment.to} className="flex items-center gap-1.5">
              <Link to={segment.to} state={returnState} className="hover:text-amber-400">
                {segment.label}
              </Link>
              <span className="text-slate-600" aria-hidden>
                ›
              </span>
            </span>
          ))}
          <span className="text-slate-500">{currentLabel}</span>
        </nav>
      )}
    </div>
  );
}
