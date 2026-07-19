import { SetMetadata } from '@nestjs/common';
import type { Role } from '@campfire/schema';

export const ROLES_KEY = 'roles';

/** Minimum role required (dm > player > viewer), e.g. @Roles('dm') */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
