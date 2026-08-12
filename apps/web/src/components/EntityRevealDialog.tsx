/**
 * Confirmation dialog for hidden → visible entity reveals (issue #710).
 * Shows the entity type, audience, a preview of player-visible content, and a
 * warning that observed disclosure cannot be retracted on connected clients.
 */
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from './ConfirmDialog';
import type { RevealPreviewItem } from './entityRevealPreview';

export type RevealEntityKind = 'quest' | 'npc' | 'faction' | 'location';

const ENTITY_TYPE_KEY: Record<RevealEntityKind, string> = {
  quest: 'secrecy.entityTypeQuest',
  npc: 'secrecy.entityTypeNpc',
  faction: 'secrecy.entityTypeFaction',
  location: 'secrecy.entityTypeLocation',
};

export function EntityRevealDialog({
  entityKind,
  entityName,
  preview,
  busy = false,
  onConfirm,
  onCancel,
}: {
  entityKind: RevealEntityKind;
  entityName: string;
  preview: RevealPreviewItem[];
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const entityType = t(ENTITY_TYPE_KEY[entityKind]);

  return (
    <ConfirmDialog
      title={t('secrecy.revealDialogTitle', { entityType })}
      body={
        <div className="space-y-3 text-sm text-slate-300">
          <p className="m-0">
            <strong className="text-slate-100">{entityName}</strong>
          </p>
          <p className="m-0 text-xs text-slate-400">{t('secrecy.revealAudience')}</p>
          {preview.length > 0 && (
            <div>
              <p className="m-0 mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
                {t('secrecy.revealPreviewHeading')}
              </p>
              <ul
                className="m-0 pl-4 space-y-1.5 list-disc"
                data-testid="entity-reveal-preview"
              >
                {preview.map((item, index) => (
                  <li key={`${item.label}-${index}`}>
                    <span className="text-secondary">{item.label}: </span>
                    <span className="text-slate-200 break-words">{item.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="m-0 text-xs text-amber-300/90 border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 rounded px-2.5 py-2">
            {t('secrecy.revealIrreversible')}
          </p>
        </div>
      }
      confirmLabel={t('secrecy.revealConfirm')}
      pendingLabel={t('secrecy.revealPending')}
      danger={true}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
