/**
 * /admin/rules — rule-pack install & management. Part of the /admin/* page
 * split (issue #350); see AdminPage.tsx for the full route map.
 */
import { Link, useLocation } from 'react-router-dom';
import { RequireServerAdmin } from './RequireServerAdmin';
import { RulePacksCard } from './RulePacksCard';
import { GameIcon } from '../../components/GameIcon';
import { NEW_CAMPAIGN_SETUP_PATH, safeAdminRulesReturnPath } from '../../lib/adminNavigation';

export default function AdminRulesPage() {
  const location = useLocation();
  const stateReturnTo = (location.state as { returnTo?: unknown } | null)?.returnTo;
  // Match LoginPage's redirect precedence: an explicit URL parameter survives a
  // reload, while router state keeps normal in-app links clean at /admin/rules.
  // Both are constrained to known campaign setup routes before becoming a Link.
  const returnTo =
    safeAdminRulesReturnPath(new URLSearchParams(location.search).get('returnTo')) ??
    safeAdminRulesReturnPath(stateReturnTo);
  const returnLabel = returnTo === NEW_CAMPAIGN_SETUP_PATH
    ? 'Back to campaign setup'
    : 'Back to campaign settings';

  return (
    <RequireServerAdmin>
      <div className="max-w-4xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
        {returnTo && (
          <Link to={returnTo} className="btn btn-ghost" style={{ width: 'fit-content', fontSize: 12.5 }}>
            ← {returnLabel}
          </Link>
        )}
        <h1 className="flex items-center gap-2 text-xl font-extrabold text-white"><GameIcon slug="spell-book" size={20} /> Rule packs</h1>
        <RulePacksCard />
      </div>
    </RequireServerAdmin>
  );
}
