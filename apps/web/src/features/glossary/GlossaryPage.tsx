import { Card } from '../../components/ui';
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageTitle } from '../../components/PageTitle';
import {
  GLOSSARY_TERM_IDS,
  GLOSSARY_TERMS,
  glossaryAnchorId,
} from './glossaryTerms';

export default function GlossaryPage() {
  const { t } = useTranslation();
  const location = useLocation();

  useEffect(() => {
    if (!location.hash) return;
    const rawId = location.hash.slice(1);
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      id = rawId;
    }
    const handle = window.requestAnimationFrame(() => {
      document.getElementById(id)?.focus({ preventScroll: false });
    });
    return () => window.cancelAnimationFrame(handle);
  }, [location.hash]);

  return (
    <div className="w-full mx-auto px-5 pt-7 pb-20 md:pb-12 flex flex-col gap-4" style={{ maxWidth: 860 }}>
      <div>
        <PageTitle>{t('glossary.title')}</PageTitle>
        <p className="text-muted text-sm m-0" style={{ maxWidth: 680 }}>
          {t('glossary.intro')}
        </p>
      </div>

      <div className="grid gap-3">
        {GLOSSARY_TERM_IDS.map((termId) => {
          const term = GLOSSARY_TERMS[termId];
          const headingId = `${glossaryAnchorId(termId)}-heading`;
          return (
            <Card
              key={termId}
              id={glossaryAnchorId(termId)}
              tabIndex={-1}
              density="compact" elev="sm" className="settings-anchor"
              aria-labelledby={headingId}
              style={{ scrollMarginTop: 72 }}
            >
              <div className="flex items-start gap-2 flex-wrap">
                <h2 id={headingId} className="text-lg font-bold text-white m-0">
                  {t(term.labelKey)}
                </h2>
                <span className="tag tag-outline" style={{ fontSize: 10 }}>
                  {t(term.audienceKey)}
                </span>
                <span className="tag tag-neutral" style={{ fontSize: 10 }}>
                  {t(term.phaseKey)}
                </span>
              </div>
              <p className="text-sm text-[var(--color-neutral-300)] m-0">{t(term.definitionKey)}</p>
              <dl className="grid gap-2 sm:grid-cols-2 text-xs m-0">
                <div className="cf-inset p-2">
                  <dt className="font-bold text-[var(--color-neutral-300)]">{t('glossary.metaAudience')}</dt>
                  <dd className="m-0 text-muted">{t(term.audienceKey)}</dd>
                </div>
                <div className="cf-inset p-2">
                  <dt className="font-bold text-[var(--color-neutral-300)]">{t('glossary.metaVisibility')}</dt>
                  <dd className="m-0 text-muted">{t(term.visibilityKey)}</dd>
                </div>
              </dl>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
