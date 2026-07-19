import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marks a route as exempt from DevAuthGuard/RolesGuard (e.g. healthz). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
