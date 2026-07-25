import type { EntityType } from '@campfire/schema';
import { Card } from '../../components/ui';
import { CommentsThread } from './CommentsThread';

/** Shared discussion card for any comment-anchored campaign entity (issue #439). */
export function EntityDiscussion({
  campaignId,
  entityType,
  entityId,
}: {
  campaignId: number;
  entityType: EntityType;
  entityId: number;
}) {
  return (
    <Card>
      <CommentsThread campaignId={campaignId} entityType={entityType} entityId={entityId} />
    </Card>
  );
}
