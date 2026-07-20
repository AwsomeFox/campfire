import { createZodDto } from 'nestjs-zod';
import { ProposalApprove, ProposalBatchResolve, ProposalResolve } from '@campfire/schema';

export class ProposalResolveDto extends createZodDto(ProposalResolve) {}
export class ProposalApproveDto extends createZodDto(ProposalApprove) {}
export class ProposalBatchResolveDto extends createZodDto(ProposalBatchResolve) {}
