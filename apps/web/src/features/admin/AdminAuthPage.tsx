/**
 * /admin/auth — OIDC/SSO configuration and API tokens. Part of the /admin/*
 * page split (issue #350); see AdminPage.tsx for the full route map.
 *
 * TokensCard is shared with the per-user /tokens page (apps/web/src/features/
 * admin/TokensPage.tsx) — tokens are per-user, not admin-scoped, so an admin
 * viewing this page manages their own tokens same as anyone at /tokens.
 */
import { RequireServerAdmin } from './RequireServerAdmin';
import { OidcCard } from './OidcCard';
import { TokensCard } from './TokensCard';
import { GameIcon } from '../../components/GameIcon';

export default function AdminAuthPage() {
  return (
    <RequireServerAdmin>
      <div className="max-w-4xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
        <h1 className="flex items-center gap-2 text-xl font-extrabold text-white"><GameIcon slug="padlock" size={20} /> Auth</h1>
        <OidcCard />
        <TokensCard />
      </div>
    </RequireServerAdmin>
  );
}
