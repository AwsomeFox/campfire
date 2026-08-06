import { Injectable } from '@nestjs/common';
import {
  CharacterCreate,
  CombatantStatblock,
  Dnd5eAdapter,
  characterCreateFromTemplate,
  findStarterTemplate,
  type Role,
  type SampleEncounterSeedResult,
} from '@campfire/schema';
import type { RequestUser } from '../../common/user.types';
import { CharactersService } from '../characters/characters.service';
import { EncountersService } from '../encounters/encounters.service';
import { MapsService } from '../maps/maps.service';

/** Fixed seed for the generated map (issue #1932) — a reproducible first impression. */
const SAMPLE_MAP_SEED = 'campfire-sample-fight-v1';

const SAMPLE_FIGHT_BASE_NAME = 'Sample Fight';

/**
 * Pregen party for the demo (issue #1932). Reuses the campaign's normal 5e quick-build
 * presets (`character-creation.ts`) rather than a second hand-authored roster, so the
 * pregens carry the SAME upgraded specs/spellSlots the sheet's "New Character" quick-build
 * flow now offers — one definition, not two that can drift apart.
 */
const SAMPLE_PARTY: ReadonlyArray<{ templateId: string; displayName: string }> = [
  { templateId: '5e-fighter', displayName: 'Sample: Torvald (Fighter)' },
  { templateId: '5e-wizard', displayName: 'Sample: Elowen (Wizard)' },
  { templateId: '5e-rogue', displayName: 'Sample: Shade (Rogue)' },
  { templateId: '5e-barbarian', displayName: 'Sample: Grask (Barbarian)' },
];

const SAMPLE_MONSTER_NAME = 'Bandit';
const SAMPLE_MONSTER_COUNT = 4;
const SAMPLE_MONSTER_HP_MAX = 11;

/** A basic 5e Bandit — resolvable Scimitar attack, no rule-pack install required. */
const SAMPLE_MONSTER_STATBLOCK: CombatantStatblock = CombatantStatblock.parse({
  ac: 12,
  abilityScores: { STR: 11, DEX: 12, CON: 12, INT: 10, WIS: 10, CHA: 10 },
  actions: [
    {
      name: 'Scimitar',
      kind: 'melee',
      toHit: '+3',
      damage: '1d6+1 slashing',
      targetAc: 'AC',
      notes: 'Melee Weapon Attack.',
      spec: {
        mode: 'attack',
        attack: { bonus: '+3' },
        cost: { slot: 'action', count: 1 },
        targets: { count: 1, allow: 'enemy' },
        outcomes: { hit: { damage: [{ formula: '1d6', flat: 1, type: 'slashing' }] } },
      },
    },
  ],
  traits: [],
  notes: 'Sample monster — bundled with the "Try a sample fight" demo (issue #1932).',
});

/**
 * Seeds a one-click demo encounter (issue #1932): 4 pregen characters, one `preparing`
 * encounter with 4 bandits, and a generated battle map — composed entirely from existing,
 * already-authorized write paths (CharactersService.create, EncountersService.create/
 * addCombatant, MapsService.generateForEncounter). This service adds NO new authorization,
 * secrecy, or persistence surface of its own: membership/role/archived-campaign enforcement
 * and audit logging all come from the services it calls, so REST and MCP share one code path
 * and cannot drift.
 */
@Injectable()
export class SampleEncounterService {
  constructor(
    private readonly characters: CharactersService,
    private readonly encounters: EncountersService,
    private readonly maps: MapsService,
  ) {}

  /** DM-only — the caller (REST controller / MCP tool) resolves and passes `role`. */
  async seed(campaignId: number, user: RequestUser, role: Role): Promise<SampleEncounterSeedResult> {
    const encounterName = await this.nextSampleFightName(campaignId);

    // 1. Four pregen characters — active, unowned (players claim them later).
    const characterIds: number[] = [];
    for (const preset of SAMPLE_PARTY) {
      const template = findStarterTemplate(Dnd5eAdapter, preset.templateId);
      if (!template) continue; // Defensive only — every id above is a literal from character-creation.ts.
      const draft = characterCreateFromTemplate(template, { name: preset.displayName, level: 1, status: 'active' });
      // Validate through the same schema the REST/MCP boundary enforces (issue #1932 review:
      // characterCreateFromTemplate's return type is looser than CharacterCreate — e.g.
      // saveProficiencies: string[] vs the AbilityKey union — since its usual callers hand the
      // payload to a DTO boundary that already re-validates it. Calling the service directly
      // needs that same narrowing here.
      const payload = CharacterCreate.parse(draft);
      const character = await this.characters.create(campaignId, payload, user, role);
      characterIds.push(character.id);
    }

    // 2. The encounter itself. EncountersService.create auto-adds every ACTIVE campaign
    // character as a combatant in one transaction — including the 4 pregens just created —
    // so this single call seeds both the encounter and its party roster.
    const encounter = await this.encounters.create(campaignId, { name: encounterName }, user, role);

    // 3. Four bandits, one addCombatant call per monster so every created row's id is known
    // (a single count:4 call only returns the first inserted row).
    const monsterCombatantIds: number[] = [];
    for (let i = 1; i <= SAMPLE_MONSTER_COUNT; i += 1) {
      const combatant = await this.encounters.addCombatant(
        encounter.id,
        {
          kind: 'monster',
          name: `${SAMPLE_MONSTER_NAME} ${i}`,
          hpMax: SAMPLE_MONSTER_HP_MAX,
          statblock: SAMPLE_MONSTER_STATBLOCK,
        },
        user,
        role,
      );
      monsterCombatantIds.push(combatant.id);
    }

    // 4. A generated, grid-aligned map, fixed seed for a reproducible first impression.
    const map = await this.maps.generateForEncounter(
      encounter.id,
      campaignId,
      { kind: 'dungeon', size: 'medium', seed: SAMPLE_MAP_SEED },
      user,
      role,
    );

    return {
      encounterId: encounter.id,
      encounterName,
      characterIds,
      monsterCombatantIds,
      mapAttachmentId: map.attachmentId,
    };
  }

  /**
   * Repeat clicks are safe (issue #1932): never overwrite a prior sample fight, always mint
   * "Sample Fight", "Sample Fight 2", "Sample Fight 3"... by scanning existing encounter names
   * for that exact family, not a substring match (a real encounter titled e.g. "My Sample
   * Fight Idea" would fold-match a plain contains-check but should never influence numbering).
   */
  private async nextSampleFightName(campaignId: number): Promise<string> {
    // DM-facing (undefined viewerRole/status) — mirrors other internal-only listForCampaign
    // reads (e.g. ExportService); the caller's own role was already checked before this,
    // and this text is not shown to anyone, only used to pick a non-colliding name.
    const existing = await this.encounters.listForCampaign(campaignId, undefined, undefined, SAMPLE_FIGHT_BASE_NAME);
    let highest = 0;
    let baseNameTaken = false;
    for (const enc of existing) {
      const name = enc.name.trim();
      if (name === SAMPLE_FIGHT_BASE_NAME) {
        baseNameTaken = true;
        continue;
      }
      const match = /^Sample Fight (\d+)$/.exec(name);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    if (!baseNameTaken && highest === 0) return SAMPLE_FIGHT_BASE_NAME;
    return `${SAMPLE_FIGHT_BASE_NAME} ${Math.max(highest, 1) + 1}`;
  }
}
