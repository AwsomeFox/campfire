/**
 * Disclosure of what leaves the server when an external AI provider is enabled (issue #455).
 * Rendered before saving/testing a provider so admins and DMs see the context boundary
 * up front. Copy is sourced from the canonical `AI_EXTERNAL_PROVIDER_PRIVACY` manifest in
 * @campfire/schema so it cannot drift from the server's actual outbound behavior.
 */
import { AI_EXTERNAL_PROVIDER_PRIVACY } from '@campfire/schema';

const privacy = AI_EXTERNAL_PROVIDER_PRIVACY;

export function AiProviderPrivacyNotice({ compact = false }: { compact?: boolean }) {
  return (
    <section
      id={privacy.settingsAnchorId}
      aria-labelledby={`${privacy.settingsAnchorId}-title`}
      className="flex flex-col gap-2"
      style={{
        padding: compact ? '10px 12px' : '12px 14px',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-divider)',
        background: 'var(--color-neutral-900)',
        scrollMarginTop: 72,
      }}
      data-testid="ai-provider-privacy-notice"
    >
      <h3
        id={`${privacy.settingsAnchorId}-title`}
        style={{ margin: 0, fontSize: compact ? 12 : 13, fontWeight: 700, color: 'var(--color-text)' }}
      >
        {privacy.noticeTitle}
      </h3>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45 }}>
        {privacy.localByDefault}
      </p>
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45 }}>
        {privacy.externalException}
      </p>
      {!compact && (
        <>
          <p style={{ margin: '2px 0 0', fontSize: 11, fontWeight: 700, color: 'var(--color-neutral-200)' }}>
            Context that may be sent to your provider
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, lineHeight: 1.45 }} className="text-muted">
            {privacy.contextCategories.map((category) => (
              <li key={category.label}>
                <span style={{ color: 'var(--color-text)', fontWeight: 600 }}>{category.label}</span>
                {' — '}
                {category.description}
              </li>
            ))}
          </ul>
          <p style={{ margin: '2px 0 0', fontSize: 11, fontWeight: 700, color: 'var(--color-neutral-200)' }}>
            Never sent
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, lineHeight: 1.45 }} className="text-muted">
            {privacy.exclusions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      )}
      <p className="text-muted" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45 }}>
        <strong style={{ color: 'var(--color-text)' }}>Retention:</strong> {privacy.retentionNote}
      </p>
    </section>
  );
}
