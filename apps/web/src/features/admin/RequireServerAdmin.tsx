/**
 * Shared server-admin gate for every /admin/* sub-page (issue #350). Extracted
 * from AdminPage's original inline "not an admin" check so each split-out page
 * (AdminPage overview, AdminUsersPage, AdminRulesPage, AdminAiPage,
 * AdminAuthPage, AdminStoragePage, AdminAuditPage) shares one 403 card instead
 * of reimplementing it.
 */
import type { ReactNode } from 'react';
import { useAuth } from '../../app/auth';
import { Card } from '../../components/ui';

export function RequireServerAdmin({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();

  if (!isAdmin) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <Card className="text-center space-y-1">
          <p className="text-2xl">🔒</p>
          <p className="text-sm text-slate-300 font-semibold">Server admins only</p>
          <p className="text-xs text-slate-500">Ask a server admin if you need access to this console.</p>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
