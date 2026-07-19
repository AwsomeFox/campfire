import { useEffect, useRef, useState } from "react";
import type { HealthResponse } from "./types";

type HealthState =
  | { status: "checking" }
  | { status: "online"; version?: string }
  | { status: "offline" };

const POLL_INTERVAL_MS = 5000;

export default function HealthChip() {
  const [health, setHealth] = useState<HealthState>({ status: "checking" });
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function checkHealth() {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await fetch("/healthz");
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as HealthResponse;
        if (!cancelled) {
          setHealth(
            data.ok
              ? { status: "online", version: data.version }
              : { status: "offline" },
          );
        }
      } catch {
        if (!cancelled) setHealth({ status: "offline" });
      } finally {
        inFlight.current = false;
      }
    }

    checkHealth();
    const id = setInterval(checkHealth, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <span
        className={`cf-chip ${
          health.status === "online"
            ? "cf-chip-online"
            : health.status === "offline"
              ? "cf-chip-offline"
              : "cf-chip-neutral"
        }`}
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            health.status === "online"
              ? "bg-emerald-400"
              : health.status === "offline"
                ? "bg-rose-400"
                : "bg-slate-400"
          }`}
        />
        {health.status === "online" &&
          `API online${health.version ? ` (v${health.version})` : ""}`}
        {health.status === "offline" && "API offline"}
        {health.status === "checking" && "Checking API…"}
      </span>
      <a
        href="/api/docs"
        target="_blank"
        rel="noreferrer"
        className="cf-chip cf-chip-neutral hover:text-slate-100"
      >
        API docs ↗
      </a>
    </div>
  );
}
