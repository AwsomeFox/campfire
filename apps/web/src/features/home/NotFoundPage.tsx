/**
 * Catch-all 404 — rendered inside the authed Layout (chrome stays visible)
 * for any path that doesn't match a known route.
 */
import { Link } from 'react-router-dom';
import { Card } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';

export function NotFoundPage() {
  return (
    <div className="max-w-lg mx-auto mt-10 px-4">
      <Card className="text-center space-y-2">
        <p className="flex justify-center text-[var(--color-neutral-400)]"><GameIcon slug="treasure-map" size={28} /></p>
        <h1 className="font-bold text-white m-0">Page not found</h1>
        <p className="text-sm text-slate-400">There&apos;s nothing here. It may have moved or never existed.</p>
        <Link to="/" className="btn btn-primary" style={{ display: 'inline-flex', marginTop: 8 }}>
          Back to campaigns
        </Link>
      </Card>
    </div>
  );
}
