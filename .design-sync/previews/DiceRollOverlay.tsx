import { DiceRollOverlay } from '@campfire/web';

const dice = [
  { id: 1, sides: 20, value: 19 },
  { id: 2, sides: 6, value: 4 },
  { id: 3, sides: 6, value: 5 },
] as never;

export const Tumbling = () => (
  <div style={{ padding: 16, position: 'relative', height: 200 }}>
    <DiceRollOverlay dice={dice} phase="tumbling" onSettled={() => {}} />
  </div>
);

export const Settling = () => (
  <div style={{ padding: 16, position: 'relative', height: 200 }}>
    <DiceRollOverlay dice={dice} phase="settling" theme="nocturne" onSettled={() => {}} />
  </div>
);
