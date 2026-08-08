import { Toggle } from '@campfire/web';

export const CheckedStates = () => (
  <div style={{ display: 'grid', gap: 12, padding: 16 }}>
    <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <Toggle checked onChange={() => {}} label="Slay the ancient wyrm" />
      <span>Slay the ancient wyrm</span>
    </label>
    <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <Toggle checked={false} onChange={() => {}} label="Recover the sunken crown" />
      <span>Recover the sunken crown</span>
    </label>
    <label style={{ display: 'flex', gap: 10, alignItems: 'center', opacity: 0.6 }}>
      <Toggle checked disabled onChange={() => {}} label="Locked objective" title="Completed objectives are locked" />
      <span>Locked objective</span>
    </label>
  </div>
);
