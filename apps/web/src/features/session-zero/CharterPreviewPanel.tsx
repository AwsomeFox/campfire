import { useTranslation } from 'react-i18next';
/**
 * The table's boundaries, shown BEFORE joining — issue #600.
 *
 * Rendered on the public /join/:code page from the charter the invite preview now
 * carries. This is the whole point of the issue: previously a person could learn a
 * campaign's name and their role and nothing else, so the only way to discover the
 * table's lines and veils was to join, which is the commitment those boundaries were
 * supposed to inform.
 *
 * Lives under features/session-zero/ rather than features/auth/ deliberately. This
 * directory is one of the i18n checker's SURFACE_ROOTS, so every string added here has
 * to go through the catalogue in both locales — the consent copy is exactly the copy
 * that must not silently ship English-only to somebody being asked to agree to it.
 */
import type { CharterPreview } from '@campfire/schema';

function List({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div>
      <h4 style={{ margin: '0 0 4px', fontSize: 13 }}>{title}</h4>
      {items.length === 0 ? (
        <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
          {empty}
        </p>
      ) : (
        <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 13 }}>
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CharterPreviewPanel({ charter }: { charter: CharterPreview }) {
  const { t } = useTranslation();
  return (
    <section
      aria-labelledby="charter-preview-heading"
      data-testid="charter-preview"
      style={{ display: 'grid', gap: 10, textAlign: 'start' }}
    >
      <div>
        <h3 id="charter-preview-heading" style={{ margin: 0, fontSize: 15 }}>
          {t('sessionZero.preview.heading')}
        </h3>
        <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
          {t('sessionZero.preview.intro', { version: charter.version })}
        </p>
      </div>

      <List
        title={t('sessionZero.charter.lines.title')}
        items={charter.lines}
        empty={t('sessionZero.preview.noneRecorded')}
      />
      <List
        title={t('sessionZero.charter.veils.title')}
        items={charter.veils}
        empty={t('sessionZero.preview.noneRecorded')}
      />
      <List
        title={t('sessionZero.charter.safetyTools.title')}
        items={charter.safetyTools}
        empty={t('sessionZero.preview.noneRecorded')}
      />

      {charter.previewPolicy === 'full' && charter.houseRules.trim() !== '' && (
        <div>
          <h4 style={{ margin: '0 0 4px', fontSize: 13 }}>{t('sessionZero.charter.houseRules.title')}</h4>
          <p style={{ margin: 0, fontSize: 13, whiteSpace: 'pre-wrap' }}>{charter.houseRules}</p>
        </div>
      )}
      {charter.previewPolicy === 'full' && charter.toneAndExpectations.trim() !== '' && (
        <div>
          <h4 style={{ margin: '0 0 4px', fontSize: 13 }}>{t('sessionZero.charter.tone.title')}</h4>
          <p style={{ margin: 0, fontSize: 13, whiteSpace: 'pre-wrap' }}>{charter.toneAndExpectations}</p>
        </div>
      )}
      {charter.previewPolicy === 'boundaries' && (
        <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
          {t('sessionZero.preview.boundariesOnly')}
        </p>
      )}

      <div>
        <h4 style={{ margin: '0 0 4px', fontSize: 13 }}>{t('sessionZero.preview.aiHeading')}</h4>
        <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
          {charter.aiExternalContentPolicy === 'disabled'
            ? t('sessionZero.preview.aiDisabled')
            : t('sessionZero.preview.aiMemberConsent')}
        </p>
      </div>
    </section>
  );
}

export default CharterPreviewPanel;
