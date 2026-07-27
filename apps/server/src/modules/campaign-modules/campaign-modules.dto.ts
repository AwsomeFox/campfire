import { createZodDto } from 'nestjs-zod';
import {
  ModuleBulkPreviewRequest,
  ModuleForkRequest,
  ModuleInstallRequest,
  ModuleUpdateRequest,
} from '@campfire/schema';

// .strict() at the DTO layer only — see encounters.dto.ts header comment.
//
// NOT .strict() on the package-carrying bodies: an artifact's `data` is deliberately a
// loose record (the service projects it through a closed per-kind whitelist before it is
// hashed or written), and a publisher's manifest may carry forward-compatible keys we do
// not model yet. Rejecting those outright would make a v1 server unable to even *report*
// that a v2 package is too new for it — the formatVersion check in the service does that
// job with a useful message instead.
export class ModuleInstallDto extends createZodDto(ModuleInstallRequest) {}
export class ModuleUpdateDto extends createZodDto(ModuleUpdateRequest) {}
export class ModuleForkDto extends createZodDto(ModuleForkRequest.strict()) {}
export class ModuleBulkPreviewDto extends createZodDto(ModuleBulkPreviewRequest) {}
