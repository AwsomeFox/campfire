import { SetMetadata } from '@nestjs/common';
import type { ServerRole } from '@campfire/schema';

export const SERVER_ROLES_KEY = 'serverRoles';

/** Gates a route to a minimum server role (currently only 'admin' is used). e.g. @ServerRoles('admin') */
export const ServerRoles = (...roles: ServerRole[]) => SetMetadata(SERVER_ROLES_KEY, roles);
