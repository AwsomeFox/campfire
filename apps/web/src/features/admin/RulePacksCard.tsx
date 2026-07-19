/**
 * Rule systems card — server admin console, "Rule systems" section.
 * Lists installed rule packs (GET /api/v1/rules/packs) and lets an admin
 * install a new one from Open5e (POST /api/v1/rules/packs/install), or
 * uninstall an existing one (DELETE /api/v1/rules/packs/:id).
 * Mirrors AdminPage's existing card/section conventions (Card, cf-inset,
 * cf-chip, table layout) — see UsersCard/TokensCard in AdminPage.tsx.
 */
import { useCallback, useEffect, useState } from 'react';
import type { RulePack, RulePackInstall } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, Btn, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';

type Section = NonNullable<RulePackInstall['sections']>[number];

const SECTION_OPTIONS: { value: Section; label: string }[] = [
  { value: 'spells', label: 'Spells' },
  { value: 'monsters', label: 'Monsters' },
  { value: 'items', label: 'Items' },
  { value: 'conditions', label: 'Conditions' },
];

export function RulePacksCard() {
  const [packs, setPacks] = useState<RulePack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.get<RulePack[]>(`${API}/rules/packs`);
      setPacks(list);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load rule packs.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-3">
        <h2 className="font-bold text-white text-sm">Rule systems</h2>
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}

      {loading && !packs ? (
        <Skeleton lines={3} />
      ) : packs && packs.length === 0 ? (
        <EmptyState icon="📚" title="No rule packs installed" hint="Install one from Open5e below." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase text-slate-500 text-left">
                <th className="py-2 pr-4 font-bold">Name</th>
                <th className="pr-4 font-bold">Version</th>
                <th className="pr-4 font-bold">License</th>
                <th className="pr-4 font-bold">Entries</th>
                <th className="pr-4 font-bold">Installed</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {(packs ?? []).map((p) => (
                <PackRow key={p.id} pack={p} onChange={load} installing={installing} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <InstallPanel
        installing={installing}
        onInstallingChange={setInstalling}
        onInstalled={() => {
          void load();
        }}
        onError={setError}
      />

      <p className="text-[11px] text-slate-500">
        Rule packs are server-wide (not per-campaign) and readable by any signed-in user. Installing or removing a
        pack here affects every campaign that has it selected as its rule system.
      </p>
    </Card>
  );
}

function PackRow({ pack, onChange, installing }: { pack: RulePack; onChange: () => void; installing: boolean }) {
  const [uninstalling, setUninstalling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function uninstall() {
    setUninstalling(true);
    setError(null);
    try {
      await api.delete(`${API}/rules/packs/${pack.id}`);
      setConfirming(false);
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't uninstall this pack.");
    } finally {
      setUninstalling(false);
    }
  }

  return (
    <tr>
      <td className="py-2.5 pr-4 font-semibold text-white">{pack.name}</td>
      <td className="pr-4 text-slate-400">{pack.version || '—'}</td>
      <td className="pr-4 text-slate-400">{pack.license || '—'}</td>
      <td className="pr-4 text-slate-400">{pack.entryCount}</td>
      <td className="pr-4 text-slate-400">{timeAgo(pack.installedAt)}</td>
      <td className="text-right whitespace-nowrap">
        {error && <span className="text-[11px] text-rose-400 mr-2">{error}</span>}
        <button
          type="button"
          className="text-[11px] text-rose-500/80 hover:text-rose-400 disabled:opacity-40"
          disabled={installing || uninstalling}
          onClick={() => setConfirming(true)}
        >
          uninstall
        </button>
        {confirming && (
          <ConfirmDialog
            title={`Uninstall "${pack.name}"?`}
            body="Any campaign using this rule system will fall back to none/homebrew. This cannot be undone."
            confirmLabel={uninstalling ? 'Uninstalling…' : 'Uninstall'}
            busy={uninstalling}
            onConfirm={uninstall}
            onCancel={() => setConfirming(false)}
          />
        )}
      </td>
    </tr>
  );
}

function InstallPanel({
  installing,
  onInstallingChange,
  onInstalled,
  onError,
}: {
  installing: boolean;
  onInstallingChange: (v: boolean) => void;
  onInstalled: () => void;
  onError: (msg: string | null) => void;
}) {
  const [sections, setSections] = useState<Set<Section>>(new Set(SECTION_OPTIONS.map((s) => s.value)));
  const [done, setDone] = useState<string | null>(null);

  function toggleSection(value: Section) {
    if (installing) return;
    setSections((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function install() {
    // Guard against double-fire: installs can take 1-2 minutes for large sections
    // (Open5e import is a slow paginated fetch), so the button must not be
    // clickable again until the request settles.
    if (installing || sections.size === 0) return;
    onInstallingChange(true);
    setDone(null);
    onError(null);
    try {
      const body: RulePackInstall = { source: 'open5e', sections: Array.from(sections) };
      await api.post<RulePack>(`${API}/rules/packs/install`, body);
      setDone('Installed.');
      onInstalled();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't install the rule pack.");
    } finally {
      onInstallingChange(false);
    }
  }

  return (
    <div className="cf-inset border-amber-500/30 p-3.5 space-y-2.5">
      <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">Install from Open5e</p>
      <div className="flex gap-3 flex-wrap">
        {SECTION_OPTIONS.map((opt) => (
          <label key={opt.value} className="flex items-center gap-1.5 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={sections.has(opt.value)}
              onChange={() => toggleSection(opt.value)}
              disabled={installing}
            />
            {opt.label}
          </label>
        ))}
      </div>
      <p className="text-[11px] text-slate-500">
        Pulls the D&amp;D 5e SRD content from the open Open5e API (OGL-licensed). Large sections (spells, monsters)
        can take <strong>1-2 minutes</strong> — the button locks while the import runs, so it&apos;s safe to wait
        rather than re-click.
      </p>
      {installing && <p className="text-[11px] text-amber-300">Installing… this can take a minute or two.</p>}
      {done && !installing && <p className="text-[11px] text-emerald-400">{done}</p>}
      <div className="flex justify-end">
        <Btn className="!min-h-0 !py-1.5 text-xs" onClick={install} disabled={installing || sections.size === 0}>
          {installing ? 'Installing…' : 'Install pack'}
        </Btn>
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}
