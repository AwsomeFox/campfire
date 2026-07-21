/**
 * Campaign picker — landing page for authenticated users, styled after the
 * design's "Campaign hub" screen (card grid with cover strip + dashed
 * "New campaign" tile). Grid of campaign tiles plus a create-campaign tile
 * that launches the full NewCampaignWizard overlay (details -> rule system
 * -> POST + PATCH ruleSystem). Any user may create a campaign.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../app/auth';
import { useCampaigns } from '../../app/CampaignContext';
import { api, ApiError, API } from '../../lib/api';
import { Card, Chip, statusVariant, EmptyState, ErrorNote, Skeleton } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { NewCampaignWizard } from './NewCampaignWizard';
import type { Campaign } from '@campfire/schema';

/** Deterministic cover gradient per campaign, echoing the design's cc.cover swatches. */
const COVERS = [
  'linear-gradient(135deg, var(--color-accent-800), var(--color-accent-600))',
  'linear-gradient(135deg, var(--color-accent-2-800), var(--color-accent-2-600))',
  'linear-gradient(135deg, var(--color-neutral-800), var(--color-neutral-600))',
  'linear-gradient(135deg, #1f3d38, #2f6f5e)',
  'linear-gradient(135deg, #3a2a4a, #6c4f8f)',
];

function coverFor(id: number): string {
  return COVERS[id % COVERS.length];
}

function NewCampaignTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-2 text-center"
      style={{
        border: '1px dashed var(--color-neutral-700)',
        borderRadius: 'var(--radius-lg)',
        background: 'transparent',
        color: 'var(--color-neutral-400)',
        minHeight: 220,
        fontSize: 13,
      }}
    >
      <span
        className="grid place-items-center rounded-full text-lg"
        style={{ width: 34, height: 34, border: '1px dashed var(--color-neutral-700)' }}
      >
        +
      </span>
      New campaign
    </button>
  );
}

/**
 * POST a Campfire .zip export as multipart to /campaigns/import/archive. The JSON `api`
 * client can't send FormData (see ImageUpload.tsx), so this posts via fetch directly,
 * carrying the same dev-role headers and cookie credentials.
 */
async function importArchive(file: File): Promise<Campaign> {
  const form = new FormData();
  form.append('file', file);

  const headers: Record<string, string> = {};
  const devRole = localStorage.getItem('cf.devRole');
  const devUser = localStorage.getItem('cf.devUser');
  if (devRole) headers['x-dev-role'] = devRole;
  if (devUser) headers['x-dev-user'] = devUser;

  const res = await fetch(`${API}/campaigns/import/archive`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: form,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = Array.isArray(body.message) ? body.message.join('; ') : (body.message ?? message);
    } catch {
      /* non-json error body */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as Campaign;
}

/**
 * Import-campaign tile (issue #120) — the round-trip companion to export. Reads a
 * Campfire export from the user's disk and recreates the campaign fresh (new ids,
 * references remapped). Accepts BOTH export flavours (issue #236): a `.zip` (mdzip)
 * carries the maps/portraits and goes to /campaigns/import/archive; a `.json` is
 * text-only (no attachments) and goes to /campaigns/import. On success we reuse the
 * same post-create flow (refresh + navigate) as the wizard.
 */
function ImportCampaignTile({
  onImported,
  onError,
}: {
  onImported: (c: Campaign) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so re-picking the same file fires change again.
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const isZip =
        file.name.toLowerCase().endsWith('.zip') ||
        file.type === 'application/zip' ||
        file.type === 'application/x-zip-compressed';
      let created: Campaign;
      if (isZip) {
        // ZIP export: keeps maps & portraits — send the file straight to the archive endpoint.
        created = await importArchive(file);
      } else {
        const text = await file.text();
        let doc: unknown;
        try {
          doc = JSON.parse(text);
        } catch {
          throw new Error('That file is not a Campfire export — pick a .zip (with maps/portraits) or a .json export.');
        }
        created = await api.post<Campaign>(`${API}/campaigns/import`, doc);
      }
      await onImported(created);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="application/zip,application/json,.zip,.json"
        onChange={onFile}
        style={{ display: 'none' }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={importing}
        className="flex flex-col items-center justify-center gap-2 text-center"
        style={{
          border: '1px dashed var(--color-neutral-700)',
          borderRadius: 'var(--radius-lg)',
          background: 'transparent',
          color: 'var(--color-neutral-400)',
          minHeight: 220,
          fontSize: 13,
        }}
      >
        <span
          className="grid place-items-center rounded-full text-lg"
          style={{ width: 34, height: 34, border: '1px dashed var(--color-neutral-700)' }}
        >
          ⬆
        </span>
        {importing ? 'Importing…' : 'Import from export (.zip / .json)'}
      </button>
    </>
  );
}

function CampaignTile({
  campaign,
  role,
  onOpen,
  archived,
}: {
  campaign: Campaign;
  role: string | null;
  onOpen: () => void;
  archived?: boolean;
}) {
  return (
    <button
      onClick={onOpen}
      className="card elev-sm text-left overflow-hidden"
      style={{ padding: 0, gap: 0, ...(archived ? { opacity: 0.72 } : {}) }}
    >
      <div
        className="h-[88px] grid place-items-center"
        style={{ background: coverFor(campaign.id), ...(archived ? { filter: 'saturate(0.45)' } : {}) }}
      >
        <span
          style={{ fontFamily: 'var(--font-heading)', fontSize: 30, color: 'var(--color-accent-100)' }}
        >
          {campaign.name.charAt(0).toUpperCase()}
        </span>
      </div>
      <div className="flex flex-col gap-2.5" style={{ padding: '14px 16px 16px' }}>
        <div>
          <div className="card-title" style={{ fontSize: 16 }}>{campaign.name}</div>
          <div className="flex gap-1.5 flex-wrap" style={{ marginTop: 6 }}>
            <Chip variant={statusVariant(campaign.status)}>{campaign.status}</Chip>
            {archived && <Chip variant="private">read-only</Chip>}
            {role && (
              <Chip variant="dm">{role === 'dm' ? 'DM' : role === 'player' ? 'Player' : 'Viewer'}</Chip>
            )}
          </div>
        </div>
        {campaign.description && (
          <p className="text-muted line-clamp-2" style={{ fontSize: 11.5, margin: 0 }}>
            {campaign.description}
          </p>
        )}
        <div className="text-muted" style={{ fontSize: 11.5 }}>
          {campaign.sessionCount > 0 ? `Session ${campaign.sessionCount}` : 'No sessions yet'}
        </div>
      </div>
    </button>
  );
}

/** Best-effort "how long ago" label from an ISO timestamp, for the Trash list. */
function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/**
 * Campaign Trash (issue #116) — the recoverable other half of the now-soft DELETE.
 * Lists the caller's trashed campaigns with Restore (un-delete) and the deliberate
 * Delete permanently (purge: hard-cascade + on-disk wipe, gated behind a confirm).
 * Fetches its own list lazily; on restore it calls the parent `onChanged` so the main
 * hub grid picks the campaign back up.
 */
function TrashSection({ onChanged }: { onChanged: () => void | Promise<void> }) {
  const [trashed, setTrashed] = useState<Campaign[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<Campaign | null>(null);

  async function load() {
    try {
      setTrashed(await api.get<Campaign[]>(`${API}/campaigns/trash`));
    } catch {
      /* trash is a soft feature — a fetch hiccup just hides the section */
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function restore(c: Campaign) {
    setBusyId(c.id);
    setError(null);
    try {
      await api.post(`${API}/campaigns/${c.id}/restore`);
      setTrashed((prev) => prev.filter((x) => x.id !== c.id));
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't restore campaign.");
    } finally {
      setBusyId(null);
    }
  }

  async function purge(c: Campaign) {
    setBusyId(c.id);
    setError(null);
    try {
      await api.delete(`${API}/campaigns/${c.id}/purge`);
      setTrashed((prev) => prev.filter((x) => x.id !== c.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't permanently delete campaign.");
    } finally {
      setBusyId(null);
      setPurgeTarget(null);
    }
  }

  if (trashed.length === 0) return null;

  return (
    <>
      <div style={{ marginTop: 10 }}>
        <h4 style={{ margin: 0, color: 'var(--color-neutral-300)' }}>Trash</h4>
        <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 12.5 }}>
          Deleted campaigns are kept here — every note, session and uploaded file is intact.
          Restore one, or delete it permanently to reclaim its space.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {trashed.map((c) => (
          <div key={c.id} className="card elev-sm flex items-center gap-3" style={{ opacity: 0.85 }}>
            <div className="flex-1 min-w-0">
              <div className="card-title" style={{ fontSize: 14 }}>{c.name}</div>
              <div className="text-muted" style={{ fontSize: 11.5 }}>
                Deleted {timeAgo(c.deletedAt)}
              </div>
            </div>
            <button
              className="btn btn-secondary"
              style={{ fontSize: 12.5 }}
              disabled={busyId === c.id}
              onClick={() => void restore(c)}
            >
              {busyId === c.id ? 'Working…' : 'Restore'}
            </button>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12.5, color: '#f87171' }}
              disabled={busyId === c.id}
              onClick={() => setPurgeTarget(c)}
            >
              Delete permanently
            </button>
          </div>
        ))}
      </div>
      {error && <ErrorNote message={error} />}
      {purgeTarget && (
        <ConfirmDialog
          title={`Permanently delete "${purgeTarget.name}"?`}
          body={
            <p style={{ margin: 0 }}>
              This erases every row and every uploaded file for this campaign from disk.
              It cannot be undone.
            </p>
          }
          confirmLabel="Delete permanently"
          busy={busyId === purgeTarget.id}
          onConfirm={() => void purge(purgeTarget)}
          onCancel={() => setPurgeTarget(null)}
        />
      )}
    </>
  );
}

export function HomePage() {
  const { roleIn, refresh: refreshAuth } = useAuth();
  const { campaigns, loading, error, refresh } = useCampaigns();
  const navigate = useNavigate();
  const [justCreated, setJustCreated] = useState<Campaign[]>([]);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const allCampaigns = [...campaigns, ...justCreated.filter((c) => !campaigns.some((x) => x.id === c.id))];
  // Archived (paused/completed) campaigns are read-only server-side — keep them
  // out of the main hub grid so finished games stop cluttering the active list.
  const activeCampaigns = allCampaigns.filter((c) => c.status === 'active');
  const archivedCampaigns = allCampaigns.filter((c) => c.status !== 'active');

  async function onCampaignCreated(c: Campaign) {
    setJustCreated((prev) => [...prev, c]);
    // Refresh the campaign list (drives Layout's access gate) AND auth
    // memberships (drives roleIn / DM nav) BEFORE navigating. Navigating first
    // raced the refetch: Layout's stale-access check ran against the old list,
    // failed to find the just-created campaign, and latched the "You no longer
    // have access to this campaign" lock screen for that id until a hard
    // refresh (issue #103). allSettled so an API hiccup on one refresh still
    // lets us proceed rather than trapping the user on the wizard.
    await Promise.allSettled([refresh(), refreshAuth()]);
    setWizardOpen(false);
    navigate(`/c/${c.id}`);
  }

  if (wizardOpen) {
    return <NewCampaignWizard onClose={() => setWizardOpen(false)} onCreated={onCampaignCreated} />;
  }

  return (
    <div className="w-full max-w-[960px] mx-auto px-5 pt-7 pb-12 flex flex-col gap-4.5">
      <div>
        <h3 style={{ margin: 0 }}>Your campaigns</h3>
        <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
          Everything on this server, one sign-in. Roles are per campaign.
        </p>
      </div>

      {loading ? (
        <Card>
          <Skeleton lines={4} />
        </Card>
      ) : error ? (
        <ErrorNote message="Couldn't reach the server to load your campaigns." onRetry={() => void refresh()} />
      ) : allCampaigns.length === 0 ? (
        <div className="max-w-md space-y-4">
          <EmptyState icon="candle-flame" title="No campaigns yet — light the first fire." />
          <p className="text-muted" style={{ fontSize: 12.5, margin: 0 }}>
            New here as a player? Ask your DM or the server admin to add your account to a campaign — no need to
            create one.
          </p>
          <NewCampaignTile onClick={() => setWizardOpen(true)} />
          <ImportCampaignTile
            onImported={onCampaignCreated}
            onError={(m) => setImportError(m)}
          />
          {importError && <ErrorNote message={importError} />}
        </div>
      ) : (
        <>
          <div
            className="grid gap-3.5"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))' }}
          >
            {activeCampaigns.map((campaign) => (
              <CampaignTile
                key={campaign.id}
                campaign={campaign}
                role={roleIn(campaign.id)}
                onOpen={() => navigate(`/c/${campaign.id}`)}
              />
            ))}
            <NewCampaignTile onClick={() => setWizardOpen(true)} />
            <ImportCampaignTile
              onImported={onCampaignCreated}
              onError={(m) => setImportError(m)}
            />
          </div>
          {importError && <ErrorNote message={importError} />}

          {archivedCampaigns.length > 0 && (
            <>
              <div style={{ marginTop: 10 }}>
                <h4 style={{ margin: 0, color: 'var(--color-neutral-300)' }}>Archive</h4>
                <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 12.5 }}>
                  Paused and completed campaigns are read-only until a DM sets them back to active.
                </p>
              </div>
              <div
                className="grid gap-3.5"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))' }}
              >
                {archivedCampaigns.map((campaign) => (
                  <CampaignTile
                    key={campaign.id}
                    campaign={campaign}
                    role={roleIn(campaign.id)}
                    onOpen={() => navigate(`/c/${campaign.id}`)}
                    archived
                  />
                ))}
              </div>
            </>
          )}

          <TrashSection onChanged={async () => { await Promise.allSettled([refresh(), refreshAuth()]); }} />
        </>
      )}
    </div>
  );
}
