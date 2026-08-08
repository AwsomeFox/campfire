import { EncounterBacklinksCard } from '@campfire/web';

export const MixedStatuses = () => (
  <div style={{ padding: 16, maxWidth: 420 }}>
    <EncounterBacklinksCard campaignId={1} encounters={[
      { id: 11, name: 'Ambush at the Tidewright’s Dock', status: 'running' },
      { id: 12, name: 'The Drowned Vault', status: 'preparing' },
      { id: 13, name: 'Skirmish on Ashgrove Road', status: 'ended' },
    ]} />
  </div>
);

export const Single = () => (
  <div style={{ padding: 16, maxWidth: 420 }}>
    <EncounterBacklinksCard campaignId={1} encounters={[
      { id: 11, name: 'The Drowned Vault', status: 'preparing' },
    ]} />
  </div>
);
