import { RolledDice } from '@campfire/web';

export const AllKept = () => (
  <div style={{ padding: 16 }}><RolledDice rolls={[18, 3, 11, 7]} /></div>
);

// `kept` is the subset of kept VALUES (multiset-matched against `rolls`), not
// indices — passing indices strikes every die through.
export const WithKeptSubset = () => (
  <div style={{ padding: 16 }}><RolledDice rolls={[18, 3, 11, 7]} kept={[18, 11]} /></div>
);

/** Advantage: both d20s shown, the lower one struck. */
export const Advantage = () => (
  <div style={{ padding: 16 }}><RolledDice rolls={[19, 4]} kept={[19]} fontSize={16} /></div>
);

export const LargerType = () => (
  <div style={{ padding: 16 }}><RolledDice rolls={[20, 1]} fontSize={22} /></div>
);
