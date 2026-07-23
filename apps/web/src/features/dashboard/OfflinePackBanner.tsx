/**
 * Per-campaign offline pack status + explicit download (issue #879).
 *
 * Accidental SW caching of every API GET is unsafe; instead the table opts into
 * a bounded manifest. This banner surfaces ready / stale / missing and offers a
 * single action to (re)download the pack.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  downloadCampaignOfflinePack,
  inspectCampaignOfflineManifest,
  offlinePackIndicator,
  type OfflineManifestInspection,
  type OfflinePackIndicator,
} from '../../lib/offlineCampaignManifest';

const LABEL: Record<OfflinePackIndicator, string> = {
  ready: 'Offline pack ready',
  stale: 'Offline pack stale — refresh to keep last-known data trustworthy',
  incomplete: 'Offline pack incomplete — some campaign reads are missing',
  missing: 'Offline pack not downloaded — campaign reads may be unavailable offline',
};

export function OfflinePackBanner({ campaignId }: { campaignId: number }) {
  const [inspection, setInspection] = useState<OfflineManifestInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!Number.isFinite(campaignId)) return;
    try {
      setInspection(await inspectCampaignOfflineManifest(campaignId));
    } catch {
      setInspection(null);
    }
  }, [campaignId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const indicator = inspection ? offlinePackIndicator(inspection) : 'missing';

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const result = await downloadCampaignOfflinePack(campaignId);
      if (!result.ok && result.failed.length > 0) {
        setError(
          result.quotaExceeded
            ? 'Storage quota exhausted while saving the offline pack.'
            : `Could not cache ${result.failed.length} offline read(s).`,
        );
      }
      await refresh();
    } catch {
      setError("Couldn't download the offline pack.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        border: '1px solid var(--color-neutral-700)',
        borderRadius: 'var(--radius-md)',
        fontSize: 13,
      }}
      data-offline-pack={indicator}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>{LABEL[indicator]}</div>
        {error ? <div className="text-muted reading-supporting">{error}</div> : null}
        {inspection && indicator !== 'ready' ? (
          <div className="text-muted reading-supporting">
            {inspection.missingCount} missing · {inspection.staleCount} stale
          </div>
        ) : null}
      </div>
      <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={busy} onClick={() => void download()}>
        {busy ? 'Saving…' : indicator === 'ready' ? 'Refresh pack' : 'Download for offline'}
      </button>
    </div>
  );
}
