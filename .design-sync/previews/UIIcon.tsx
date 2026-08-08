import { UIIcon } from '@campfire/web';

export const Vocabulary = () => (
  <div style={{ display: 'flex', gap: 22, alignItems: 'center', padding: 16 }}>
    {(['upload', 'add', 'check', 'more', 'close'] as const).map((n) => (
      <div key={n} style={{ display: 'grid', gap: 6, justifyItems: 'center' }}>
        <UIIcon name={n} size="md" title={n} />
        <span style={{ fontSize: 11, opacity: 0.7 }}>{n}</span>
      </div>
    ))}
  </div>
);

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 18, alignItems: 'center', padding: 16 }}>
    {(['xs', 'sm', 'md', 'lg'] as const).map((s) => (
      <div key={s} style={{ display: 'grid', gap: 6, justifyItems: 'center' }}>
        <UIIcon name="check" size={s} title={`check ${s}`} />
        <span style={{ fontSize: 11, opacity: 0.7 }}>{s}</span>
      </div>
    ))}
  </div>
);
