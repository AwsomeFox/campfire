# Issue #731: Campaign export: disclose or remove the silent 500-entry audit-history cap

URL: https://github.com/AwsomeFox/campfire/issues/731

## Persona audit finding
**Severity:** Low  
**Lens:** support/export polish

Campaign export includes exactly 500 audit events without total, truncation, cutoff, or continuation metadata, making a partial history look complete.

### Evidence
- Fixed limit: `export.service.ts:93`
- Export without truncation metadata: `export.service.ts:161`
- Audit endpoint itself supports paging: `audit.controller.ts:10`

### Acceptance criteria
- Export all retained events from a stable snapshot, or explicitly exclude audit from portability exports.
- Include total/exported/truncated/cutoff metadata.
- Clearly distinguish campaign export from server backup.
- Test >500 events while concurrent inserts occur.
