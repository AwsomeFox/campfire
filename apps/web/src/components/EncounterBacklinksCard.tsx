import { Link } from 'react-router-dom';
import type { EncounterBacklink } from '@campfire/schema';
import { Card } from './ui';
import { GameIcon } from './GameIcon';
import { entityHref } from '../lib/entityLinks';
import { UI_ICON_SIZE } from '../lib/uiIcons';

const STATUS_LABEL: Record<EncounterBacklink['status'], string> = {
  preparing: 'Preparing',
  running: 'Running',
  ended: 'Ended',
};

/** Linked encounters on a location/quest/session detail page (issue #480). */
export function EncounterBacklinksCard({
  campaignId,
  encounters,
}: {
  campaignId: number;
  encounters: EncounterBacklink[];
}) {
  if (encounters.length === 0) return null;

  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm">Linked encounters</h2>
      <div className="grid sm:grid-cols-2 gap-3">
        {encounters.map((enc) => (
          <Link
            key={enc.id}
            to={entityHref(campaignId, { type: 'encounter', id: enc.id })}
            className="cf-inset cf-card-hover p-3"
          >
            <p className="flex items-center gap-1.5 text-sm font-bold text-rose-400">
              <GameIcon slug="crossed-swords" size={UI_ICON_SIZE.xs} />
              {enc.name}
            </p>
            <p className="text-xs text-slate-400">{STATUS_LABEL[enc.status]}</p>
          </Link>
        ))}
      </div>
    </Card>
  );
}
