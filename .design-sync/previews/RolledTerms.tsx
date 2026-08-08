import { RolledTerms } from '@campfire/web';

export const AttackRoll = () => (
  <div style={{ padding: 16 }}>
    <RolledTerms terms={[
      { term: '1d20', value: 18, rolls: [18], sides: 20 },
      { term: '+5', value: 5 },
    ]} />
  </div>
);

export const AdvantageWithDamage = () => (
  <div style={{ padding: 16 }}>
    <RolledTerms terms={[
      { term: '2d20kh1', value: 19, rolls: [19, 4], kept: [0], sides: 20 },
      { term: '2d6', value: 9, rolls: [4, 5], sides: 6 },
      { term: '+3', value: 3 },
    ]} />
  </div>
);
