import { createZodDto } from 'nestjs-zod';
import { ProposalResolve } from '@campfire/schema';

export class ProposalResolveDto extends createZodDto(ProposalResolve) {}
