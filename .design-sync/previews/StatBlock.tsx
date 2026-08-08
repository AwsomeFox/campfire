import { StatBlock } from '@campfire/web';

// Shape mirrors the server's open5e importer output (mapCreature).
const owlbear = {
  type: 'Monstrosity', size: 'Large', challengeRating: '3',
  armorClass: 13, hitPoints: 59, speed: { walk: '40 ft.' },
  abilityScores: { strength: 20, dexterity: 12, constitution: 17, intelligence: 3, wisdom: 12, charisma: 7 },
  specialAbilities: [
    { name: 'Keen Sight and Smell', desc: 'The owlbear has advantage on Perception checks that rely on sight or smell.' },
  ],
  actions: [
    { name: 'Multiattack', desc: 'The owlbear makes two attacks: one with its beak and one with its claws.' },
    { name: 'Beak', desc: 'Melee Weapon Attack: +7 to hit, reach 5 ft. Hit: 10 (1d10 + 5) piercing damage.' },
    { name: 'Claws', desc: 'Melee Weapon Attack: +7 to hit, reach 5 ft. Hit: 14 (2d8 + 5) slashing damage.' },
  ],
};

export const Creature = () => (
  <div style={{ padding: 16, maxWidth: 520 }}><StatBlock data={owlbear} /></div>
);
