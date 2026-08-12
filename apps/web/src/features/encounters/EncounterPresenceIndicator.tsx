/**
 * Compact Co-DM presence indicator for the encounter runner (issue #2212, #816 slice 2).
 *
 * Renders the OTHER human collaborators currently on the same running encounter — a chip
 * per person showing their name and coarse activity (`viewing` / `editing`) — resolved
 * from the `encounter.presence` SSE roster maintained by {@link useEncounterPresence}.
 *
 * The current user is never listed (AC #2212.5): the roster this receives may include the
 * caller (they legitimately declared), so they are filtered out here.
 *
 * Presentational only. Secrecy is server-enforced — a non-DM on a hidden encounter never
 * receives the frames in the first place (AC #2212.7) — and name resolution comes from the
 * membership roster every member already reads (`names`), so no new secret crosses the
 * wire. Returns `null` when nobody else is present, so a solo DM sees nothing.
 */
import { useTranslation } from 'react-i18next';
import type { EncounterPresenceEntry } from '@campfire/schema';

export interface EncounterPresenceIndicatorProps {
  /** Live roster (may include the caller). */
  members: readonly EncounterPresenceEntry[];
  /** The current user's id (`me.user.id`), stringified for comparison — never rendered. */
  selfUserId: string | number | null | undefined;
  /** `String(member.userId)` → display name, from the membership roster. */
  names: ReadonlyMap<string, string>;
}

export function EncounterPresenceIndicator({
  members,
  selfUserId,
  names,
}: EncounterPresenceIndicatorProps): JSX.Element | null {
  const { t } = useTranslation();
  const self = selfUserId == null ? '' : String(selfUserId);
  const others = members.filter((member) => member.userId !== self);
  if (others.length === 0) return null;

  return (
    <span
      className="cf-presence-roster"
      data-testid="encounter-presence-roster"
      title={t('encounters.presence.groupTitle')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}
    >
      {others.map((member) => {
        const name = names.get(member.userId) ?? member.userId;
        const activity = t(`encounters.presence.${member.activity}`);
        return (
          <span
            key={member.userId}
            className={`tag ${member.activity === 'editing' ? 'tag-accent' : 'tag-neutral'}`}
            data-testid={`encounter-presence-chip-${member.userId}`}
            style={{
              fontSize: 10.5,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span
              aria-hidden={true}
              data-testid={`encounter-presence-dot-${member.userId}`}
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'currentColor',
                flexShrink: 0,
              }}
            />
            {t('encounters.presence.personLabel', { name, activity })}
          </span>
        );
      })}
    </span>
  );
}
