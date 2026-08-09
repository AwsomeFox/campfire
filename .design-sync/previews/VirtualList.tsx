import { VirtualList } from '@campfire/web';

const npcs = ['Sera Valen', 'Brother Aldric', 'The Tidewright', 'Maren Kholt', 'Ossuary Keeper',
  'Captain Duvale', 'Wisp of the Fen', 'Lady Ashgrove', 'Torvin Blacksand', 'The Pale Cartographer'];

export const Roster = () => (
  <div style={{ padding: 16 }}>
    <VirtualList items={npcs} estimateHeight={34} maxHeight={220}>
      {(name, i) => (
        <div key={i} style={{ padding: '8px 10px', borderBottom: '1px solid var(--color-divider)' }}>
          {name}
        </div>
      )}
    </VirtualList>
  </div>
);
