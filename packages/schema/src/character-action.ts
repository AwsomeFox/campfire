import { z } from 'zod';
import { ActionSpec } from './action-resolver';

/**
 * One row in the Actions card — attack, spell, or feature (issue #414).
 * Shared by character sheets and combatant statblocks (issue #425).
 */
export const CharacterAction = z.object({
  name: z.string().min(1).max(120),
  kind: z.string().max(40).default(''),
  toHit: z.string().max(20).default(''),
  damage: z.string().max(80).default(''),
  targetAc: z.string().max(20).default(''),
  notes: z.string().max(500).default(''),
  spec: ActionSpec.optional(),
});
export type CharacterAction = z.infer<typeof CharacterAction>;
