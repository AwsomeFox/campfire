/**
 * Physical / paper-table roll logging (issue #673).
 *
 * Pure validation + payload shaping for the "Log physical roll" form — no DOM, so
 * every acceptance scenario can be pinned in a unit spec without a browser.
 */
import type { ManualRollRequest } from '@campfire/schema';

export interface PhysicalRollFormFields {
  total: string;
  label: string;
  actor: string;
  natural20: string;
  dc: string;
}

export const EMPTY_PHYSICAL_ROLL_FORM: PhysicalRollFormFields = {
  total: '',
  label: '',
  actor: '',
  natural20: '',
  dc: '',
};

export type PhysicalRollParseResult =
  | { ok: true; payload: ManualRollRequest }
  | { ok: false; error: 'totalRequired' | 'totalInvalid' | 'natural20Invalid' | 'dcInvalid' };

function parseOptionalInt(raw: string, min: number, max: number): number | undefined | 'invalid' {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < min || n > max) return 'invalid';
  return n;
}

/** Parse form fields into a ManualRollRequest or a field-specific error key. */
export function parsePhysicalRollForm(fields: PhysicalRollFormFields): PhysicalRollParseResult {
  const totalRaw = fields.total.trim();
  if (!totalRaw) return { ok: false, error: 'totalRequired' };
  const total = Number(totalRaw);
  if (!Number.isInteger(total) || total < -999 || total > 9999) return { ok: false, error: 'totalInvalid' };

  const natural20 = parseOptionalInt(fields.natural20, 1, 20);
  if (natural20 === 'invalid') return { ok: false, error: 'natural20Invalid' };
  const dc = parseOptionalInt(fields.dc, 1, 99);
  if (dc === 'invalid') return { ok: false, error: 'dcInvalid' };

  const label = fields.label.trim();
  const actor = fields.actor.trim();
  const payload: ManualRollRequest = { total };
  if (label) payload.label = label;
  if (actor) payload.actor = actor;
  if (natural20 !== undefined) payload.natural20 = natural20;
  if (dc !== undefined) payload.dc = dc;
  return { ok: true, payload };
}

/** Display name for who performed the roll at the table. */
export function physicalRollActorName(roll: { actor?: string; rollerName?: string; rollerUserId: string }): string {
  return roll.actor?.trim() || roll.rollerName?.trim() || roll.rollerUserId;
}

/** True when the entry was logged manually rather than rolled by Campfire. */
export function isManualDiceRoll(roll: { source?: string; expr?: string }): boolean {
  return roll.source === 'manual';
}
