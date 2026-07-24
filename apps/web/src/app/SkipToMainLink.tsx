import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { MAIN_CONTENT_ID, SKIP_TO_MAIN_ID, focusSkipDestination } from './routeFocus';

type Props = {
  mainRef: RefObject<HTMLElement | null>;
};

/**
 * First tab stop in the authenticated shell — jumps to #main-content without
 * relying on native hash scrolling (issue #591 / 200% zoom).
 */
export function SkipToMainLink({ mainRef }: Props) {
  const { t } = useTranslation();

  return (
    <a
      id={SKIP_TO_MAIN_ID}
      href={`#${MAIN_CONTENT_ID}`}
      className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-md focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[var(--color-accent)]"
      style={{
        background: 'var(--color-surface)',
        color: 'var(--color-text)',
        fontSize: 14,
      }}
      onClick={(event) => {
        event.preventDefault();
        const main = mainRef.current;
        if (!main) return;
        focusSkipDestination(main);
      }}
    >
      {t('nav.skipToMain')}
    </a>
  );
}
