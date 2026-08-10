/**
 * Records the authenticated member's recent views so the dashboard's
 * "Recently viewed" panel stays populated (issue #840). Mounted once in the
 * campaign Layout; watches the route and fires a single fire-and-forget POST per
 * distinct detail-page target. The server re-checks membership + visibility, so a
 * visit to an inaccessible entity is silently rejected; a failed POST never blocks
 * the UI (recent history is best-effort personal read-state).
 */
import { useEffect, useRef } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router-dom';
import type { BookmarkEntityType } from '@campfire/schema';
import { recordVisit } from '../lib/personalNavigation';

/** Route segment → supported bookmarkable entity type. */
const SEGMENT_TO_TYPE: Record<string, BookmarkEntityType> = {
  quests: 'quest',
  npcs: 'npc',
  factions: 'faction',
  locations: 'location',
  characters: 'character',
  encounters: 'encounter',
};

export function RecentVisitRecorder() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const lastKey = useRef<string>('');

  useEffect(() => {
    const cid = Number(campaignId);
    if (!Number.isInteger(cid) || cid <= 0) return;

    // Detail pages follow /c/:campaignId/<segment>/<id>; 'new' and non-numeric ids
    // are create forms, not views, and are skipped.
    const match = pathname.match(/^\/c\/\d+\/(quests|npcs|factions|locations|characters|encounters)\/(\d+)$/);
    // Sessions are viewed inside the sessions list page via ?session=<id> (there is
    // no /sessions/:id route), so they are matched off the query string instead.
    const sessionId = pathname.match(/^\/c\/\d+\/sessions$/) ? searchParams.get('session') : null;
    const sessionIdN = sessionId != null && /^\d+$/.test(sessionId) ? Number(sessionId) : null;

    let entityType: BookmarkEntityType | null = null;
    let entityId: number | null = null;
    if (match) {
      entityType = SEGMENT_TO_TYPE[match[1]];
      entityId = Number(match[2]);
    } else if (sessionIdN != null) {
      entityType = 'session';
      entityId = sessionIdN;
    }
    if (!entityType || !entityId) return;

    const key = `${cid}:${entityType}:${entityId}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    void recordVisit({ campaignId: cid, entityType, entityId }).catch(() => {
      /* best-effort: an inaccessible/failed visit is silently dropped */
    });
  }, [campaignId, pathname, searchParams]);

  return null;
}
