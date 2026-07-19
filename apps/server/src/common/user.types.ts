import type { Role } from '@campfire/schema';

export interface RequestUser {
  id: string;
  name: string;
  role: Role;
}

/** dm > player > viewer */
export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  player: 1,
  dm: 2,
};

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}
