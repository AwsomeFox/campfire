/**
 * "Try a sample fight" one-click demo seed (issue #1932).
 *
 * Not a new domain concept — the seed composes three existing write paths
 * (CharactersService.create, EncountersService.create/addCombatant,
 * MapsService.generateForEncounter) and this module only names the RESULT shape those calls
 * hand back, so REST and MCP report the same ids. Nothing seeded carries a special flag: every
 * created row is an ordinary character/encounter/combatant/attachment, renamable and deletable
 * through the normal flows.
 */
import { z } from 'zod';

export const SampleEncounterSeedResult = z.object({
  encounterId: z.number().int(),
  encounterName: z.string(),
  characterIds: z.array(z.number().int()),
  monsterCombatantIds: z.array(z.number().int()),
  mapAttachmentId: z.number().int(),
});
export type SampleEncounterSeedResult = z.infer<typeof SampleEncounterSeedResult>;
