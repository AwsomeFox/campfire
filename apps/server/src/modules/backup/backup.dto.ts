import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { KEY_ENVELOPE_MIN_PASSPHRASE_LEN } from './backup-key-envelope';

/** POST /backup/download body (#496). Validated so non-string values 400 instead of being stripped. */
export const BackupDownloadBody = z
  .object({
    keyPassphrase: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().min(KEY_ENVELOPE_MIN_PASSPHRASE_LEN).optional(),
    ),
  })
  .strict();

export class BackupDownloadDto extends createZodDto(BackupDownloadBody) {}
