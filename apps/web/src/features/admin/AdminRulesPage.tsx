/**
 * /admin/rules — rule-pack install & management. Part of the /admin/* page
 * split (issue #350); see AdminPage.tsx for the full route map.
 */
import { RequireServerAdmin } from './RequireServerAdmin';
import { RulePacksCard } from './RulePacksCard';
import { GameIcon } from '../../components/GameIcon';

export default function AdminRulesPage() {
  return (
    <RequireServerAdmin>
      <div className="max-w-4xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
        <h1 className="flex items-center gap-2 text-xl font-extrabold text-white"><GameIcon slug="spell-book" size={20} /> Rule packs</h1>
        <RulePacksCard />
      </div>
    </RequireServerAdmin>
  );
}
