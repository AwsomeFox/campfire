import { HpBar } from '@campfire/web';

export const Levels = () => (
  <div style={{ display: 'grid', gap: 14, padding: 16, maxWidth: 320 }}>
    <div><div style={{ marginBottom: 4 }}>Healthy — 42/45</div><HpBar current={42} max={45} /></div>
    <div><div style={{ marginBottom: 4 }}>Bloodied — 20/45</div><HpBar current={20} max={45} /></div>
    <div><div style={{ marginBottom: 4 }}>Critical — 4/45</div><HpBar current={4} max={45} /></div>
    <div><div style={{ marginBottom: 4 }}>Downed — 0/45</div><HpBar current={0} max={45} /></div>
  </div>
);

export const ColorVisionAssist = () => (
  <div style={{ display: 'grid', gap: 14, padding: 16, maxWidth: 320 }}>
    <div><div style={{ marginBottom: 4 }}>Bloodied</div><HpBar current={20} max={45} colorVisionAssist /></div>
    <div><div style={{ marginBottom: 4 }}>Critical</div><HpBar current={4} max={45} colorVisionAssist /></div>
  </div>
);
