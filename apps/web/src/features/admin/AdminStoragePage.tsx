/**
 * /admin/storage — storage quotas/cleanup and backup export. Part of the
 * /admin/* page split (issue #350); see AdminPage.tsx for the full route map.
 */
import { RequireServerAdmin } from './RequireServerAdmin';
import { StorageCard } from './StorageCard';
import { BackupCard } from './BackupCard';
import { ServerBackupInspectCard } from './ServerBackupInspectCard';
import { GameIcon } from '../../components/GameIcon';

export default function AdminStoragePage() {
  return (
    <RequireServerAdmin>
      <div className="max-w-4xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
        <h1 className="flex items-center gap-2 text-xl font-extrabold text-white"><GameIcon slug="database" size={20} /> Storage</h1>
        <StorageCard />
        <ServerBackupInspectCard />
        <BackupCard />
      </div>
    </RequireServerAdmin>
  );
}
