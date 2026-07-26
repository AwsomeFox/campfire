import type { DiceRoll } from '@campfire/schema';
import type { TFunction } from 'i18next';
import { d20Flavor, d20FlourishI18nKey } from '../../lib/d20Flavor';
import { isManualDiceRoll } from './physicalRollForm';

/** Visual dice feed: named log landmark; polite speech uses the app announcer. */
export const DICE_LOG_LIVE_REGION = {
  role: 'log',
  'aria-live': 'off',
} as const;

export interface DiceRollAnnouncementCursor {
  seenRollIds: Set<number>;
}

export interface DiceRollAnnouncementAdvance {
  cursor: DiceRollAnnouncementCursor;
  appendedRolls: DiceRoll[];
}

function formatRollBreakdownForSpeech(roll: DiceRoll): string {
  const explodingTerms = roll.terms?.filter((term) => term.rolls && (term.exploded || term.discarded));
  if (!explodingTerms || explodingTerms.length === 0) return roll.rolls.join(', ');
  return roll.terms!
    .filter((term) => term.rolls && term.rolls.length > 0)
    .map((term) => {
      const faces = term.rolls!.join(', ');
      const prefix = term.discarded ? 'discarded ' : '';
      const explosion = term.exploded ? ' exploded' : '';
      return `${prefix}${term.term}${explosion}: ${faces}`;
    })
    .join('; ');
}

/**
 * Advances an ID-based cursor without re-announcing refetched history. A null cursor
 * establishes the initial baseline (opening the feed never reads past rolls aloud).
 */
export function advanceDiceRollAnnouncements(
  rolls: readonly DiceRoll[],
  cursor: DiceRollAnnouncementCursor | null,
): DiceRollAnnouncementAdvance {
  const seenRollIds = cursor?.seenRollIds ?? new Set<number>();
  const appendedRolls: DiceRoll[] = [];

  for (const roll of rolls) {
    if (cursor !== null && !seenRollIds.has(roll.id)) appendedRolls.push(roll);
    seenRollIds.add(roll.id);
  }

  return { cursor: cursor ?? { seenRollIds }, appendedRolls };
}

/** Roller-attributed spoken form shared by the announcer and unit specs. */
export function formatDiceRollAnnouncement(roll: DiceRoll, t: TFunction): string {
  const roller = roll.rollerName?.trim() || roll.rollerUserId;
  if (isManualDiceRoll(roll)) {
    const who = roll.actor?.trim() || roller;
    const checkSaid =
      roll.dc != null
        ? roll.success
          ? t('dice.announceSuccess', { dc: roll.dc })
          : t('dice.announceFail', { dc: roll.dc })
        : '';
    const natSaid =
      roll.natural20 != null ? t('dice.announcePhysicalNatural', { natural: roll.natural20 }) : '';
    const body = t('dice.announcePhysicalRoll', {
      label: roll.label ? `${roll.label} ` : '',
      total: roll.total,
      natural: natSaid,
      check: checkSaid,
    });
    return t('dice.announceRemoteRoll', { roller: who, body });
  }
  const flavor = d20Flavor(roll);
  const flourishKey = d20FlourishI18nKey(flavor);
  const flourish = flourishKey ? t(flourishKey) : '';
  const keptSaid = roll.kept ? t('dice.announceKept', { kept: roll.kept.join(', ') }) : '';
  const checkSaid =
    roll.dc != null
      ? roll.success
        ? t('dice.announceSuccess', { dc: roll.dc })
        : t('dice.announceFail', { dc: roll.dc })
      : '';
  const body = t('dice.announceRoll', {
    label: roll.label ? `${roll.label} ` : '',
    expr: roll.expr,
    total: roll.total,
    rolls: formatRollBreakdownForSpeech(roll),
    kept: keptSaid,
    check: checkSaid,
    flourish,
  });
  return t('dice.announceRemoteRoll', { roller, body });
}

/** One atomic message when a poll/reconnect returns several new rolls at once. */
export function formatDiceRollAnnouncementBatch(rolls: readonly DiceRoll[], t: TFunction): string {
  if (rolls.length === 0) return '';
  if (rolls.length === 1) return formatDiceRollAnnouncement(rolls[0]!, t);
  const chronological = [...rolls].reverse();
  const messages = chronological.map((roll) => formatDiceRollAnnouncement(roll, t)).join(' ');
  return t('dice.announceRemoteRollBatch', { count: rolls.length, messages });
}
