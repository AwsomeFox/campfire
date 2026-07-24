/**
 * Wires "Draft with AI" into PageHeader secondary actions (issue #707) while
 * preserving dialog disclosure semantics (aria-expanded / aria-controls).
 */
import { useId, useState, type ReactNode } from 'react';
import type { CoDmDraftTarget } from '@campfire/schema';
import type { PageHeaderSecondaryAction } from '../../components/PageHeader';
import { DraftWithAiButton } from './DraftWithAiButton';
import { useDraftWithAiAvailable } from './useDraftWithAiAvailable';

export function usePageHeaderDraftWithAi({
  campaignId,
  target,
  label = 'Draft with AI',
  enabled = true,
}: {
  campaignId: number;
  target: CoDmDraftTarget;
  label?: string;
  enabled?: boolean;
}): {
  secondaryAction: PageHeaderSecondaryAction | null;
  draftDialog: ReactNode;
} {
  const available = useDraftWithAiAvailable(campaignId);
  const [open, setOpen] = useState(false);
  const dialogId = useId();

  const active = available && enabled;

  const secondaryAction: PageHeaderSecondaryAction | null = active
    ? {
        key: 'draft',
        label,
        onClick: () => setOpen(true),
        ariaHaspopup: 'dialog',
        ariaExpanded: open,
        ariaControls: open ? dialogId : undefined,
      }
    : null;

  const draftDialog = active ? (
    <DraftWithAiButton
      campaignId={campaignId}
      target={target}
      label={label}
      showTrigger={false}
      open={open}
      onOpenChange={setOpen}
      dialogId={dialogId}
    />
  ) : null;

  return { secondaryAction, draftDialog };
}
