/**
 * Notification preferences (issue #789) — the Notifications card on /preferences.
 *
 * Re-adds the per-campaign notification controls that were removed when the
 * original Notifications card was dropped. For every campaign the user belongs
 * to they can set each notification CATEGORY to immediate / digest / muted and
 * configure a quiet-hours window (with timezone). Critical categories
 * (access/security) are rendered locked ("Always on") — the server never lets
 * them be silenced.
 *
 * Status messages route through the shared Announcer (useAnnounce), never a new
 * aria-live region, so the app keeps a single assertive live region.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CRITICAL_NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORIES,
  isCriticalNotificationCategory,
  type NotificationCampaignPreferences,
  type NotificationCategory,
  type NotificationDeliveryMode,
  type NotificationPreferences,
} from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';
import { useAnnounce } from '../../components/Announcer';
import { Card, ErrorNote } from '../../components/ui';

const MODES: NotificationDeliveryMode[] = ['immediate', 'digest', 'muted'];

/** minutes-of-day (0..1439) -> "HH:MM" for a native time input. */
function minutesToHhmm(minutes: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.trunc(minutes)));
  const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
  const mm = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** "HH:MM" -> minutes-of-day, or null when unparseable. */
function hhmmToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

function categoryLabelKey(category: NotificationCategory): string {
  return `preferences.notifCategory${category.charAt(0).toUpperCase()}${category.slice(1)}`;
}

export function NotificationPreferencesCard() {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const [drafts, setDrafts] = useState<NotificationCampaignPreferences[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [savingIds, setSavingIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<NotificationPreferences>(`${API}/notifications/preferences`);
        if (!cancelled) setDrafts(res.campaigns);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const editableCategories = useMemo(
    () => NOTIFICATION_CATEGORIES.filter((c) => !isCriticalNotificationCategory(c)),
    [],
  );
  const criticalCategories = CRITICAL_NOTIFICATION_CATEGORIES;

  function updateDraft(campaignId: number, mutate: (prev: NotificationCampaignPreferences) => NotificationCampaignPreferences) {
    setDrafts((prev) =>
      prev ? prev.map((c) => (c.campaignId === campaignId ? mutate(c) : c)) : prev,
    );
  }

  function setMode(campaignId: number, category: NotificationCategory, mode: NotificationDeliveryMode) {
    updateDraft(campaignId, (prev) => ({ ...prev, categories: { ...prev.categories, [category]: mode } }));
  }

  function setQuiet(campaignId: number, patch: Partial<NotificationCampaignPreferences['quietHours']>) {
    updateDraft(campaignId, (prev) => ({ ...prev, quietHours: { ...prev.quietHours, ...patch } }));
  }

  async function save(campaign: NotificationCampaignPreferences) {
    setSavingIds((prev) => new Set(prev).add(campaign.campaignId));
    try {
      // Only send editable categories — the server ignores critical ones anyway.
      const categories: Partial<Record<NotificationCategory, NotificationDeliveryMode>> = {};
      for (const category of editableCategories) categories[category] = campaign.categories[category];
      const updated = await api.put<NotificationCampaignPreferences>(
        `${API}/notifications/preferences/${campaign.campaignId}`,
        { categories, quietHours: campaign.quietHours },
      );
      updateDraft(campaign.campaignId, () => updated);
      announce(t('preferences.notifSaved'));
    } catch (err) {
      announce(err instanceof ApiError ? err.message : t('preferences.notifSaveError'), { assertive: true });
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(campaign.campaignId);
        return next;
      });
    }
  }

  function isValidTimezone(tz: string): boolean {
    if (!tz.trim()) return false;
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }

  if (loadError) {
    return (
      <Card density="compact" elev="sm" data-testid="notification-preferences">
        <span className="card-kicker">{t('preferences.notifTitle')}</span>
        <ErrorNote message={t('preferences.notifLoadError')} />
      </Card>
    );
  }

  if (drafts === null) {
    return (
      <Card density="compact" elev="sm" data-testid="notification-preferences">
        <span className="card-kicker">{t('preferences.notifTitle')}</span>
        <p className="text-muted" style={{ fontSize: 13 }}>{t('preferences.notifLoading')}</p>
      </Card>
    );
  }

  return (
    <Card density="compact" elev="sm" data-testid="notification-preferences">
      <span className="card-kicker">{t('preferences.notifTitle')}</span>
      <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>{t('preferences.notifBlurb')}</p>

      {drafts.length === 0 && (
        <p className="text-muted" style={{ fontSize: 13 }}>{t('preferences.notifNoCampaigns')}</p>
      )}

      {drafts.map((campaign) => {
        const timeId = `notif-quiet-${campaign.campaignId}`;
        return (
          <div
            key={campaign.campaignId}
            className="cf-inset"
            data-testid={`notif-campaign-${campaign.campaignId}`}
            style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <strong style={{ fontSize: 13.5 }}>{campaign.campaignName}</strong>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {editableCategories.map((category) => (
                <div key={category} className="flex items-center gap-3 flex-wrap">
                  <label
                    htmlFor={`notif-mode-${campaign.campaignId}-${category}`}
                    style={{ flex: 1, minWidth: 140, fontSize: 13 }}
                  >
                    {t(categoryLabelKey(category))}
                  </label>
                  <select
                    id={`notif-mode-${campaign.campaignId}-${category}`}
                    className="input"
                    data-testid={`notif-mode-${campaign.campaignId}-${category}`}
                    style={{ maxWidth: 160 }}
                    value={campaign.categories[category]}
                    onChange={(e) => setMode(campaign.campaignId, category, e.target.value as NotificationDeliveryMode)}
                  >
                    {MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {t(`preferences.notifMode${mode.charAt(0).toUpperCase()}${mode.slice(1)}`)}
                      </option>
                    ))}
                  </select>
                </div>
              ))}

              {criticalCategories.map((category) => (
                <div key={category} className="flex items-center gap-3 flex-wrap">
                  <span style={{ flex: 1, minWidth: 140, fontSize: 13 }}>{t(categoryLabelKey(category))}</span>
                  <span className="tag" data-testid={`notif-alwayson-${campaign.campaignId}-${category}`} style={{ fontSize: 11.5 }}>
                    {t('preferences.notifAlwaysOn')}
                  </span>
                </div>
              ))}
            </div>

            <fieldset style={{ border: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <legend style={{ fontSize: 12.5, fontWeight: 600 }}>{t('preferences.notifQuietHours')}</legend>
              <label className="flex items-center gap-2" style={{ fontSize: 13 }}>
                <input
                  type="checkbox"
                  data-testid={`notif-quiet-enabled-${campaign.campaignId}`}
                  checked={campaign.quietHours.enabled}
                  onChange={(e) => setQuiet(campaign.campaignId, { enabled: e.target.checked })}
                />
                {t('preferences.notifQuietHoursEnable')}
              </label>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="field" style={{ maxWidth: 130 }}>
                  <label htmlFor={`${timeId}-from`}>{t('preferences.notifQuietFrom')}</label>
                  <input
                    id={`${timeId}-from`}
                    type="time"
                    className="input"
                    data-testid={`notif-quiet-from-${campaign.campaignId}`}
                    value={minutesToHhmm(campaign.quietHours.startMinute)}
                    onChange={(e) => {
                      const m = hhmmToMinutes(e.target.value);
                      if (m !== null) setQuiet(campaign.campaignId, { startMinute: m });
                    }}
                  />
                </div>
                <div className="field" style={{ maxWidth: 130 }}>
                  <label htmlFor={`${timeId}-to`}>{t('preferences.notifQuietTo')}</label>
                  <input
                    id={`${timeId}-to`}
                    type="time"
                    className="input"
                    data-testid={`notif-quiet-to-${campaign.campaignId}`}
                    value={minutesToHhmm(campaign.quietHours.endMinute)}
                    onChange={(e) => {
                      const m = hhmmToMinutes(e.target.value);
                      if (m !== null) setQuiet(campaign.campaignId, { endMinute: m });
                    }}
                  />
                </div>
                <div className="field" style={{ flex: 1, minWidth: 160 }}>
                  <label htmlFor={`${timeId}-tz`}>{t('preferences.notifQuietTimezone')}</label>
                  <input
                    id={`${timeId}-tz`}
                    className="input"
                    data-testid={`notif-quiet-tz-${campaign.campaignId}`}
                    value={campaign.quietHours.timezone}
                    onChange={(e) => setQuiet(campaign.campaignId, { timezone: e.target.value })}
                    maxLength={64}
                    aria-invalid={campaign.quietHours.timezone.trim() !== '' && !isValidTimezone(campaign.quietHours.timezone)}
                  />
                  {campaign.quietHours.timezone.trim() !== '' && !isValidTimezone(campaign.quietHours.timezone) && (
                    <span className="text-muted" style={{ fontSize: 11.5 }} role="alert">
                      {t('preferences.notifQuietTimezoneInvalid')}
                    </span>
                  )}
                </div>
              </div>
            </fieldset>

            <div>
              <button
                type="button"
                className="btn btn-primary"
                data-testid={`notif-save-${campaign.campaignId}`}
                disabled={savingIds.has(campaign.campaignId)}
                onClick={() => void save(campaign)}
              >
                {savingIds.has(campaign.campaignId) ? t('preferences.notifSaving') : t('preferences.notifSave')}
              </button>
            </div>
          </div>
        );
      })}
    </Card>
  );
}
