/**
 * Catch-all 404 — rendered inside the authed Layout (chrome stays visible)
 * for any path that doesn't match a known route.
 */
import { Link } from 'react-router-dom';
import { Card } from '../../components/ui';

export function NotFoundPage() {
  return (
    <div className="max-w-lg mx-auto mt-10 px-4">
      <Card className="text-center space-y-2">
        <p className="text-2xl">🗺️</p>
        <p className="font-bold text-white">Page not found</p>
        <p className="text-sm text-slate-400">There&apos;s nothing here. It may have moved or never existed.</p>
        <Link to="/" className="btn btn-primary" style={{ display: 'inline-flex', marginTop: 8 }}>
          Back to campaigns
        </Link>
      </Card>
    </div>
  );
}
