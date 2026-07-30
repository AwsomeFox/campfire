import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Dialog, TextInput } from './ui';
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

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function submit() {
    const term = query.trim();
    onClose();
    navigate(term ? `/c/${campaignId}/search?q=${encodeURIComponent(term)}` : `/c/${campaignId}/search`);
  }

  return (
    <Dialog
      title={t('keyboard.searchTitle')}
      titleId={titleId}
      titleAs="h2"
      className="w-full max-w-lg"
      onBackdropClick={onClose}
      initialFocusRef={inputRef}
      data-keyboard-command-overlay
    >
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
    </Dialog>
  );
}
