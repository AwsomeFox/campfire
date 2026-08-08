import { Btn } from '@campfire/web';

export const Variants = () => (
  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', padding: 16 }}>
    <Btn>Roll initiative</Btn>
    <Btn ghost>Cancel</Btn>
    <Btn danger>Delete encounter</Btn>
  </div>
);

export const Density = () => (
  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', padding: 16 }}>
    <Btn density="xs">Extra small</Btn>
    <Btn density="compact">Compact</Btn>
    <Btn density="default">Default</Btn>
    <Btn density="comfortable">Comfortable</Btn>
  </div>
);

export const States = () => (
  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', padding: 16 }}>
    <Btn>Enabled</Btn>
    <Btn busy>Saving…</Btn>
    <Btn disabled>Disabled</Btn>
    <Btn danger busy>Deleting…</Btn>
  </div>
);
