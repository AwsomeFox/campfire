import { expect, test } from '@playwright/test';
import type { CampaignCatalogBulkResult, CampaignCatalogEntry } from '@campfire/schema';
import { CAMPAIGN_CATALOG_NO_OP_REASON } from '@campfire/schema';
import {
  EMPTY_BULK_ARGS,
  availableOperations,
  buildBulkPayload,
  bulkArgsError,
  bulkPayloadFingerprint,
  createLatestOnlyGate,
  isNoOpResult,
  reconcileOperation,
  selectedEntriesFrom,
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

test.describe('a selection spanning pages is not silently dropped', () => {
  // The selection used to be a `Set<number>` that survived pagination while the derived
  // entries were `items.filter(...)` over the CURRENT page — so ticking campaigns across
  // three pages dispatched only the visible ones, with no error and no skip reason. The
  // model is now a Map holding the entries themselves; these pin what that buys.

  // `derive` IS the function the page calls — imported, not re-implemented. A local
  // copy would pass no matter what AdminCatalogPage did, which is the exact trap this
  // suite exists to avoid.
  const derive = selectedEntriesFrom;

  test('entries selected on earlier pages survive navigating away', () => {
    const selected = new Map<number, CampaignCatalogEntry>();
    for (const e of [entry(1, 'active'), entry(2, 'active')]) selected.set(e.id, e);
    // Page 2 renders entirely different rows; the earlier ticks must persist.
    for (const e of [entry(30, 'active'), entry(31, 'active')]) selected.set(e.id, e);

    const derived = derive(selected);
    expect(derived.map((c) => c.id)).toEqual([1, 2, 30, 31]);
    // The count the header shows and the ids the payload carries are the same four.
    expect(
      buildBulkPayload(
        'archive',
        derived.map((c) => c.id),
        true,
        'r',
        args(),
      ).campaignIds,
    ).toEqual([1, 2, 30, 31]);
  });

  test('the dispatched batch is exactly what the count claims', () => {
    // The precise defect: twelve ticked across three pages, count said four, four ran.
    // Ids chosen to straddle three pages at CATALOG_PAGE_SIZE=25: four on page 1, four
    // on page 2, four on page 3. Any derivation scoped to a single page loses eight.
    const ids = [1, 2, 3, 4, 26, 27, 28, 29, 51, 52, 53, 54];
    const selected = new Map<number, CampaignCatalogEntry>();
    for (const id of ids) selected.set(id, entry(id, 'active'));
    const derived = derive(selected);
    expect(derived).toHaveLength(12);
    expect(derived.map((c) => c.id)).toEqual(ids);
    expect(
      buildBulkPayload(
        'archive',
        derived.map((c) => c.id),
        false,
        'sweep',
        args(),
      ).campaignIds,
    ).toHaveLength(12);
  });

  test('unticking removes an off-page entry too', () => {
    const selected = new Map<number, CampaignCatalogEntry>();
    for (const e of [entry(1, 'active'), entry(30, 'active'), entry(60, 'active')]) selected.set(e.id, e);
    selected.delete(30);
    // 60 is also off-page and must SURVIVE — untick removes one entry, not everything
    // that happens not to be visible.
    expect(derive(selected).map((c) => c.id)).toEqual([1, 60]);
  });

  test('click order does not change the payload or its fingerprint', () => {
    // Sorting by id keeps the batch and its preview fingerprint stable, so selecting the
    // same campaigns in a different order does not read as a different batch.
    const a = new Map<number, CampaignCatalogEntry>();
    for (const e of [entry(30, 'active'), entry(1, 'active'), entry(2, 'active')]) a.set(e.id, e);
    const b = new Map<number, CampaignCatalogEntry>();
    for (const e of [entry(1, 'active'), entry(2, 'active'), entry(30, 'active')]) b.set(e.id, e);
    expect(derive(a).map((c) => c.id)).toEqual(derive(b).map((c) => c.id));
    expect(
      bulkPayloadFingerprint(
        'archive',
        derive(a).map((c) => c.id),
        'r',
        args(),
      ),
    ).toBe(
      bulkPayloadFingerprint(
        'archive',
        derive(b).map((c) => c.id),
        'r',
        args(),
      ),
    );
  });

  test('operation eligibility accounts for off-page selections', () => {
    // A completed campaign ticked on page 1 must still narrow the verbs on page 3,
    // rather than becoming invisible to `availableOperations` once it scrolls away.
    const selected = new Map<number, CampaignCatalogEntry>();
    selected.set(60, entry(60, 'completed')); // ticked on an earlier page, now off-screen
    expect(derive(selected).map((c) => c.id)).toEqual([60]);
    expect(availableOperations(derive(selected))).not.toContain('archive');
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

test.describe('a superseded catalog load cannot repaint the table', () => {
  // `load()` fires on every filter, sort and page change and nothing sequenced the
  // responses, so whichever resolved LAST called setPage. A slow response for a
  // superseded query therefore painted rows that do not match the visible controls —
  // and on this screen those rows are selectable into a bulk operation that reassigns
  // ownership and rewrites privacy policy.
  //
  // `gate` IS the function the page calls, imported rather than re-implemented.

  test('a slow earlier load loses to a fast later one', async () => {
    const gate = createLatestOnlyGate();
    const committed: string[] = [];

    // Request A starts first but resolves last (the slow, superseded query).
    const slowEarlier = gate.start();
    // Request B starts second and resolves first (what the operator is looking at).
    const fastLater = gate.start();

    await new Promise((r) => setTimeout(r, 1));
    if (fastLater()) committed.push('later');
    await new Promise((r) => setTimeout(r, 5));
    if (slowEarlier()) committed.push('earlier');

    // Only the newest query may paint, no matter which response arrives last.
    expect(committed).toEqual(['later']);
  });

  test('the newest attempt always wins regardless of resolution order', () => {
    const gate = createLatestOnlyGate();
    const a = gate.start();
    const b = gate.start();
    const c = gate.start();
    expect(a()).toBe(false);
    expect(b()).toBe(false);
    expect(c()).toBe(true);
  });

  test('a lone load is allowed to commit', () => {
    const gate = createLatestOnlyGate();
    const only = gate.start();
    expect(only()).toBe(true);
  });

  test('gates are independent, so one page does not invalidate another', () => {
    const a = createLatestOnlyGate();
    const b = createLatestOnlyGate();
    const first = a.start();
    b.start();
    expect(first()).toBe(true);
  });

  test('a stale row never reaches the retained selection', () => {
    // The interaction with the cross-page selection model: `selected` deliberately
    // survives pagination, so a stale row that got painted could be ticked and then
    // carried through further navigation INSIDE the bulk payload. The gate is what stops
    // the stale rows existing to be ticked in the first place.
    const gate = createLatestOnlyGate();
    const selected = new Map<number, CampaignCatalogEntry>();
    const commit = (isNewest: () => boolean, rows: CampaignCatalogEntry[]) => {
      if (!isNewest()) return [] as CampaignCatalogEntry[];
      return rows;
    };

    const staleAttempt = gate.start();          // filter "active"
    const currentAttempt = gate.start();        // operator switched to "completed"

    const currentRows = commit(currentAttempt, [entry(1, 'completed')]);
    const staleRows = commit(staleAttempt, [entry(99, 'active')]);

    for (const e of [...currentRows, ...staleRows]) selected.set(e.id, e);

    // The stale campaign is not paintable, therefore not tickable, therefore absent from
    // the payload — including after further paging, since the Map only holds what was
    // actually selected.
    expect(staleRows).toEqual([]);
    expect(selectedEntriesFrom(selected).map((c) => c.id)).toEqual([1]);
    expect(
      buildBulkPayload('archive', selectedEntriesFrom(selected).map((c) => c.id), true, 'r', args()).campaignIds,
    ).toEqual([1]);
  });
});


/**
 * The "nothing would change" hint is a claim about WHY, and the counts do not carry a
 * why. `applied === 0 && wouldApply === 0` is satisfied just as well by a batch in which
 * every item failed, which printed a reassuring summary directly above the failures.
 */
test.describe('isNoOpResult only claims a no-op it can evidence', () => {
  const result = (
    over: Partial<CampaignCatalogBulkResult> & { results?: CampaignCatalogBulkResult['results'] },
  ): CampaignCatalogBulkResult =>
    ({
      operation: 'archive',
      dryRun: true,
      requested: 1,
      wouldApply: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      results: [],
      ...over,
    }) as CampaignCatalogBulkResult;

  const item = (outcome: string, reason: string) =>
    ({ campaignId: 1, outcome, reason, field: '', before: '', after: '', stateVersion: 'v' }) as
      CampaignCatalogBulkResult['results'][number];

  test('is true when every item skipped because it was already in that state', () => {
    expect(
      isNoOpResult(
        result({ skipped: 1, results: [item('skipped', CAMPAIGN_CATALOG_NO_OP_REASON)] }),
      ),
    ).toBe(true);
  });

  test('is false when the batch failed outright', () => {
    // The regression: zero applied and zero wouldApply, because everything blew up.
    expect(
      isNoOpResult(result({ failed: 2, results: [item('failed', 'database is locked')] })),
    ).toBe(false);
  });

  test('is false when the skips were for some other reason', () => {
    for (const reason of [
      'campaign is in the trash',
      'changed since the preview; run the dry run again',
      'an export request is already pending for this campaign',
    ]) {
      expect(isNoOpResult(result({ skipped: 1, results: [item('skipped', reason)] }))).toBe(false);
    }
  });

  test('is false for an empty batch, which is not evidence of anything', () => {
    expect(isNoOpResult(result({ requested: 0 }))).toBe(false);
  });

  test('is false when a real change is pending', () => {
    expect(
      isNoOpResult(result({ wouldApply: 1, results: [item('would_apply', '')] })),
    ).toBe(false);
  });
});
