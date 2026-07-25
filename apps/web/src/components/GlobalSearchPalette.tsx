import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDialog } from './useDialog';
import { TextInput } from './ui';
import { useKeyboardCommandHint } from './KeyboardCommandProvider';

export function GlobalSearchPalette({
  campaignId,
  onClose,
}: {
  campaignId: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const { ariaKeyshortcuts } = useKeyboardCommandHint('globalSearch');

  const dialogRef = useDialog<HTMLDivElement>({
    onClose,
    initialFocusRef: inputRef,
    inertBackground: true,
  });

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function submit() {
    const term = query.trim();
    onClose();
    navigate(term ? `/c/${campaignId}/search?q=${encodeURIComponent(term)}` : `/c/${campaignId}/search`);
  }

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
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
          {t('keyboard.searchTitle')}
        </h2>
        <p className="text-sm text-muted mb-3">{t('keyboard.searchHint')}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <TextInput
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('nav.searchPlaceholder')}
            aria-label={t('nav.searchAria')}
            aria-keyshortcuts={ariaKeyshortcuts}
            autoComplete="off"
          />
        </form>
      </div>
    </div>,
    document.body,
  );
}
