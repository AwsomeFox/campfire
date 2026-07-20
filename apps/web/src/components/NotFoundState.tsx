/**
 * Shared "entity not found" treatment for detail pages (issue #108).
 *
 * When a detail page's entity fetch returns 404 — the entity was deleted, or the id
 * in the URL never existed — the page should render this friendly dead-end with a way
 * back, NOT a retryable ErrorNote. A 404 can never succeed on retry, so offering
 * "Retry" (and no escape) traps the user. This mirrors the global NotFoundPage.
 *
 * Reserve this for 404s. Transient/unknown failures (5xx, network) still use the
 * retryable ErrorNote, since those genuinely can recover on retry.
 */
import { Link } from 'react-router-dom';
import { Card } from './ui';

export function NotFoundState({
  title,
  hint = 'It may have been deleted, or it never existed.',
  backTo,
  backLabel,
  icon = '🗺️',
}: {
  title: string;
  hint?: string;
  backTo: string;
  backLabel: string;
  icon?: string;
}) {
  return (
    <Card className="text-center space-y-2">
      <p className="text-2xl">{icon}</p>
      <p className="font-bold text-white">{title}</p>
      <p className="text-sm text-slate-400">{hint}</p>
      <Link to={backTo} className="btn btn-primary" style={{ display: 'inline-flex', marginTop: 8 }}>
        {backLabel}
      </Link>
    </Card>
  );
}
