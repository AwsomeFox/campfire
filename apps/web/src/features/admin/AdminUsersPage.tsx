/**
 * /admin/users — accounts, password-reset requests, and sign-in settings.
 * Part of the /admin/* page split (issue #350); see AdminPage.tsx for the
 * full route map. Mirrors AdminPage's original users+settings load (both
 * fetched together since SettingsCard needs settings and UsersCard's
 * onChange refreshes both).
 */
import { useCallback, useEffect, useState } from 'react';
import type { User, ServerSettings } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, Skeleton, ErrorNote } from '../../components/ui';
import { RequireServerAdmin } from './RequireServerAdmin';
import { UsersCard } from './UsersCard';
import { ResetRequestsCard } from './ResetRequestsCard';
import { SettingsCard } from './SettingsCard';
import { GameIcon } from '../../components/GameIcon';
import { MembershipIntegrityCard } from './MembershipIntegrityCard';

function AdminUsers() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, s] = await Promise.all([
        api.get<User[]>(`${API}/users`),
        api.get<ServerSettings>(`${API}/settings`),
      ]);
      setUsers(u);
      setSettings(s);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load admin data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !users) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5 space-y-5">
        <Card>
          <Skeleton lines={4} />
        </Card>
        <Card>
          <Skeleton lines={2} />
        </Card>
      </div>
    );
  }

  if (error && !users) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message={error} onRetry={load} />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
      <h1 className="flex items-center gap-2 text-xl font-extrabold text-white"><GameIcon slug="person" size={20} /> Users</h1>
      {error && <ErrorNote message={error} onRetry={load} />}
      <UsersCard users={users ?? []} onChange={load} />
      <MembershipIntegrityCard users={users ?? []} />
      <ResetRequestsCard />
      <SettingsCard settings={settings} onChange={load} />
    </div>
  );
}

export default function AdminUsersPage() {
  return (
    <RequireServerAdmin>
      <AdminUsers />
    </RequireServerAdmin>
  );
}
