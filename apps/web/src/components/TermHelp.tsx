import { useEffect, useState, type HTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDisclosure } from './useDisclosure';
import {
  GLOSSARY_TERMS,
  glossaryTermHref,
  termHelpStorageKey,
  type GlossaryTermId,
} from '../features/glossary/glossaryTerms';

export function TermHelp({
  termId,
  className = '',
  align = 'start',
}: {
  termId: GlossaryTermId;
  className?: string;
  align?: 'start' | 'end';
}) {
  const { t } = useTranslation();
  const term = GLOSSARY_TERMS[termId];
  const label = t(term.labelKey);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(termHelpStorageKey(termId)) === '1';
    } catch {
      return false;
    }
  });
  const { open, setOpen, buttonProps, regionProps } = useDisclosure({
    focusManagement: false,
    regionLabel: t('glossary.termHelpRegion', { term: label }),
  });
  const { ref: regionRef, ...regionAttrs } = regionProps;
  void regionRef;

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, setOpen]);

  if (dismissed) return null;

  function dismiss() {
    try {
      localStorage.setItem(termHelpStorageKey(termId), '1');
    } catch {
      /* localStorage can be unavailable in private modes; the visible dismiss still works. */
    }
    setOpen(false);
    setDismissed(true);
  }

  return (
    <span className={`cf-term-help cf-term-help--${align} ${className}`.trim()}>
      <button
        {...buttonProps}
        type="button"
        className="cf-term-help__trigger"
        aria-label={t('glossary.termHelpAria', { term: label })}
        title={undefined}
        data-testid={`term-help-trigger-${termId}`}
      >
        ?
      </button>
      {open && (
        <span
          {...(regionAttrs as HTMLAttributes<HTMLSpanElement>)}
          className="cf-term-help__panel card elev-md"
          data-testid={`term-help-panel-${termId}`}
        >
          <span className="cf-term-help__title">{label}</span>
          <span className="cf-term-help__body">{t(term.shortKey)}</span>
          <span className="cf-term-help__meta">
            <span>{t('glossary.metaAudience')}: {t(term.audienceKey)}</span>
            <span>{t('glossary.metaVisibility')}: {t(term.visibilityKey)}</span>
          </span>
          <span className="cf-term-help__actions">
            <Link to={glossaryTermHref(termId)} className="cf-term-help__link" onClick={() => setOpen(false)}>
              {t('glossary.openGlossary')}
            </Link>
            <button type="button" className="cf-term-help__dismiss" onClick={dismiss}>
              {t('glossary.dismiss')}
            </button>
          </span>
        </span>
      )}
    </span>
  );
}
