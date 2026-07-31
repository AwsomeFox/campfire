import { useTranslation } from 'react-i18next';
/**
 * Charter versions and the consent gate — issue #600.
 *
 * Mounted on SessionZeroPage beneath the charter itself. Two audiences share one panel:
 *
 *  - Every member sees which version the table is OPERATING UNDER (`effectiveVersion`),
 *    whether a newer one is awaiting their answer, and exactly what changed. The diff is
 *    the part that matters: "the charter changed, please re-agree" with no statement of
 *    what changed is how people learn to click through safety prompts.
 *  - The DM additionally sees who is still outstanding and can publish the draft.
 *
 * The panel never invents a verdict of its own — `awaitingRenewal`, `effectiveVersion`
 * and `outstanding` all come from the server, which is also what gates the AI.
 */
import { useCallback, useEffect, useState } from 'react';
import type { SessionZeroConsentStatus } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { Card, Btn, ErrorNote } from '../../components/ui';

function DiffList({ label, items, tone }: { label: string; items: string[]; tone: 'add' | 'remove' }) {
  if (items.length === 0) return null;
  return (
    <li style={{ fontSize: 12 }}>
      <span style={{ color: tone === 'remove' ? '#fca5a5' : '#86efac' }}>{label}</span>{' '}
      <span className="text-muted">{items.join('; ')}</span>
    </li>
  );
}

export function CharterConsentPanel({
  campaignId,
  isDm,
  onPublished,
}: {
  campaignId: number;
  isDm: boolean;
  onPublished?: () => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SessionZeroConsentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setStatus(await api.get<SessionZeroConsentStatus>(`${API}/campaigns/${campaignId}/session-zero/consent`));
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'sessionZero.errors.loadConsent' }));
    }
  }, [campaignId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const answer = useCallback(
    async (state: 'acknowledged' | 'discuss' | 'declined') => {
      if (!status?.latestVersion) return;
      setBusy(true);
      setError(null);
      try {
        await api.post(`${API}/campaigns/${campaignId}/session-zero/consent`, {
          versionId: status.latestVersion.id,
          state,
          note,
        });
        setNote('');
        await load();
      } catch (err) {
        setError(translateApiError(err, t, { fallbackKey: 'sessionZero.errors.acknowledge' }));
      } finally {
        setBusy(false);
      }
    },
    [campaignId, status, note, load, t],
  );

  const publish = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/session-zero/versions`, { changeSummary: note });
      setNote('');
      await load();
      onPublished?.();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'sessionZero.errors.publish' }));
    } finally {
      setBusy(false);
    }
  }, [campaignId, note, load, onPublished, t]);

  if (!status) {
    return error ? <ErrorNote message={error} onRetry={load} /> : null;
  }

  const { latestVersion, effectiveVersion, awaitingRenewal, outstanding, mine, diff } = status;

  return (
    <Card
      density="compact" elev="sm"
      aria-labelledby="charter-consent-heading"
      data-testid="charter-consent"
      style={{ display: 'grid', gap: 10 }}
    >
      {/*
        h2, not h3. This card is a direct sibling of the page's other top-level cards —
        "Access support" is an h2 — and it renders BEFORE them in the DOM, so an h3 here
        jumps straight from the route's h1 and axe's `heading-order` rule fails the whole
        page. `card-kicker` carries the visual weight, so the level is free to be whatever
        the document outline needs it to be.
      */}
      <h2 id="charter-consent-heading" className="card-kicker" style={{ margin: 0 }}>
        {t('sessionZero.consent.heading')}
      </h2>

      {error && <ErrorNote message={error} onRetry={load} />}

      {!latestVersion ? (
        <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
          {isDm ? t('sessionZero.consent.noVersionsDm') : t('sessionZero.consent.noVersionsPlayer')}
        </p>
      ) : (
        <>
          <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
            {effectiveVersion
              ? t('sessionZero.consent.effective', { version: effectiveVersion.version })
              : t('sessionZero.consent.noneEffective')}
            {' · '}
            {t('sessionZero.consent.latest', { version: latestVersion.version })}
          </p>

          {awaitingRenewal && (
            <div role="status" style={{ display: 'grid', gap: 6 }}>
              <p style={{ margin: 0, fontSize: 13 }}>
                {diff?.material
                  ? t('sessionZero.consent.awaitingMaterial')
                  : t('sessionZero.consent.awaitingRoutine')}
              </p>
              {diff && (
                <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                  <DiffList label={t('sessionZero.consent.removedLines')} items={diff.removedLines} tone="remove" />
                  <DiffList label={t('sessionZero.consent.removedVeils')} items={diff.removedVeils} tone="remove" />
                  <DiffList
                    label={t('sessionZero.consent.removedSafetyTools')}
                    items={diff.removedSafetyTools}
                    tone="remove"
                  />
                  <DiffList label={t('sessionZero.consent.addedLines')} items={diff.addedLines} tone="add" />
                  <DiffList label={t('sessionZero.consent.addedVeils')} items={diff.addedVeils} tone="add" />
                  <DiffList
                    label={t('sessionZero.consent.addedSafetyTools')}
                    items={diff.addedSafetyTools}
                    tone="add"
                  />
                </ul>
              )}
              {latestVersion.changeSummary && (
                <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
                  {t('sessionZero.consent.dmNote', { note: latestVersion.changeSummary })}
                </p>
              )}
            </div>
          )}

          <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
            {mine
              ? t(`sessionZero.consent.yours.${mine.state}`)
              : t('sessionZero.consent.yoursNone')}
          </p>

          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            {isDm ? t('sessionZero.consent.summaryLabel') : t('sessionZero.consent.noteLabel')}
            <input
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
            />
          </label>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn disabled={busy} onClick={() => void answer('acknowledged')}>
              {t('sessionZero.consent.acknowledge')}
            </Btn>
            <Btn disabled={busy} onClick={() => void answer('discuss')}>
              {t('sessionZero.consent.discuss')}
            </Btn>
            <Btn disabled={busy} onClick={() => void answer('declined')}>
              {t('sessionZero.consent.decline')}
            </Btn>
          </div>

          {isDm && outstanding.length > 0 && (
            <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
              {t('sessionZero.consent.outstanding', {
                names: outstanding.map((o) => o.userName || o.userId).join(', '),
              })}
            </p>
          )}
        </>
      )}

      {isDm && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn disabled={busy} onClick={() => void publish()}>
            {t('sessionZero.consent.publish')}
          </Btn>
          <span className="text-muted" style={{ fontSize: 11.5, alignSelf: 'center' }}>
            {t('sessionZero.consent.publishHint')}
          </span>
        </div>
      )}
    </Card>
  );
}

export default CharterConsentPanel;
