/**
 * Mode-aware chrome (issue #343) — a small badge that surfaces whether an AI participates
 * in this campaign BEFORE it ever speaks, so players aren't surprised by an AI at the table.
 *
 *   - off (or seat unreadable): renders nothing.
 *   - driver: a link to the Table, where the AI-run session is played.
 *   - co_dm: a disclosure that expands the "what the AI can do here" transparency note —
 *     players see what data it sees and that canon changes still need the DM.
 *
 * Reads the seat mode (GET /campaigns/:id/ai-dm) — non-secret, so it's safe for players
 * (unlike the DM `instructions`, which the server redacts per #261). The seat read stops
 * on a 4xx (feature off / not a member), so the badge simply stays hidden then.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAiDmSeat } from '../../lib/query';
import { AiTransparencyNote } from './AiSetupChecklist';

export function AiModeBadge({ campaignId }: { campaignId: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { data: seat } = useAiDmSeat(campaignId);
  const mode = seat?.mode;

  if (mode !== 'co_dm' && mode !== 'driver') return null;

  if (mode === 'driver') {
    return (
      <Link
        to={`/c/${campaignId}/table`}
        className="tag tag-accent"
        style={{ whiteSpace: 'nowrap', cursor: 'pointer', textDecoration: 'none' }}
        aria-label={t('aiOnboarding.badge.driverAria')}
      >
        ✨ {t('aiOnboarding.badge.driver')}
      </Link>
    );
  }

  // co_dm — a disclosure into the transparency explainer for players.
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className="tag tag-accent-2"
        style={{ whiteSpace: 'nowrap', cursor: 'pointer', border: 'none' }}
        aria-expanded={open}
        aria-label={t('aiOnboarding.badge.coDmAria')}
        onClick={() => setOpen((v) => !v)}
      >
        ✨ {t('aiOnboarding.badge.coDm')}
      </button>
      {open && (
        <div
          className="card elev-md"
          style={{ position: 'absolute', top: '110%', left: 0, zIndex: 40, width: 300, padding: 4 }}
          role="dialog"
        >
          <AiTransparencyNote />
        </div>
      )}
    </span>
  );
}
