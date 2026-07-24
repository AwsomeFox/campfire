import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { KEY_ENVELOPE_MIN_PASSPHRASE_LEN } from './backup-key-envelope';
import { RESTORE_CONFIRM_TOKEN } from './backup.service';

function validateOptionalKeyPassphrase(v: string | undefined, ctx: z.RefinementCtx): void {
  if (v === undefined) return;
  if (v.trim().length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'keyPassphrase cannot be blank' });
    return;
  }
  if (v.trim().length < KEY_ENVELOPE_MIN_PASSPHRASE_LEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `keyPassphrase must be at least ${KEY_ENVELOPE_MIN_PASSPHRASE_LEN} characters`,
    });
  }
}

const optionalKeyPassphrase = z
  .string()
  .optional()
  .superRefine(validateOptionalKeyPassphrase)
  .transform((v) => (v === undefined ? undefined : v.trim()));

/** POST /backup/download body (#496). Validated so non-string values 400 instead of being stripped. */
export const BackupDownloadBody = z
  .object({
    keyPassphrase: optionalKeyPassphrase,
  })
  .strict();

export class BackupDownloadDto extends createZodDto(BackupDownloadBody) {}

/** Multipart restore fields (#496) — passphrase validated like download. */
export const BackupRestoreBody = z
  .object({
    confirm: z.literal(RESTORE_CONFIRM_TOKEN),
    keyPassphrase: optionalKeyPassphrase,
  })
  .strict();

export class BackupRestoreDto extends createZodDto(BackupRestoreBody) {}
