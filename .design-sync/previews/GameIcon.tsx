import { GameIcon } from '@campfire/web';

export const EntityIcons = () => (
  <div style={{ display: 'flex', gap: 22, alignItems: 'center', padding: 16, flexWrap: 'wrap' }}>
    {['crossed-swords', 'castle', 'scroll-unfurled', 'hooded-figure', 'treasure-map'].map((slug) => (
      <div key={slug} style={{ display: 'grid', gap: 6, justifyItems: 'center', width: 96 }}>
        <GameIcon slug={slug} size={40} title={slug} />
        <span style={{ fontSize: 10, opacity: 0.7, textAlign: 'center' }}>{slug}</span>
      </div>
    ))}
  </div>
);

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 18, alignItems: 'center', padding: 16 }}>
    {[16, 24, 40, 64].map((n) => <GameIcon key={n} slug="crossed-swords" size={n} title={`${n}px`} />)}
  </div>
);
