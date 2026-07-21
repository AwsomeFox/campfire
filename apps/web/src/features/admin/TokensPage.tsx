/**
 * Lightweight per-user API tokens page — /tokens.
 * Tokens are per-USER (not admin-gated); this reuses the same TokensCard the
 * server admin console shows, so any signed-in user can manage their own tokens.
 */
import { TokensCard } from './TokensCard';
import { GameIcon } from '../../components/GameIcon';

export default function TokensPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
      <h1 className="flex items-center gap-2 text-xl font-extrabold text-white"><GameIcon slug="key" size={20} /> API tokens</h1>
      <TokensCard />
    </div>
  );
}
