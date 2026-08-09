import { EntitySecrecyControls } from '@campfire/web';

// Only one story: the control renders identically for every entityKind (the
// cascade preview appears in the reveal dialog, not inline), so a second
// entity-kind cell would be a visually identical card.
const noop = async () => {};

export const HiddenNpc = () => (
  <div style={{ padding: 16, maxWidth: 460 }}>
    <EntitySecrecyControls
      entityKind="npc"
      entityName="The Pale Cartographer"
      hidden
      preview={[{ kind: 'npc', name: 'The Pale Cartographer', id: 7 }] as never}
      onReveal={noop}
      onUndoReveal={noop}
    />
  </div>
);
