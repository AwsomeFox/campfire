import { SaveFeedback } from '@campfire/web';

const savedAt = new Date(2026, 0, 14, 9, 41);

export const States = () => (
  <div style={{ display: 'grid', gap: 12, padding: 16 }}>
    <SaveFeedback subject="Quest" state="dirty" error="" savedAt={savedAt} />
    <SaveFeedback subject="Quest" state="saving" error="" savedAt={savedAt} />
    <SaveFeedback subject="Quest" state="saved" error="" savedAt={savedAt} />
    <SaveFeedback subject="Quest" state="error" error="The server rejected this change." savedAt={savedAt} />
  </div>
);
