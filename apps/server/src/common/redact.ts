import type { Role } from '@campfire/schema';

/** Strips dmSecret from an entity unless role is 'dm'. */
export function redactSecret<T extends { dmSecret?: string }>(entity: T, role: Role): T {
  if (role === 'dm') return entity;
  const { dmSecret: _dmSecret, ...rest } = entity;
  return { ...rest, dmSecret: '' } as T;
}

export function redactSecrets<T extends { dmSecret?: string }>(entities: T[], role: Role): T[] {
  return entities.map((e) => redactSecret(e, role));
}

/**
 * Entity-level secrecy (issue #42): whether an entity carrying a `hidden` flag is
 * visible to the given role. dmSecret only strips ONE field; `hidden` gates the
 * WHOLE entity, so a non-DM must not see it in any list/get/summary/export.
 */
export function isVisibleTo<T extends { hidden?: boolean }>(entity: T, role: Role): boolean {
  return role === 'dm' || !entity.hidden;
}

/** Drops entities the role may not see (hidden=true for non-DM). */
export function filterHidden<T extends { hidden?: boolean }>(entities: T[], role: Role): T[] {
  return entities.filter((e) => isVisibleTo(e, role));
}
