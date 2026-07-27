import { expect, test } from '@playwright/test';
import type { CampaignCatalogEntry } from '@campfire/schema';
import {
  EMPTY_BULK_ARGS,
  availableOperations,
  buildBulkPayload,
  bulkArgsError,
  bulkPayloadFingerprint,
  reconcileOperation,
  type BulkArgs,
} from '../../src/features/admin/adminCatalogState';

/**
 * Issue #587 — the bulk controls have to send what the server asks for.
 *
 * Four of the five argument-taking operations used to post only
 * `operation`/`campaignIds`/`dryRun`/`reason`, so `reassign_owner`, `set_quota`,
 * `set_policy` and `update_module` returned 400 even as a dry run. These tests pin the
 * payload shape against `CampaignCatalogBulkRequest` and `validateBulkArgs` so a
 * visibly-offered button cannot silently go back to being unusable.
 */

function entry(id: number, status: CampaignCatalogEntry['status']): CampaignCatalogEntry {
  return { id, status } as CampaignCatalogEntry;
}

const args = (over: Partial<BulkArgs> = {}): BulkArgs => ({ ...EMPTY_BULK_ARGS, ...over });

test.describe('bulk payload carries each operation\'s required argument', () => {
  test('reassign_owner sends a numeric toUserId', () => {
    const body = buildBulkPayload('reassign_owner', [1, 2], true, 'why', args({ toUserId: '42' }));
    expect(body.toUserId).toBe(42);
    expect(body).toMatchObject({ operation: 'reassign_owner', campaignIds: [1, 2], dryRun: true, reason: 'why' });
  });

  test('set_quota sends a number, and null to CLEAR rather than omitting the field', () => {
    expect(buildBulkPayload('set_quota', [1], true, '', args({ storageQuotaBytes: '1024' })).storageQuotaBytes).toBe(
      1024,
    );
    // The server distinguishes "clear the quota" (null) from "argument missing"
    // (400), so an empty box must serialise as an explicit null.
    const cleared = buildBulkPayload('set_quota', [1], true, '', args({ storageQuotaBytes: '' }));
    expect(cleared.storageQuotaBytes).toBeNull();
    expect('storageQuotaBytes' in cleared).toBe(true);
  });

  test('set_policy sends only the fields the operator actually changed', () => {
    const both = buildBulkPayload(
      'set_policy',
      [1],
      true,
      '',
      args({ closePublicInvites: true, aiExternalContentPolicy: 'disabled' }),
    );
    expect(both).toMatchObject({ publicInvitesEnabled: false, aiExternalContentPolicy: 'disabled' });

    const aiOnly = buildBulkPayload('set_policy', [1], true, '', args({ aiExternalContentPolicy: 'member_consent' }));
    expect('publicInvitesEnabled' in aiOnly).toBe(false);
    expect(aiOnly.aiExternalContentPolicy).toBe('member_consent');
  });

  test('set_policy can only ever CLOSE public invites', () => {
    // Enabling is gated on the campaign being active and untrashed; arming the flag
    // from the catalog would revive every retained link on the next `activate`. The
    // form has no way to express `true`, and the server rejects it if one appears.
    const body = buildBulkPayload('set_policy', [1], true, '', args({ closePublicInvites: true }));
    expect(body.publicInvitesEnabled).toBe(false);
  });

  test('update_module sends a trimmed ruleSystem', () => {
    expect(buildBulkPayload('update_module', [1], true, '', args({ ruleSystem: '  srd-5e ' })).ruleSystem).toBe(
      'srd-5e',
    );
  });

  test('request_export sends a profile the export module can actually build', () => {
    expect(buildBulkPayload('request_export', [1], true, 'a good reason', args()).exportProfile).toBe('backup');
    expect(
      buildBulkPayload('request_export', [1], true, 'a good reason', args({ exportProfile: 'publish' }))
        .exportProfile,
    ).toBe('publish');
  });

  test('operations with no arguments send nothing extra', () => {
    expect(Object.keys(buildBulkPayload('archive', [1], true, 'r', args())).sort()).toEqual(
      ['campaignIds', 'dryRun', 'operation', 'reason'].sort(),
    );
  });
});

test.describe('argument validation mirrors the server before the request is sent', () => {
  test('reassign_owner needs a positive numeric id', () => {
    expect(bulkArgsError('reassign_owner', args())).not.toBeNull();
    expect(bulkArgsError('reassign_owner', args({ toUserId: 'abc' }))).not.toBeNull();
    expect(bulkArgsError('reassign_owner', args({ toUserId: '0' }))).not.toBeNull();
    expect(bulkArgsError('reassign_owner', args({ toUserId: '7' }))).toBeNull();
  });

  test('set_quota accepts empty (clear) but not junk', () => {
    expect(bulkArgsError('set_quota', args({ storageQuotaBytes: '' }))).toBeNull();
    expect(bulkArgsError('set_quota', args({ storageQuotaBytes: '100' }))).toBeNull();
    expect(bulkArgsError('set_quota', args({ storageQuotaBytes: '-5' }))).not.toBeNull();
    expect(bulkArgsError('set_quota', args({ storageQuotaBytes: 'lots' }))).not.toBeNull();
  });

  test('set_policy needs at least one change, matching validateBulkArgs', () => {
    expect(bulkArgsError('set_policy', args())).not.toBeNull();
    expect(bulkArgsError('set_policy', args({ closePublicInvites: true }))).toBeNull();
    expect(bulkArgsError('set_policy', args({ aiExternalContentPolicy: 'disabled' }))).toBeNull();
  });

  test('update_module needs a slug', () => {
    expect(bulkArgsError('update_module', args())).not.toBeNull();
    expect(bulkArgsError('update_module', args({ ruleSystem: '   ' }))).not.toBeNull();
    expect(bulkArgsError('update_module', args({ ruleSystem: 'srd-5e' }))).toBeNull();
  });

  test('operations without arguments are never blocked', () => {
    for (const op of ['archive', 'pause', 'activate'] as const) {
      expect(bulkArgsError(op, args())).toBeNull();
    }
  });
});

test.describe('Apply cannot run a batch that was never previewed', () => {
  // The dry run is only a safety property if Apply runs the thing that was previewed.
  // Gating Apply on "a preview exists" is a weaker claim than "the preview describes
  // what Apply will do", and the gap is where an operator previews a reassignment to
  // Alice, edits the owner to Bob, and Apply proceeds against Bob.
  type Op = Parameters<typeof bulkPayloadFingerprint>[0];
  const key = (op: Op, ids: number[], reason: string, a: BulkArgs) => bulkPayloadFingerprint(op, ids, reason, a);

  test('the exact scenario: previewing Alice then editing to Bob retires the preview', () => {
    const previewed = key('reassign_owner', [1, 2], 'handover', args({ toUserId: '10' }));
    const nowSending = key('reassign_owner', [1, 2], 'handover', args({ toUserId: '20' }));
    expect(nowSending).not.toBe(previewed);
  });

  test('every operation-specific field changes the fingerprint', () => {
    const cases: Array<[Op, BulkArgs, BulkArgs]> = [
      ['reassign_owner', args({ toUserId: '1' }), args({ toUserId: '2' })],
      ['set_quota', args({ storageQuotaBytes: '10' }), args({ storageQuotaBytes: '20' })],
      ['set_quota', args({ storageQuotaBytes: '10' }), args({ storageQuotaBytes: '' })],
      [
        'set_policy',
        args({ aiExternalContentPolicy: 'disabled' }),
        args({ aiExternalContentPolicy: 'member_consent' }),
      ],
      ['set_policy', args({ closePublicInvites: true }), args({ closePublicInvites: false })],
      ['update_module', args({ ruleSystem: 'srd-5e' }), args({ ruleSystem: 'pf2e' })],
      ['request_export', args({ exportProfile: 'backup' }), args({ exportProfile: 'publish' })],
    ];
    for (const [op, before, after] of cases) {
      expect(key(op, [1], 'r', before), `${op} must invalidate`).not.toBe(key(op, [1], 'r', after));
    }
  });

  test('reason is covered too, which the original per-field invalidation missed', () => {
    expect(key('archive', [1], 'first reason', args())).not.toBe(key('archive', [1], 'second reason', args()));
  });

  test('selection and operation changes still invalidate', () => {
    expect(key('archive', [1, 2], 'r', args())).not.toBe(key('archive', [1], 'r', args()));
    expect(key('archive', [1], 'r', args())).not.toBe(key('pause', [1], 'r', args()));
  });

  test('an unchanged payload keeps the preview valid, including a reordered selection', () => {
    expect(key('archive', [1, 2, 3], 'r', args())).toBe(key('archive', [3, 1, 2], 'r', args()));
    expect(key('set_quota', [1], 'r', args({ storageQuotaBytes: '5' }))).toBe(
      key('set_quota', [1], 'r', args({ storageQuotaBytes: '5' })),
    );
  });

  test('irrelevant fields do not invalidate, so the gate is not noise', () => {
    // Editing the quota box while the operation is `archive` changes nothing that would
    // be sent, so a valid preview must survive it.
    expect(key('archive', [1], 'r', args({ storageQuotaBytes: '99', toUserId: '5' }))).toBe(
      key('archive', [1], 'r', args()),
    );
  });

  test('a completed apply is not reported as stale', () => {
    // REGRESSION in the fingerprint itself. After a real run the result is deliberately
    // KEPT so the per-item outcomes stay on screen, while the stored key is cleared and
    // the selection emptied. Comparing fingerprints unconditionally therefore called a
    // just-succeeded apply "out of date" and told the operator to re-run a dry run for
    // work that had already happened — beside the results proving it had.
    //
    // The staleness question only means anything about a PREVIEW, so it is scoped to
    // one. Mirrors the `preview.dryRun === true` guard on the page.
    const isStale = (previewDryRun: boolean, storedKey: string | null, current: string) =>
      previewDryRun === true && storedKey !== current;

    const afterApply = key('archive', [], 'r', args()); // selection cleared by the run
    // An applied result with a cleared key must NOT read as stale…
    expect(isStale(false, null, afterApply)).toBe(false);
    // …while a real preview whose inputs moved on still must…
    expect(isStale(true, key('archive', [1], 'r', args()), afterApply)).toBe(true);
    // …and an untouched preview still must not.
    expect(isStale(true, afterApply, afterApply)).toBe(false);
  });

  test('aiExternalContentPolicy passes the chosen value through rather than coercing', () => {
    // Cheap guard, not a current bug: the form treats this as "'' means unchanged, else
    // send it". If a third member were added to the enum, a boolean-ish or two-valued
    // shortcut here would silently misreport it as one of the existing two. Pinning
    // pass-through means that change fails a test instead of mislabelling a policy.
    for (const policy of ['disabled', 'member_consent'] as const) {
      const body = buildBulkPayload('set_policy', [1], true, 'r', args({ aiExternalContentPolicy: policy }));
      expect(body.aiExternalContentPolicy).toBe(policy);
    }
    // '' is the only value that means "leave it alone", and it is omitted entirely.
    const untouched = buildBulkPayload('set_policy', [1], true, 'r', args({ closePublicInvites: true }));
    expect('aiExternalContentPolicy' in untouched).toBe(false);
  });
});

test.describe('the operation chooser cannot display one verb and dispatch another', () => {
  test('keeps the current operation while it is still available', () => {
    const available = availableOperations([entry(1, 'active')]);
    expect(available).toContain('archive');
    expect(reconcileOperation('archive', available)).toBe('archive');
  });

  test('falls back to the first available option when the current one drops out', () => {
    // A `<select>` whose value matches no option renders the FIRST option while state
    // keeps the stale value — the operator reads one verb and dispatches another.
    const available: ReturnType<typeof availableOperations> = ['pause', 'set_quota'];
    expect(reconcileOperation('archive', available)).toBe('pause');
  });

  test('leaves the value alone when nothing is selected, so the chooser does not thrash', () => {
    expect(reconcileOperation('archive', [])).toBe('archive');
    expect(availableOperations([])).toEqual([]);
  });

  test('a selection of only completed campaigns really does drop archive', () => {
    const available = availableOperations([entry(1, 'completed')]);
    expect(available).not.toContain('archive');
    expect(reconcileOperation('archive', available)).toBe(available[0]);
  });
});
