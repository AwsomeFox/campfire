import { FloatingNumbers } from '@campfire/web';

// HpFeedbackEvent is { combatantId, kind, amount?, crit?, bandDirection? } —
// there is no `delta` field; passing one renders "undefined".
export const DamageAndHealing = () => (
  <div style={{ padding: 16, position: 'relative', height: 120 }}>
    <FloatingNumbers events={[
      { id: 1, combatantId: 1, kind: 'damage', amount: 12 },
      { id: 2, combatantId: 2, kind: 'heal', amount: 7 },
    ] as never} />
  </div>
);

export const CriticalAndDown = () => (
  <div style={{ padding: 16, position: 'relative', height: 120 }}>
    <FloatingNumbers events={[
      { id: 3, combatantId: 1, kind: 'damage', amount: 24, crit: true },
      { id: 4, combatantId: 2, kind: 'down' },
    ] as never} />
  </div>
);
