import type { QuestStatus } from '@campfire/schema';
import { GameIcon } from './GameIcon';
import { Chip } from './ui';
import { npcDispositionPresentation, questStatusPresentation } from './entitySemantics';

export function QuestStatusBadge({
  status,
  className = '',
  iconSize = 11,
}: {
  status: QuestStatus | string;
  className?: string;
  iconSize?: number;
}) {
  const presentation = questStatusPresentation(status);
  return (
    <Chip variant={presentation.variant} className={className}>
      <span
        className="inline-flex items-center gap-1"
        data-semantic="quest-status"
        data-semantic-value={status}
        data-semantic-variant={presentation.variant}
      >
        <GameIcon slug={presentation.icon} size={iconSize} />
        <span>{presentation.label}</span>
      </span>
    </Chip>
  );
}

export function NpcDispositionBadge({
  disposition,
  className = '',
  iconSize = 11,
}: {
  disposition: string | null | undefined;
  className?: string;
  iconSize?: number;
}) {
  const presentation = npcDispositionPresentation(disposition);
  return (
    <Chip variant={presentation.variant} className={className}>
      <span
        className="inline-flex items-center gap-1"
        data-semantic="npc-disposition"
        data-semantic-value={disposition || 'neutral'}
        data-semantic-variant={presentation.variant}
      >
        <GameIcon slug={presentation.icon} size={iconSize} />
        <span>{presentation.label}</span>
      </span>
    </Chip>
  );
}
