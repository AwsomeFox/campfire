import type { CanonicalNpcDisposition, QuestStatus } from '@campfire/schema';
import type { ChipVariant } from './chipVariants';

export interface SemanticPresentation {
  variant: ChipVariant;
  label: string;
  icon: string;
}

const UNKNOWN_QUEST_STATUS: SemanticPresentation = {
  variant: 'neutral',
  label: 'Unknown',
  icon: 'scroll-unfurled',
};

const UNKNOWN_NPC_DISPOSITION: SemanticPresentation = {
  variant: 'neutral',
  label: 'Neutral',
  icon: 'hooded-figure',
};

/** Exhaustive semantic treatment for every schema-defined quest status. */
export const QUEST_STATUS_SEMANTICS = {
  available: { variant: 'available', label: 'Available', icon: 'scroll-unfurled' },
  active: { variant: 'active', label: 'Active', icon: 'target-arrows' },
  completed: { variant: 'completed', label: 'Completed', icon: 'laurel-crown' },
  failed: { variant: 'failed', label: 'Failed', icon: 'cancel' },
} satisfies Record<QuestStatus, SemanticPresentation>;

/** Exhaustive semantic treatment for the canonical NPC dispositions. */
export const NPC_DISPOSITION_SEMANTICS = {
  friendly: { variant: 'completed', label: 'Friendly', icon: 'shaking-hands' },
  neutral: { variant: 'neutral', label: 'Neutral', icon: 'hooded-figure' },
  hostile: { variant: 'failed', label: 'Hostile', icon: 'crossed-swords' },
} satisfies Record<CanonicalNpcDisposition, SemanticPresentation>;

function hasOwn<T extends object>(record: T, value: PropertyKey): value is keyof T {
  return Object.prototype.hasOwnProperty.call(record, value);
}

export function questStatusPresentation(status: string): SemanticPresentation {
  const normalized = status.trim();
  if (hasOwn(QUEST_STATUS_SEMANTICS, normalized)) return QUEST_STATUS_SEMANTICS[normalized];
  return { ...UNKNOWN_QUEST_STATUS, label: normalized || UNKNOWN_QUEST_STATUS.label };
}

export function npcDispositionPresentation(disposition: string | null | undefined): SemanticPresentation {
  const normalized = disposition?.trim() ?? '';
  if (hasOwn(NPC_DISPOSITION_SEMANTICS, normalized)) {
    return NPC_DISPOSITION_SEMANTICS[normalized];
  }
  return {
    ...UNKNOWN_NPC_DISPOSITION,
    label: normalized || UNKNOWN_NPC_DISPOSITION.label,
  };
}

/** Exact quest status → chip treatment. Unknown runtime values are neutral. */
export function questStatusVariant(status: QuestStatus | string): ChipVariant {
  return questStatusPresentation(status).variant;
}

/** Exact NPC disposition → chip treatment. Custom values are always neutral. */
export function npcDispositionVariant(disposition: string | null | undefined): ChipVariant {
  return npcDispositionPresentation(disposition).variant;
}
