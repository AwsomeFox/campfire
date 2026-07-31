import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCampaignAccess } from '../app/CampaignAccessContext';
import { api, API, ApiError } from '../lib/api';
import { Btn, Dialog, ErrorNote, TextArea } from './ui';
import { useKeyboardCommandHint } from './KeyboardCommandProvider';

export function QuickCaptureDialog({
  campaignId,
  onClose,
}: {
  campaignId: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { isDm, canMemberWrite } = useCampaignAccess();
  const [body, setBody] = useState('');
  const [dest, setDest] = useState<'private' | 'inbox'>('private');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const { ariaKeyshortcuts } = useKeyboardCommandHint('quickCapture');

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const save = useCallback(async () => {
    if (!canMemberWrite) return;
    const trimmed = body.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      if (dest === 'inbox') {
        await api.post(`${API}/campaigns/${campaignId}/inbox`, { body: trimmed });
      } else {
        await api.post(`${API}/campaigns/${campaignId}/notes`, { body: trimmed, audience: 'private' });
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('keyboard.quickCaptureFailed'));
    } finally {
      setSaving(false);
    }
  }, [body, campaignId, canMemberWrite, dest, onClose, t]);

  if (!canMemberWrite) return null;

  return (
    <Dialog
      title={<span className="block mb-1">{t('keyboard.quickCaptureTitle')}</span>}
      titleId={titleId}
      titleAs="h2"
      className="w-full max-w-lg [&_.dialog-title]:[font-family:inherit] [&_.dialog-title]:text-lg [&_.dialog-title]:font-semibold [&_.dialog-title]:text-white"
      onBackdropClick={() => !saving && onClose()}
      initialFocusRef={inputRef}
      ariaBusy={saving}
      data-keyboard-command-overlay
      afterBody={
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted mb-3">{t('keyboard.quickCaptureHint')}</p>
          {error && <ErrorNote message={error} />}
          {!isDm && (
            <div className="flex gap-2 mb-3 text-xs">
              <button
                type="button"
                className={`btn btn-ghost cf-density-xs ${dest === 'private' ? 'btn-primary' : ''}`}
                onClick={() => setDest('private')}
              >
                {t('keyboard.quickCapturePrivate')}
              </button>
              <button
                type="button"
                className={`btn btn-ghost cf-density-xs ${dest === 'inbox' ? 'btn-primary' : ''}`}
                onClick={() => setDest('inbox')}
              >
                {t('keyboard.quickCaptureInbox')}
              </button>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="space-y-3"
          >
            <TextArea
              ref={inputRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder={dest === 'inbox' ? t('keyboard.quickCapturePlaceholderInbox') : t('keyboard.quickCapturePlaceholderPrivate')}
              aria-label={t('keyboard.quickCaptureBodyLabel')}
              aria-keyshortcuts={ariaKeyshortcuts}
              disabled={saving}
            />
            <div className="flex justify-end gap-2">
              <Btn type="button" ghost disabled={saving} onClick={onClose}>
                {t('nav.cancel')}
              </Btn>
              <Btn type="submit" disabled={saving || !body.trim()}>
                {saving ? t('nav.saving') : dest === 'inbox' ? t('keyboard.quickCaptureSend') : t('nav.save')}
              </Btn>
            </div>
          </form>
        </div>
      }
    />
  );
}
