/**
 * Rule systems card — server admin console, "Rule systems" section.
 * Lists installed rule packs (GET /api/v1/rules/packs), shows which campaigns use
 * each (usage visibility, #348), and lets an admin install a new one from ANY
 * supported source (POST /api/v1/rules/packs/install, #347) or uninstall an
 * existing one (DELETE /api/v1/rules/packs/:id).
 * Mirrors AdminPage's existing card/section conventions (Card, cf-inset,
 * cf-chip, table layout) — see UsersCard/TokensCard in AdminPage.tsx.
 *
 * Source picker (#347): the install panel is source-aware — the admin picks a
 * system (D&D 5e / PF2e / PF1e / Starfinder / 13th Age / Open Legend / OSR), the
 * section checkboxes come from THAT source's vocabulary (see lib/rules
 * RULE_SYSTEMS, mirroring the server's per-source validation), and OSR adds a
 * retroclone-variant sub-select. Sources whose upstream default is dead/absent
 * (SOURCES_REQUIRING_URL, #346) surface an explicit mirror-URL field instead of a
 * broken install button. The "already installed" check keys on the SELECTED
 * source's pack slug, not "any pack exists" — installing a second system while
 * another is present is a fresh install of the new pack.
 *
 * Install is incremental PER PACK: POSTing /rules/packs/install for a slug that's
 * already installed ADDS any sections not yet present (200, body has
 * {added, skippedExisting}) instead of failing outright. A 409 can still
 * happen (e.g. a concurrent install racing on the same slug/section) — the
 * server's error message is surfaced as-is rather than a generic string.
 * Large sections (spells, monsters) can take 30s+ to import, so the button
 * locks for the duration and the copy sets that expectation.
 *
 * Usage visibility (#348): usage is computed client-side from GET /campaigns
 * (the campaigns visible to the caller, each carrying its `ruleSystem` slug) —
 * the "Used by" column and the uninstall confirm both read this. Uninstalling a
 * pack resets every campaign pointing at it to none/homebrew server-side (the
 * DELETE clears `campaign.ruleSystem` to '' in the same transaction, so no
 * dangling slug is left behind); the confirm names those campaigns and requires
 * an explicit acknowledgement when the count is non-zero.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Campaign,
  OsrInstallSystem,
  RulePack,
  RulePackInstall,
  RulePackInstallJob,
  RulePackInstallSection,
  RulePackInstallSource,
} from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, Btn, Skeleton, EmptyState } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { RULE_SYSTEMS, ruleSystemBySource, sectionLabel, SOURCES_REQUIRING_URL } from '../../lib/rules';

/**
 * Install is a non-blocking background job (issue #20): POST /rules/packs/install returns
 * 202 with a job, and we poll GET /rules/packs/install-jobs/:id for per-section progress
 * and the final result instead of blocking on a single long request.
 */
async function pollInstallJob(jobId: string, onProgress: (job: RulePackInstallJob) => void): Promise<RulePackInstallJob> {
  const started = Date.now();
  for (;;) {
    const job = await api.get<RulePackInstallJob>(`${API}/rules/packs/install-jobs/${jobId}`);
    onProgress(job);
    if (job.status === 'completed' || job.status === 'failed') return job;
    if (Date.now() - started > 5 * 60_000) throw new ApiError(0, 'Install timed out — check the server logs.');
    await new Promise((r) => setTimeout(r, 750));
  }
}

/** The pack slug the selected source (and OSR variant) installs under — used for the per-pack "already installed" check. */
function selectedPackSlug(source: RulePackInstallSource, osrVariant: OsrInstallSystem): string {
  const meta = ruleSystemBySource(source);
  if (source === 'osr') return meta?.osrVariants?.find((v) => v.value === osrVariant)?.slug ?? 'basic-fantasy';
  return meta?.packSlug ?? '';
}

export function RulePacksCard() {
  const [packs, setPacks] = useState<RulePack[] | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Campaigns power usage visibility (#348) — computed client-side by matching each
      // campaign's ruleSystem slug against a pack. GET /campaigns returns the campaigns
      // visible to the caller, so it can't fail the whole card: a usage read that errors
      // just degrades to "0 known campaigns".
      const [list, camps] = await Promise.all([
        api.get<RulePack[]>(`${API}/rules/packs`),
        api.get<Campaign[]>(`${API}/campaigns`).catch(() => [] as Campaign[]),
      ]);
      setPacks(list);
      setCampaigns(camps);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load rule packs.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // slug -> campaigns using it (visible to the caller). One pass over campaigns.
  const usageBySlug = useMemo(() => {
    const map = new Map<string, Campaign[]>();
    for (const c of campaigns) {
      if (!c.ruleSystem) continue;
      const list = map.get(c.ruleSystem) ?? [];
      list.push(c);
      map.set(c.ruleSystem, list);
    }
    return map;
  }, [campaigns]);

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-3">
        <h2 className="font-bold text-white text-sm">Rule systems</h2>
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}

      {loading && !packs ? (
        <Skeleton lines={3} />
      ) : packs && packs.length === 0 ? (
        <EmptyState icon="📚" title="No rule packs installed" hint="Install one from a source below." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase text-slate-500 text-left">
                <th className="py-2 pr-4 font-bold">Name</th>
                <th className="pr-4 font-bold">Version</th>
                <th className="pr-4 font-bold">License</th>
                <th className="pr-4 font-bold">Entries</th>
                <th className="pr-4 font-bold">Used by</th>
                <th className="pr-4 font-bold">Installed</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {(packs ?? []).map((p) => (
                <PackRow
                  key={p.id}
                  pack={p}
                  usedBy={usageBySlug.get(p.slug) ?? []}
                  onChange={load}
                  installing={installing}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <InstallPanel
        packs={packs ?? []}
        installing={installing}
        onInstallingChange={setInstalling}
        onInstalled={() => {
          void load();
        }}
        onError={setError}
      />

      <p className="text-[11px] text-slate-500">
        Rule packs are server-wide (not per-campaign) and readable by any signed-in user. Installing or removing a
        pack here affects every campaign that has it selected as its rule system. Usage counts reflect the campaigns
        visible to you.
      </p>
    </Card>
  );
}

function PackRow({
  pack,
  usedBy,
  onChange,
  installing,
}: {
  pack: RulePack;
  usedBy: Campaign[];
  onChange: () => void;
  installing: boolean;
}) {
  const [uninstalling, setUninstalling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
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

  const usageCount = usedBy.length;

  return (
    <tr>
      <td className="py-2.5 pr-4 font-semibold text-white">{pack.name}</td>
      <td className="pr-4 text-slate-400">{pack.version || '—'}</td>
      <td className="pr-4 text-slate-400">{pack.license || '—'}</td>
      <td className="pr-4 text-slate-400">{pack.entryCount}</td>
      <td className="pr-4 text-slate-400">
        {usageCount === 0 ? (
          <span className="text-slate-600">—</span>
        ) : (
          <span title={usedBy.map((c) => c.name).join(', ')}>
            {usageCount} {usageCount === 1 ? 'campaign' : 'campaigns'}
          </span>
        )}
      </td>
      <td className="pr-4 text-slate-400">{timeAgo(pack.installedAt)}</td>
      <td className="text-right whitespace-nowrap">
        {error && <span className="text-[11px] text-rose-400 mr-2">{error}</span>}
        <button
          type="button"
          className="text-[11px] text-rose-500/80 hover:text-rose-400 disabled:opacity-40"
          disabled={installing || uninstalling}
          onClick={() => {
            setAcknowledged(false);
            setConfirming(true);
          }}
        >
          uninstall
        </button>
        {confirming && (
          <ConfirmDialog
            title={`Uninstall "${pack.name}"?`}
            body={
              <div className="space-y-2 text-left">
                <p>
                  This removes {pack.entryCount} entries and cannot be undone.
                  {usageCount === 0
                    ? ' No campaign visible to you has it selected.'
                    : ` The following ${usageCount === 1 ? 'campaign is' : usageCount + ' campaigns are'} using it and will be reset to None / homebrew (existing sheets keep their numbers; combat math falls back to D&D 5e defaults):`}
                </p>
                {usageCount > 0 && (
                  <ul className="list-disc pl-5 text-slate-300 max-h-40 overflow-y-auto">
                    {usedBy.map((c) => (
                      <li key={c.id}>{c.name}</li>
                    ))}
                  </ul>
                )}
                {usageCount > 0 && (
                  <label className="flex items-start gap-2 pt-1 text-slate-200">
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      onChange={(e) => setAcknowledged(e.target.checked)}
                    />
                    <span>
                      I understand {usageCount === 1 ? 'this campaign' : `these ${usageCount} campaigns`} will lose this
                      rule system.
                    </span>
                  </label>
                )}
              </div>
            }
            confirmLabel={uninstalling ? 'Uninstalling…' : 'Uninstall'}
            busy={uninstalling}
            confirmDisabled={usageCount > 0 && !acknowledged}
            onConfirm={uninstall}
            onCancel={() => setConfirming(false)}
          />
        )}
      </td>
    </tr>
  );
}

function InstallPanel({
  packs,
  installing,
  onInstallingChange,
  onInstalled,
  onError,
}: {
  packs: RulePack[];
  installing: boolean;
  onInstallingChange: (v: boolean) => void;
  onInstalled: () => void;
  onError: (msg: string | null) => void;
}) {
  const [source, setSource] = useState<RulePackInstallSource>('open5e');
  const [osrVariant, setOsrVariant] = useState<OsrInstallSystem>('basic-fantasy');
  const [url, setUrl] = useState('');
  const meta = ruleSystemBySource(source) ?? RULE_SYSTEMS[0];
  const requiresUrl = SOURCES_REQUIRING_URL.has(source);
  const [sections, setSections] = useState<Set<RulePackInstallSection>>(new Set(meta.sections));
  const [done, setDone] = useState<string | null>(null);
  const [progress, setProgress] = useState<RulePackInstallJob['progress']>([]);

  // Switching source resets the section checkboxes to THAT source's full set (#347).
  useEffect(() => {
    const m = ruleSystemBySource(source);
    if (m) setSections(new Set(m.sections));
    setDone(null);
  }, [source]);

  const packSlug = selectedPackSlug(source, osrVariant);
  const hasExistingPack = packs.some((p) => p.slug === packSlug);
  const existingPack = packs.find((p) => p.slug === packSlug);

  function toggleSection(value: RulePackInstallSection) {
    if (installing) return;
    setSections((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  const canSubmit = !installing && sections.size > 0 && (!requiresUrl || url.trim().length > 0);

  async function install() {
    // Guard against double-fire: installs can take a couple of minutes for large
    // sections, so the button must not be clickable again until the job settles.
    if (!canSubmit) return;
    onInstallingChange(true);
    setDone(null);
    setProgress([]);
    onError(null);
    try {
      const body: RulePackInstall = {
        source,
        sections: Array.from(sections),
        ...(requiresUrl && url.trim() ? { url: url.trim() } : {}),
        ...(source === 'osr' ? { system: osrVariant } : {}),
      };
      // POST returns 202 with a background job (issue #20) — poll it for per-section progress.
      const enqueued = await api.post<RulePackInstallJob>(`${API}/rules/packs/install`, body);
      const job = await pollInstallJob(enqueued.id, (j) => setProgress(j.progress));
      if (job.status === 'failed') {
        onError(job.error ?? "Couldn't install the rule pack.");
        return;
      }
      if (job.outcome === 'updated') {
        setDone(`Done — added ${job.added ?? 0}, already had ${job.skippedExisting ?? 0}.`);
      } else {
        setDone(`Installed ${job.pack?.entryCount ?? 0} entries.`);
      }
      onInstalled();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't install the rule pack.");
    } finally {
      onInstallingChange(false);
      setProgress([]);
    }
  }

  return (
    <div className="cf-inset border-amber-500/30 p-3.5 space-y-2.5">
      <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">
        {hasExistingPack ? `Add sections to ${existingPack?.name ?? meta.label}` : 'Install a rule system'}
      </p>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm text-slate-300">
          <span className="text-[10px] uppercase tracking-widest text-slate-500">Source</span>
          <select
            className="cf-input !min-h-0 !py-1.5 text-sm"
            value={source}
            disabled={installing}
            onChange={(e) => setSource(e.target.value as RulePackInstallSource)}
          >
            {RULE_SYSTEMS.map((s) => (
              <option key={s.source} value={s.source}>
                {s.label} — {s.license}
              </option>
            ))}
          </select>
        </label>

        {source === 'osr' && (
          <label className="flex flex-col gap-1 text-sm text-slate-300">
            <span className="text-[10px] uppercase tracking-widest text-slate-500">Variant</span>
            <select
              className="cf-input !min-h-0 !py-1.5 text-sm"
              value={osrVariant}
              disabled={installing}
              onChange={(e) => setOsrVariant(e.target.value as OsrInstallSystem)}
            >
              {(meta.osrVariants ?? []).map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label} — {v.license}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <p className="text-[11px] text-slate-400">{meta.blurb}</p>
      <p className="text-[11px] text-slate-500">
        <span className="text-slate-400 font-semibold">Rules:</span> {meta.mechanics}
      </p>

      <div className="flex gap-3 flex-wrap">
        {meta.sections.map((sec) => (
          <label key={sec} className="flex items-center gap-1.5 text-sm text-slate-300">
            <input type="checkbox" checked={sections.has(sec)} onChange={() => toggleSection(sec)} disabled={installing} />
            {sectionLabel(sec)}
          </label>
        ))}
      </div>

      {requiresUrl && (
        <label className="flex flex-col gap-1 text-sm text-slate-300">
          <span className="text-[10px] uppercase tracking-widest text-slate-500">Mirror URL (required)</span>
          <input
            type="url"
            className="cf-input !min-h-0 !py-1.5 text-sm"
            placeholder="https://…"
            value={url}
            disabled={installing}
            onChange={(e) => setUrl(e.target.value)}
          />
          <span className="text-[11px] text-amber-300/80">
            This source has no verified public API yet (#346) — provide a mirror or self-hosted server URL to import from.
          </span>
        </label>
      )}

      <p className="text-[11px] text-slate-500">
        {hasExistingPack
          ? `Adds any selected sections not already in "${existingPack?.name ?? meta.label}" — sections you already have are left untouched.`
          : `Installs "${meta.label}" as a new server-wide pack.`}{' '}
        Large sections (spells, monsters) can take <strong>a couple of minutes</strong> — the button locks while the
        import runs, so it&apos;s safe to wait rather than re-click.
      </p>

      {installing && (
        <div className="text-[11px] text-amber-300 space-y-1">
          <p>Installing… large sections can take a couple of minutes.</p>
          {progress.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {progress.map((p) => (
                <span
                  key={p.section}
                  className={
                    p.status === 'done'
                      ? 'text-emerald-400'
                      : p.status === 'failed'
                        ? 'text-rose-400'
                        : 'text-slate-400'
                  }
                >
                  {sectionLabel(p.section)}
                  {p.status === 'done' ? ` ✓ (${p.imported})` : p.status === 'running' ? ' …' : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {done && !installing && <p className="text-[11px] text-emerald-400">{done}</p>}
      <div className="flex justify-end">
        <Btn className="!min-h-0 !py-1.5 text-xs" onClick={install} disabled={!canSubmit}>
          {installing ? 'Installing…' : hasExistingPack ? 'Add sections' : 'Install pack'}
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
