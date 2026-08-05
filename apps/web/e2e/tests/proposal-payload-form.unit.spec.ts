import { expect, test } from '@playwright/test';
import { QuestCreate, QuestUpdate, CharacterCreate, EncounterGenerate } from '@campfire/schema';
import {
  buildProposalDraftPayload,
  computeGuidedProposalPreview,
  describeProposalFields,
  diffProposalChangedKeys,
  humanizeFieldKey,
  initProposalFieldBool,
  initProposalFieldText,
  computeProposalPreviewFromData,
  jsonFieldKeys,
  schemaForProposal,
  validateProposalPayload,
  type ProposalFieldDescriptor,
} from '../../src/features/proposals/proposalPayloadForm';

function fieldByKey(fields: ProposalFieldDescriptor[], key: string): ProposalFieldDescriptor {
  const found = fields.find((f) => f.key === key);
  if (!found) throw new Error(`no field descriptor for "${key}"`);
  return found;
}

test.describe('proposalPayloadForm: humanizeFieldKey', () => {
  test('title-cases the first word and expands known acronyms wherever they occur', () => {
    expect(humanizeFieldKey('title')).toBe('Title');
    expect(humanizeFieldKey('dmSecret')).toBe('DM secret');
    expect(humanizeFieldKey('mapAttachmentId')).toBe('Map attachment ID');
    expect(humanizeFieldKey('hpMax')).toBe('HP max');
    expect(humanizeFieldKey('npcId')).toBe('NPC ID');
    expect(humanizeFieldKey('sortOrder')).toBe('Sort order');
  });
});

test.describe('proposalPayloadForm: schemaForProposal', () => {
  test('resolves the exact server Create/Update schema for a known entity + action', () => {
    expect(schemaForProposal('quest', 'create')).toBe(QuestCreate);
    expect(schemaForProposal('quest', 'update')).toBe(QuestUpdate);
  });

  test('falls back to null (raw JSON advanced mode) for an entity type it does not recognize', () => {
    expect(schemaForProposal('map', 'create')).toBeNull();
    expect(schemaForProposal('not-a-real-type', 'update')).toBeNull();
  });
});

test.describe('proposalPayloadForm: describeProposalFields', () => {
  const fields = describeProposalFields(QuestCreate);

  test('classifies a required short string as a labeled single-line text field', () => {
    const title = fieldByKey(fields, 'title');
    expect(title.kind).toBe('text');
    expect(title.label).toBe('Title');
    expect(title.optional).toBe(false);
    expect(title.nullable).toBe(false);
    expect(title.help).toContain('Required');
  });

  test('classifies a long string (50k cap) as a textarea', () => {
    const body = fieldByKey(fields, 'body');
    expect(body.kind).toBe('textarea');
  });

  test('classifies an optional boolean with no Zod default (hidden) correctly', () => {
    const hidden = fieldByKey(fields, 'hidden');
    expect(hidden.kind).toBe('boolean');
    expect(hidden.optional).toBe(true);
  });

  test('classifies an enum-with-default as a select carrying every option', () => {
    const status = fieldByKey(fields, 'status');
    expect(status.kind).toBe('select');
    expect(status.optional).toBe(true); // has a Zod default, so may be omitted
    expect(status.options).toEqual(['available', 'active', 'completed', 'failed']);
  });

  test('classifies a nullable numeric FK (giverNpcId) as a nullable number field', () => {
    const giver = fieldByKey(fields, 'giverNpcId');
    expect(giver.kind).toBe('number');
    expect(giver.nullable).toBe(true);
  });

  test('excludes fields it cannot render as a guided control from the field list', () => {
    expect(fields.some((f) => f.key === 'linkedEncounters')).toBe(false);
  });
});

test.describe('proposalPayloadForm: jsonFieldKeys', () => {
  test('surfaces every top-level array/object/record field as a JSON-box key', () => {
    expect(jsonFieldKeys(QuestCreate)).toEqual(['linkedEncounters']);
    // Character has several record/array fields (stats, skills, spellSlots, resources,
    // conditions, saveProficiencies, actions) that describeProposalFields cannot render.
    const characterJsonKeys = jsonFieldKeys(CharacterCreate);
    expect(characterJsonKeys).toEqual(
      expect.arrayContaining(['stats', 'skills', 'spellSlots', 'resources', 'conditions', 'actions']),
    );
    // Never both a guided field AND a JSON-box key for the same name.
    const guidedKeys = new Set(describeProposalFields(CharacterCreate).map((f) => f.key));
    for (const key of characterJsonKeys) expect(guidedKeys.has(key)).toBe(false);
  });
});

test.describe('proposalPayloadForm: buildProposalDraftPayload', () => {
  const fields = describeProposalFields(QuestCreate);
  const jsonKeys = jsonFieldKeys(QuestCreate);

  test('flags a blank required text field as an error and leaves the merged object without it', () => {
    const text = initProposalFieldText(fields, jsonKeys, { title: 'Old title' });
    const bool = initProposalFieldBool(fields, { title: 'Old title' });
    const { data, fieldErrors } = buildProposalDraftPayload(fields, jsonKeys, { ...text, title: '' }, bool, {
      title: 'Old title',
    });
    expect(fieldErrors.title).toBe('This field is required.');
    expect(data.title).toBe('Old title'); // untouched fallback, not blanked out
  });

  test('sends an explicit empty string when a present optional text field is cleared', () => {
    // Round 3 (issue #769 review, Devin). This test previously asserted `'reward' in data`
    // was false — it locked in the bug. `reward` is `z.string().default('')` made optional by
    // `QuestUpdate = QuestCreate.partial()`, so it is optional-but-not-nullable, and omitting
    // it from a `.set({ ...input })` update leaves the column exactly as it was. A DM who
    // blanked the reward and approved kept the old text, while the preview said it changed.
    const text = initProposalFieldText(fields, jsonKeys, { title: 'Quest' });
    const bool = initProposalFieldBool(fields, { title: 'Quest' });
    const cleared = buildProposalDraftPayload(fields, jsonKeys, { ...text, reward: '' }, bool, {
      title: 'Quest',
      reward: 'Gold',
    });
    expect(cleared.fieldErrors).toEqual({});
    expect(cleared.data.reward).toBe('');
  });

  test('still omits an optional text field the proposal never carried', () => {
    // The other half of the same branch, unchanged: absent stays absent. Materializing `''`
    // for every untouched optional text field would blank columns across the entity — the
    // over-correction the fix above must not become.
    const text = initProposalFieldText(fields, jsonKeys, { title: 'Quest' });
    const bool = initProposalFieldBool(fields, { title: 'Quest' });
    const { data, fieldErrors } = buildProposalDraftPayload(fields, jsonKeys, text, bool, { title: 'Quest' });
    expect(fieldErrors).toEqual({});
    expect('reward' in data).toBe(false);
  });

  test('an omitted key IS reported as a change on a create, where nothing is left alone', () => {
    // Round 3, second pass (review). The omission rule above is update semantics — `.set({
    // ...input })` leaves an absent column as it was. A create has no row to leave alone: the
    // key falls back to a schema/service default, so the created entity really does differ from
    // what the proposal asked for. Reporting "no changes" there is the worse error, and its
    // sharpest form is a secrecy one: dropping an explicit `hidden: false` from a create is the
    // #754 flip to DM-only-by-default that this whole feature exists to make visible.
    expect(diffProposalChangedKeys({ title: 'Q', status: 'active' }, { title: 'Q' }, 'create')).toEqual(['status']);
    expect(diffProposalChangedKeys({ title: 'Q', hidden: false }, { title: 'Q' }, 'create')).toEqual(['hidden']);
    // ...and unchanged for an update, which is the default when no action is given.
    expect(diffProposalChangedKeys({ title: 'Q', hidden: false }, { title: 'Q' }, 'update')).toEqual([]);
    expect(diffProposalChangedKeys({ title: 'Q', hidden: false }, { title: 'Q' })).toEqual([]);
  });

  test('an omitted key is not reported as a changed field — omission changes nothing server-side', () => {
    // The preview's half of the same defect. A number/select field has no empty
    // representation, so clearing it can only omit the key; the diff used to report that as
    // `→ —`, promising a clear the request cannot perform. An explicit `null`, which DOES
    // clear the column, must still show — that distinction is the whole point of `sameJson`.
    expect(diffProposalChangedKeys({ title: 'Quest', reward: 'Gold' }, { title: 'Quest' })).toEqual([]);
    expect(diffProposalChangedKeys({ giverNpcId: 7 }, { giverNpcId: null })).toEqual(['giverNpcId']);
    // A key the payload ADDS is still a change; only the original-present/next-absent
    // direction is silent.
    expect(diffProposalChangedKeys({ title: 'Quest' }, { title: 'Quest', reward: 'Gold' })).toEqual(['reward']);
  });

  test('sets a nullable field to null when cleared', () => {
    const text = initProposalFieldText(fields, jsonKeys, { title: 'Quest', giverNpcId: 7 });
    const bool = initProposalFieldBool(fields, { title: 'Quest', giverNpcId: 7 });
    const { data } = buildProposalDraftPayload(fields, jsonKeys, { ...text, giverNpcId: '' }, bool, {
      title: 'Quest',
      giverNpcId: 7,
    });
    expect(data.giverNpcId).toBeNull();
  });

  test('rejects a non-numeric value typed into a number field', () => {
    const text = initProposalFieldText(fields, jsonKeys, { title: 'Quest', giverNpcId: 7 });
    const bool = initProposalFieldBool(fields, { title: 'Quest', giverNpcId: 7 });
    const { fieldErrors } = buildProposalDraftPayload(fields, jsonKeys, { ...text, giverNpcId: 'not-a-number' }, bool, {
      title: 'Quest',
      giverNpcId: 7,
    });
    expect(fieldErrors.giverNpcId).toBe('Enter a valid number.');
  });

  test('always sends an explicitly checked boolean, even when the original payload omitted it', () => {
    const text = initProposalFieldText(fields, jsonKeys, { title: 'Quest' });
    const bool = initProposalFieldBool(fields, { title: 'Quest', hidden: true });
    const { data } = buildProposalDraftPayload(fields, jsonKeys, text, bool, { title: 'Quest' });
    expect(data.hidden).toBe(true);
  });

  test('an untouched boolean absent from the original payload stays OMITTED, never coerced to false', () => {
    // Regression for a real secrecy-default bug this feature introduced: QuestCreate's
    // `hidden` has NO Zod default (issue #754's `resolveCreateHidden` — omitted means
    // "DM-only by default", an explicit `false` means "public"). If the guided editor's
    // checkbox always materialized an explicit boolean, opening the editor and clicking
    // Approve without ever touching the "Hidden" checkbox would silently flip an
    // omitted/DM-only-by-default quest to explicitly public. It must stay omitted.
    const text = initProposalFieldText(fields, jsonKeys, { title: 'Quest' });
    const bool = initProposalFieldBool(fields, { title: 'Quest' }); // original omits `hidden`
    const { data, fieldErrors } = buildProposalDraftPayload(fields, jsonKeys, text, bool, { title: 'Quest' });
    expect(fieldErrors).toEqual({});
    expect('hidden' in data).toBe(false);
  });

  test('an empty nullable field absent from the original payload stays OMITTED, never sent as an explicit null', () => {
    // Same invariant as the boolean case above, and missed for scalars on the first pass
    // (issue #769 review, Devin). `applyScalarField` checked `nullable` before `optional`,
    // so every optional+nullable field the proposal never mentioned was materialized as an
    // explicit `null`. That is destructive rather than cosmetic: `QuestsService.update`
    // writes `.set({ ...input })`, so `null` CLEARS the column while an omitted key leaves
    // it untouched. A DM opening this editor to fix a title and approving would silently
    // unlink the quest's giver NPC and parent quest.
    const original = { title: 'Quest' }; // no parentId / giverNpcId
    const text = initProposalFieldText(fields, jsonKeys, original);
    const bool = initProposalFieldBool(fields, original);
    const { data, fieldErrors } = buildProposalDraftPayload(fields, jsonKeys, text, bool, original);
    expect(fieldErrors).toEqual({});
    expect('parentId' in data).toBe(false);
    expect('giverNpcId' in data).toBe(false);
  });

  test('clearing a nullable field that WAS present sends an explicit null, so a real clear still works', () => {
    // The other half of the invariant: omission must not swallow a deliberate clear. The
    // user emptied a control that had a value, so `null` is the correct payload.
    const original = { title: 'Quest', giverNpcId: 7 };
    const text = initProposalFieldText(fields, jsonKeys, original);
    const bool = initProposalFieldBool(fields, original);
    const { data, fieldErrors } = buildProposalDraftPayload(
      fields,
      jsonKeys,
      { ...text, giverNpcId: '' },
      bool,
      original,
    );
    expect(fieldErrors).toEqual({});
    expect('giverNpcId' in data).toBe(true);
    expect(data.giverNpcId).toBeNull();
  });

  test('an explicit false already present in the original payload round-trips as false, not omitted', () => {
    const original = { title: 'Quest', hidden: false };
    const text = initProposalFieldText(fields, jsonKeys, original);
    const bool = initProposalFieldBool(fields, original);
    const { data } = buildProposalDraftPayload(fields, jsonKeys, text, bool, original);
    expect(data.hidden).toBe(false);
  });

  test('parses a per-field JSON box and flags invalid JSON without touching other fields', () => {
    const text = initProposalFieldText(fields, jsonKeys, { title: 'Quest', linkedEncounters: [{ id: 1 }] });
    const bool = initProposalFieldBool(fields, { title: 'Quest' });
    const original = { title: 'Quest', linkedEncounters: [{ id: 1 }] };
    const broken = buildProposalDraftPayload(fields, jsonKeys, { ...text, linkedEncounters: '{not json' }, bool, original);
    expect(broken.fieldErrors.linkedEncounters).toBe('Invalid JSON.');
    expect(broken.fieldErrors.title).toBeUndefined();

    const fixed = buildProposalDraftPayload(
      fields,
      jsonKeys,
      { ...text, linkedEncounters: '[{"id":2,"name":"Ambush","status":"preparing"}]' },
      bool,
      original,
    );
    expect(fixed.fieldErrors).toEqual({});
    expect(fixed.data.linkedEncounters).toEqual([{ id: 2, name: 'Ambush', status: 'preparing' }]);
  });

  test('passes through a key the schema does not declare at all, untouched', () => {
    const text = initProposalFieldText(fields, jsonKeys, { title: 'Quest' });
    const bool = initProposalFieldBool(fields, { title: 'Quest' });
    const { data } = buildProposalDraftPayload(fields, jsonKeys, text, bool, { title: 'Quest', futureField: 'kept' });
    expect(data.futureField).toBe('kept');
  });
});

test.describe('proposalPayloadForm: validateProposalPayload', () => {
  test('normalizes a valid draft, returning exactly the fields that were validated', () => {
    const result = validateProposalPayload(QuestCreate, { title: 'A quest', status: 'active' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ title: 'A quest', status: 'active' });
  });

  test('an omitted optional field is NOT materialized to its Zod default', () => {
    // QuestCreate wraps every field (including defaulted ones) in ZodOptional via its own
    // `.partial()` call; Zod's ZodOptional short-circuits on `undefined` before ever
    // reaching the inner ZodDefault, so an omitted `status`/`hidden` stays simply absent
    // rather than being filled in. This matters for the preview: an omitted optional
    // field must not appear as a "changed" key just because the schema COULD default it
    // (see computeGuidedProposalPreview's "clean edit" case below).
    const result = validateProposalPayload(QuestCreate, { title: 'A quest' });
    expect(result.ok).toBe(true);
    expect(result.data.status).toBeUndefined();
    expect(result.data.hidden).toBeUndefined(); // also true because QuestCreate's `hidden` has no Zod default (#754)
  });

  test('maps a schema violation back onto the offending field key', () => {
    const result = validateProposalPayload(QuestCreate, { title: '' });
    expect(result.ok).toBe(false);
    expect(result.fieldErrors.title).toBeTruthy();
    expect(typeof result.fieldErrors.title).toBe('string');
  });
});

test.describe('proposalPayloadForm: diffProposalChangedKeys', () => {
  test('reports only keys whose value actually differs, ignoring identical ones', () => {
    const changed = diffProposalChangedKeys({ title: 'Old', reward: 'Gold' }, { title: 'New', reward: 'Gold' });
    expect(changed).toEqual(['title']);
  });

  test('reports an added key, and stays silent about a removed one', () => {
    const changed = diffProposalChangedKeys({ title: 'Quest' }, { title: 'Quest', status: 'available' }).sort();
    expect(changed).toEqual(['status']);
    // A removed key was reported as changed until round 3 of the #769 review. It is not: an
    // omitted key leaves the column untouched under `.set({ ...input })`, so calling it a
    // change promised the DM a clear the request would never perform. The full reasoning and
    // the explicit-null counterpart live in the omit-vs-clear test above.
    const removed = diffProposalChangedKeys({ title: 'Quest', reward: 'Gold' }, { title: 'Quest' });
    expect(removed).toEqual([]);
  });
});

test.describe('proposalPayloadForm: computeGuidedProposalPreview (end-to-end)', () => {
  const fields = describeProposalFields(QuestCreate);
  const jsonKeys = jsonFieldKeys(QuestCreate);
  const originalPayload = { title: 'Old title', reward: 'Gold' };

  test('a clean edit normalizes and reports exactly the fields that changed', () => {
    const text = { ...initProposalFieldText(fields, jsonKeys, originalPayload), title: 'New title' };
    const bool = initProposalFieldBool(fields, originalPayload);
    const preview = computeGuidedProposalPreview(fields, jsonKeys, text, bool, originalPayload, QuestCreate);
    expect(preview.fieldErrors).toEqual({});
    expect(preview.normalized?.title).toBe('New title');
    expect(preview.changedKeys).toContain('title');
    expect(preview.changedKeys).not.toContain('reward');
  });

  test('an invalid field blocks normalization and is reported by key, but the draft is preserved', () => {
    const text = { ...initProposalFieldText(fields, jsonKeys, originalPayload), title: '' };
    const bool = initProposalFieldBool(fields, originalPayload);
    const preview = computeGuidedProposalPreview(fields, jsonKeys, text, bool, originalPayload, QuestCreate);
    expect(preview.normalized).toBeNull();
    expect(preview.fieldErrors.title).toBeTruthy();
    // The best-effort draft keeps the ORIGINAL title rather than the blanked value, so
    // switching to advanced mode (or re-rendering) doesn't silently discard the proposal.
    expect(preview.draft.title).toBe('Old title');
  });

  test('with no known schema, the draft is returned as the normalized result unchanged', () => {
    const preview = computeGuidedProposalPreview([], [], {}, {}, { foo: 'bar' }, null);
    expect(preview.normalized).toEqual({ foo: 'bar' });
    expect(preview.changedKeys).toEqual([]);
  });
});

test.describe('proposalPayloadForm: server-contract alignment (issue #769 review)', () => {
  test('an encounter proposal resolves the GENERATOR schema the server validates against, not EncounterCreate', () => {
    // The server maps `encounter` to `EncounterGenerate.strict()` for BOTH create and
    // update (proposals.service.ts): an encounter proposal's payload is the seeded
    // generator request, and approving re-runs generate_encounter. Mapping it to
    // Encounter{Create,Update} rendered controls for fields the payload never has while
    // dropping `difficulty`/`seed`/`party`/`filters`, so approve 400d on the missing
    // required `difficulty`.
    expect(schemaForProposal('encounter', 'create')).toBe(EncounterGenerate);
    expect(schemaForProposal('encounter', 'update')).toBe(EncounterGenerate);

    // The generator params must therefore survive a round-trip rather than being stripped.
    const payload = { difficulty: 'hard', seed: 42, count: 3 };
    const preview = computeProposalPreviewFromData(payload, payload, EncounterGenerate);
    expect(preview.normalized).toMatchObject({ difficulty: 'hard', seed: 42, count: 3 });
  });

  test('`campaign` is not a proposable entity type, so it falls back to raw JSON', () => {
    // ProposableEntityType has no `campaign` member — the server could never receive one.
    // Claiming to know its schema would have shown a guided editor for a proposal that
    // cannot exist.
    expect(schemaForProposal('campaign', 'create')).toBeNull();
  });

  test('a key the shared schema does not declare SURVIVES validation instead of being stripped', () => {
    // Zod 3 strips unknown keys. Returning the parsed object as the submitted payload
    // deleted content the proposer wrote — the exact "invisible drop until a DM approves
    // an emptier-than-intended entity" the server applies `.strict()` to prevent. Unknown
    // keys must reach the server so its strict check can surface a misnamed key as a 400.
    const payload = { title: 'Quest', someUndeclaredKey: 'must survive' };
    const preview = computeProposalPreviewFromData(payload, payload, QuestUpdate);
    expect(preview.normalized).toMatchObject({ title: 'Quest', someUndeclaredKey: 'must survive' });
  });

  test('presence is judged against the working payload, so an explicit raw-mode value is honoured', () => {
    // After a round-trip through advanced mode the omit-vs-explicit decision must consult
    // what the user is actually working from, not the proposal as originally submitted.
    // Judging against the original would delete an explicit `hidden: false` typed in raw
    // mode — flipping an intended-public quest back to DM-only-by-default.
    const original = { title: 'Quest' };
    const working = { title: 'Quest', hidden: false };
    const fields = describeProposalFields(QuestUpdate);
    const jsonKeys = jsonFieldKeys(QuestUpdate);
    const text = initProposalFieldText(fields, jsonKeys, working);
    const bool = initProposalFieldBool(fields, working);
    const { data } = buildProposalDraftPayload(fields, jsonKeys, text, bool, original, working);
    expect('hidden' in data).toBe(true);
    expect(data.hidden).toBe(false);
  });
});

test.describe('proposalPayloadForm: advanced-mode guardrails (issue #769 review)', () => {
  test('an empty payload is not silently "no changes" under update semantics', () => {
    // The editor refuses an emptied raw box outright, but this pins WHY it has to: `{}`
    // validates cleanly against every *Update schema (every field optional), and the omission
    // rule then reports nothing changed — for a payload that dropped every field. The two
    // behaviours have to be read together, so the diff's half is asserted here.
    expect(validateProposalPayload(QuestUpdate, {}).ok).toBe(true);
    expect(diffProposalChangedKeys({ title: 'Q', reward: 'Gold' }, {}, 'update')).toEqual([]);
    // On a create the same payload is loudly different, which is the point of the split.
    expect(diffProposalChangedKeys({ title: 'Q', reward: 'Gold' }, {}, 'create').sort()).toEqual(['reward', 'title']);
  });

  test('an unparseable per-field JSON box leaves the original value in the best-effort draft', () => {
    // This is what makes serializing that draft into raw mode lossy: the field error is
    // recorded, but `data[key]` still holds the value seeded from the working payload, so the
    // reviewer's half-typed text is nowhere in it. The editor refuses the switch for exactly
    // this reason; this pins the underlying shape the refusal is protecting against.
    const fields = describeProposalFields(QuestUpdate);
    const jsonKeys = jsonFieldKeys(QuestUpdate);
    const original = { title: 'Q', linkedEncounters: [1, 2] };
    const text = initProposalFieldText(fields, jsonKeys, original);
    const bool = initProposalFieldBool(fields, original);
    const built = buildProposalDraftPayload(
      fields,
      jsonKeys,
      { ...text, linkedEncounters: '[1, 2' },
      bool,
      original,
    );
    expect(built.fieldErrors.linkedEncounters).toBeTruthy();
    expect(built.data.linkedEncounters).toEqual([1, 2]);
  });
});
