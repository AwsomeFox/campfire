import { createZodDto } from 'nestjs-zod';
import { ProposalApprove, ProposalBatchResolve, ProposalResolve } from '@campfire/schema';

// .strict() — an unrecognized body key 400s instead of being silently stripped
// (see encounters.dto.ts / issue #131). Only the top-level resolve/approve body
// is strict; ProposalApprove.payload stays an open `z.record` (it carries an
// amended Create/Update body validated separately in ProposalsService).
export class ProposalResolveDto extends createZodDto(ProposalResolve.strict()) {}
export class ProposalApproveDto extends createZodDto(ProposalApprove.strict()) {}
export class ProposalBatchResolveDto extends createZodDto(ProposalBatchResolve.strict()) {}
