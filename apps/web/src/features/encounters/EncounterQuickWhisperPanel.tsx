import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { CampaignMember } from '@campfire/schema';
import { api, API } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { Card } from '../../components/ui';
import { NOTE_VISIBILITY_ICON, UI_ICON_SIZE } from '../../lib/uiIcons';
import { GameIcon } from '../../components/GameIcon';

export interface EncounterQuickWhisperPanelProps {
  campaignId: number;
  myUserId?: string | number;
  onError?: (msg: string | null) => void;
}

export function EncounterQuickWhisperPanel({ campaignId, myUserId, onError }: EncounterQuickWhisperPanelProps) {
  const { t } = useTranslation('encounters');
  const [recipientUserId, setRecipientUserId] = useState<string>('');
  const [body, setBody] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const membersQuery = useQuery({
    queryKey: queryKeys.campaignMembers(campaignId),
    queryFn: () => api.get<CampaignMember[]>(`${API}/campaigns/${campaignId}/members`),
    enabled: Number.isFinite(campaignId),
  });

  const availableMembers = useMemo(() => {
    const list = membersQuery.data ?? [];
    return list.filter((m) => String(m.userId) !== String(myUserId));
  }, [membersQuery.data, myUserId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!recipientUserId || !body.trim() || saving) return;

    setSaving(true);
    setLocalError(null);
    setSuccessMsg(null);
    onError?.(null);

    const recipient = availableMembers.find((m) => String(m.userId) === recipientUserId);
    const recipientName = recipient?.displayName || recipient?.username || recipientUserId;

    try {
      await api.post(`${API}/campaigns/${campaignId}/notes`, {
        body: body.trim(),
        visibility: 'whisper',
        recipientUserId,
      });
      setBody('');
      setSuccessMsg(t('encounters.whisper.sent', { name: recipientName }));
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch {
      const msg = t('encounters.whisper.error');
      setLocalError(msg);
      onError?.(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-2.5" data-testid="encounter-quick-whisper-panel">
      <div className="flex items-center gap-1.5 text-amber-300">
        <GameIcon slug={NOTE_VISIBILITY_ICON.whisper} size={UI_ICON_SIZE.xs} />
        <span className="card-kicker" style={{ margin: 0 }}>
          {t('encounters.whisper.panelTitle')}
        </span>
      </div>

      {localError && <p className="text-sm text-rose-400 m-0" data-testid="encounter-quick-whisper-error">{localError}</p>}
      {successMsg && <p className="text-sm text-emerald-400 m-0" data-testid="encounter-quick-whisper-success">{successMsg}</p>}

      <form onSubmit={handleSubmit} className="space-y-2 text-xs">
        <div className="field">
          <label htmlFor="encounter-whisper-recipient">{t('encounters.whisper.recipientLabel')}</label>
          <select
            id="encounter-whisper-recipient"
            className="input cf-target-44 w-full"
            value={recipientUserId}
            onChange={(e) => setRecipientUserId(e.target.value)}
            disabled={saving}
            data-testid="encounter-whisper-recipient-select"
          >
            <option value="">{t('encounters.whisper.selectRecipient')}</option>
            {availableMembers.map((m) => (
              <option key={String(m.userId)} value={String(m.userId)}>
                {m.displayName || m.username || `User #${m.userId}`}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="encounter-whisper-body">{t('encounters.whisper.messageLabel')}</label>
          <textarea
            id="encounter-whisper-body"
            className="input cf-target-44 w-full rounded border border-neutral-700 bg-neutral-950 p-2 text-slate-200 placeholder:text-neutral-500"
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('encounters.whisper.placeholder')}
            disabled={saving}
            data-testid="encounter-quick-whisper-textarea"
          />
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            className="btn btn-primary cf-target-44 text-xs"
            disabled={!recipientUserId || !body.trim() || saving}
            data-testid="encounter-quick-whisper-submit"
          >
            {saving ? '…' : t('encounters.whisper.send')}
          </button>
        </div>
      </form>
    </Card>
  );
}
