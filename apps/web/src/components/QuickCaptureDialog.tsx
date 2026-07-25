import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api, API, ApiError } from '../lib/api';
import { useCampaignAccess } from '../app/CampaignAccessContext';
import { useDialog } from './useDialog';
import { Btn, ErrorNote, TextArea } from './ui';
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dest, setDest] = useState<'private' | 'inbox'>('private');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useRef(`quick-capture-title-${Math.random().toString(36).slice(2)}`).current;
  const { ariaKeyshortcuts } = useKeyboardCommandHint('quickCapture');

  const dialogRef = useDialog<HTMLDivElement>({
    onClose,
    disabled: saving,
    initialFocusRef: inputRef,
    inertBackground: true,
  });

  const save = useCallback(async () => {
    if (!body.trim() || !canMemberWrite) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      if (dest === 'inbox') {
        await api.post(`${API}/campaigns/${campaignId}/inbox`, { body: body.trim() });
      } else {
        await api.post(`${API}/campaigns/${campaignId}/notes`, {
          body: body.trim(),
          visibility: 'private',
        });
      }
      setBody('');
      setSaved(true);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('keyboard.quickCaptureFailed'));
    } finally {
      setSaving(false);
    }
  }, [body, campaignId, canMemberWrite, dest, onClose, t]);

  if (!canMemberWrite) return null;

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-keyboard-command-overlay
        className="dialog w-full max-w-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="text-lg font-semibold text-white mb-2">
          {t('keyboard.quickCaptureTitle')}
        </h2>
        <p className="text-sm text-muted mb-3">{t('keyboard.quickCaptureHint')}</p>
        {error && <ErrorNote message={error} />}
        {saved && (
          <p className="text-sm text-emerald-400 mb-2" role="status">
            {dest === 'inbox' ? t('keyboard.quickCaptureSavedInbox') : t('keyboard.quickCaptureSavedPrivate')}
          </p>
        )}
        {!isDm && (
          <div className="flex gap-2 mb-2 text-xs">
            <button
              type="button"
              className={`btn btn-ghost !min-h-0 !py-1 ${dest === 'private' ? 'btn-primary' : ''}`}
              onClick={() => setDest('private')}
            >
              {t('keyboard.quickCapturePrivate')}
            </button>
            <button
              type="button"
              className={`btn btn-ghost !min-h-0 !py-1 ${dest === 'inbox' ? 'btn-primary' : ''}`}
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
    </div>,
    document.body,
  );
}
