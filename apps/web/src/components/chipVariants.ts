export type ChipVariant =
  | 'active' | 'available' | 'neutral' | 'completed' | 'failed'
  | 'private' | 'dm' | 'party' | 'proposal' | 'whisper' | 'ai';

export const chipClass: Record<ChipVariant, string> = {
  active: 'cf-chip-active',
  available: 'cf-chip-available',
  neutral: 'cf-chip-neutral',
  completed: 'cf-chip-completed',
  failed: 'cf-chip-failed',
  private: 'cf-chip-private',
  dm: 'cf-chip-dm',
  party: 'cf-chip-party',
  proposal: 'cf-chip-proposal',
  whisper: 'cf-chip-whisper',
  // AI-drafted proposal attribution (issue #341): distinct teal so an AI-authored
  // proposal reads as its own thing next to the proposer/delete/status chips.
  ai: 'cf-chip-ai',
};
