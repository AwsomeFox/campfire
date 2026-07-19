import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { TokenContext } from '../user.types';

/** Non-null only when the request authenticated via a PAT (Authorization: Bearer cf_pat_...). */
export const CurrentTokenContext = createParamDecorator((_data: unknown, ctx: ExecutionContext): TokenContext | undefined => {
  const req = ctx.switchToHttp().getRequest<Request & { tokenContext?: TokenContext }>();
  return req.tokenContext;
});
