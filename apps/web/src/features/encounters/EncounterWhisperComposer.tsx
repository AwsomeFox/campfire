import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, API } from '../../lib/api';
import { NOTE_VISIBILITY_ICON, UI_ICON_SIZE } from '../../lib/uiIcons';
import { GameIcon } from '../../components/GameIcon';

export interface EncounterWhisperComposerProps {
  campaignId: number;
  recipientUserId: string;
  recipientName: string;
  onClose: () => void;
  onSuccess?: () => void;
}

export function EncounterWhisperComposer({
  campaignId,
  recipientUserId,
  recipientName,
  onClose,
  onSuccess,
}: EncounterWhisperComposerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || saving) return;

    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/notes`, {
        body: text.trim(),
        visibility: 'whisper',
        recipientUserId,
      });
      if (!isMountedRef.current) return;
      setText('');
      onSuccess?.();
      onClose();
    } catch {
      if (isMountedRef.current) {
        setError(t('encounters.whisper.error'));
      }
    } finally {
      if (isMountedRef.current) {
        setSaving(false);
      }
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-2 rounded-lg border border-amber-500/30 bg-neutral-900/90 p-3 space-y-2 text-xs"
      data-testid="encounter-whisper-composer"
    >
      <div className="flex items-center justify-between gap-2 text-amber-300 font-semibold">
        <span className="flex items-center gap-1.5">
          <GameIcon slug={NOTE_VISIBILITY_ICON.whisper} size={UI_ICON_SIZE.xs} />
          {t('encounters.whisper.title', { name: recipientName })}
        </span>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('encounters.whisper.placeholder')}
        rows={2}
        className="w-full rounded border border-neutral-700 bg-neutral-950 p-2 text-slate-200 placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-amber-400"
        data-testid="encounter-whisper-textarea"
        disabled={saving}
        autoFocus
      />

      {error && <p className="text-rose-400 m-0" data-testid="encounter-whisper-error">{error}</p>}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="btn btn-ghost cf-target-44 text-xs"
        >
          {t('encounters.whisper.cancel')}
        </button>
        <button
          type="submit"
          disabled={!text.trim() || saving}
          className="btn btn-primary cf-target-44 text-xs"
          data-testid="encounter-whisper-submit"
        >
          {saving ? '…' : t('encounters.whisper.send')}
        </button>
      </div>
    </form>
  );
}
