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
