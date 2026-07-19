import { useEffect, useState, type FormEvent } from "react";
import type { Campaign } from "./types";

type LoadState = "loading" | "ready" | "error";

function statusChipClass(status: string): string {
  switch (status.toLowerCase()) {
    case "active":
      return "cf-chip-active";
    case "completed":
      return "cf-chip-completed";
    case "failed":
    case "archived":
      return "cf-chip-failed";
    default:
      return "cf-chip-available";
  }
}

export default function CampaignsCard() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function loadCampaigns() {
    setLoadState((prev) => (prev === "ready" ? prev : "loading"));
    try {
      const res = await fetch("/api/v1/campaigns");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as Campaign[];
      setCampaigns(Array.isArray(data) ? data : []);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }

  useEffect(() => {
    loadCampaigns();
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setSubmitting(true);
    setFormError(null);

    // Optimistic entry so the list feels responsive even before refresh.
    const optimisticId = `optimistic-${Date.now()}`;
    const optimisticCampaign: Campaign = {
      id: optimisticId,
      name: trimmed,
      description: null,
      status: "pending",
      dangerLevel: null,
      sessionCount: 0,
      createdAt: new Date().toISOString(),
    };
    setCampaigns((prev) => [...prev, optimisticCampaign]);

    try {
      const res = await fetch("/api/v1/campaigns", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-dev-role": "dm",
          "x-dev-user": "dev",
        },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setName("");
      await loadCampaigns();
    } catch {
      // Roll back the optimistic entry and let the user know.
      setCampaigns((prev) => prev.filter((c) => c.id !== optimisticId));
      setFormError("Couldn't reach the API — campaign not saved.");
    } finally {
      setSubmitting(false);
    }
  }

  const isDown = loadState === "error";

  return (
    <section className={`cf-card p-5 ${isDown ? "opacity-60" : ""}`}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-100">
          Campaigns
        </h2>
        {isDown && (
          <span className="text-xs text-rose-400">API unreachable</span>
        )}
      </div>

      {loadState === "loading" && (
        <p className="text-sm text-[var(--cf-dim)]">Loading campaigns…</p>
      )}

      {loadState === "error" && (
        <div className="cf-inset mb-4 p-3 text-sm text-[var(--cf-dim)]">
          Can't reach the API right now.{" "}
          <button
            type="button"
            onClick={loadCampaigns}
            className="font-semibold text-[var(--cf-accent)] hover:underline"
          >
            Retry
          </button>
        </div>
      )}

      {loadState === "ready" && campaigns.length === 0 && (
        <p className="mb-4 text-sm text-[var(--cf-dim)]">
          No campaigns yet — light the first fire.
        </p>
      )}

      {loadState === "ready" && campaigns.length > 0 && (
        <ul className="mb-4 flex flex-col gap-2">
          {campaigns.map((c) => (
            <li
              key={c.id}
              className="cf-inset flex items-center justify-between gap-3 px-3 py-2.5"
            >
              <span className="truncate text-sm font-medium text-slate-100">
                {c.name}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className={`cf-chip ${statusChipClass(c.status)}`}>
                  {c.status}
                </span>
                <span className="text-xs text-[var(--cf-faint)]">
                  Session {c.sessionCount}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New campaign name…"
            disabled={submitting}
            className="cf-input"
            aria-label="New campaign name"
          />
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="cf-btn shrink-0"
          >
            {submitting ? "Adding…" : "Add"}
          </button>
        </div>
        {formError && <p className="text-xs text-rose-400">{formError}</p>}
      </form>
    </section>
  );
}
