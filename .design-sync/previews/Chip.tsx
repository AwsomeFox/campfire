import { Chip } from '@campfire/web';

export const StatusVariants = () => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: 16 }}>
    <Chip variant="active">Active</Chip>
    <Chip variant="available">Available</Chip>
    <Chip variant="completed">Completed</Chip>
    <Chip variant="failed">Failed</Chip>
    <Chip variant="neutral">Neutral</Chip>
  </div>
);

export const AudienceVariants = () => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: 16 }}>
    <Chip variant="dm">DM only</Chip>
    <Chip variant="party">Party</Chip>
    <Chip variant="private">Private</Chip>
    <Chip variant="whisper">Whisper</Chip>
    <Chip variant="proposal">Proposal</Chip>
    <Chip variant="ai">AI</Chip>
  </div>
);
