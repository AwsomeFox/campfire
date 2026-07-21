/**
 * /admin/ai — AI console (provider config & usage). Part of the /admin/* page
 * split (issue #350); see AdminPage.tsx for the full route map.
 */
import { RequireServerAdmin } from './RequireServerAdmin';
import { AiConsoleCard } from './AiConsoleCard';

export default function AdminAiPage() {
  return (
    <RequireServerAdmin>
      <div className="max-w-4xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
        <h1 className="text-xl font-extrabold text-white">🤖 AI console</h1>
        <AiConsoleCard />
      </div>
    </RequireServerAdmin>
  );
}
