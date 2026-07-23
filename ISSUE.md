# Issue #727: Permanent deletion: do not claim erasure when filesystem cleanup failed

URL: https://github.com/AwsomeFox/campfire/issues/727

## Persona audit finding
**Severity:** Low  
**Lens:** privacy/storage polish

Attachment metadata commits before an unawaited directory removal, and campaign purge ignores removal errors, while the UI promises permanent deletion.

### Evidence
- Attachment removal: `attachments.service.ts:392`
- Campaign removal: `campaigns.service.ts:1534`
- UI promise: `HomePage.tsx:333`

### Acceptance criteria
- Await and verify filesystem deletion before claiming erasure, or explicitly return `filesPending`.
- Maintain a durable retryable cleanup job with visible failure state.
- Deep-link failures to Storage.
- Audit requested, metadata-complete, filesystem-complete, and failed stages.
- Test EACCES, EBUSY, mount loss, restart, and retry.
