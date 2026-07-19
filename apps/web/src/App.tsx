import HealthChip from "./HealthChip";
import CampaignsCard from "./CampaignsCard";

export default function App() {
  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-10">
      <div className="flex w-full max-w-md flex-1 flex-col gap-6">
        <header className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-50">
            🔥 Campfire
          </h1>
          <p className="text-sm text-[var(--cf-dim)]">
            The party's shared memory.
          </p>
        </header>

        <HealthChip />

        <CampaignsCard />

        <footer className="mt-2 text-center text-xs text-[var(--cf-faint)]">
          Full UI in design — see design/ mockups · placeholder build
        </footer>
      </div>
    </div>
  );
}
