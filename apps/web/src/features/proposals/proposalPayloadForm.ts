/**
 * Schema-driven proposal payload editing (issue #769).
 *
 * Pure logic only — no DOM/React here so it's covered by the pure-Node unit tier
 * (`proposal-payload-form.unit.spec.ts`, `npm run test:unit:web`). `ProposalPayloadEditor.tsx`
 * is the React shell that renders this model.
 *
 * The review queue's payload editor was a single unlabeled JSON textarea (`ProposalsPage.tsx`,
 * pre-#769) with no per-field errors, no schema guidance, and no preview of what approving
 * would actually change. This module walks the SAME Create/Update Zod object the server
 * validates against (`@campfire/schema` — never redefined here, per AGENTS.md) to drive:
 *   - persistent labels/help text per field (`describeProposalFields`);
 *   - per-field parse/validation errors keyed by field name, so the UI can associate and
 *     focus the exact invalid control (`computeGuidedProposalPreview`, `fieldErrors`);
 *   - a normalized-result preview and the list of changed top-level keys
 *     (`computeProposalPreviewFromData`, `diffProposalChangedKeys`);
 *   - "raw JSON" as an always-available advanced mode for any field kind the guided walker
 *     can't render as a simple control (arrays/objects/records) and for any entityType this
 *     module doesn't recognize at all (`schemaForProposal` returns null).
 *
 * Only top-level scalar/enum fields get a dedicated guided control (text/number/boolean/
 * select). Anything else (arrays, nested objects, records — e.g. a Character's `stats` or
 * `skills`) still gets a labeled per-field JSON box rather than one blob for the whole
 * payload — schema-driven in the sense the acceptance criteria asks for, without hand-authoring
 * bespoke widgets per entity (out of scope for this change; file a follow-up issue for that).
 */
import { z } from 'zod';
import {
  CharacterCreate,
  CharacterUpdate,
  EncounterGenerate,
  FactionCreate,
  FactionUpdate,
  LocationCreate,
  LocationUpdate,
  NpcCreate,
  NpcUpdate,
  QuestCreate,
  QuestUpdate,
  SessionCreate,
  SessionUpdate,
  type Proposal,
} from '@campfire/schema';

export type ProposalEntityType = Proposal['entityType'];
export type ProposalEditableAction = 'create' | 'update';

const PROPOSAL_SCHEMAS: Partial<Record<ProposalEntityType, { create: z.AnyZodObject; update: z.AnyZodObject }>> = {
  quest: { create: QuestCreate, update: QuestUpdate },
  npc: { create: NpcCreate, update: NpcUpdate },
  faction: { create: FactionCreate, update: FactionUpdate },
  location: { create: LocationCreate, update: LocationUpdate },
  character: { create: CharacterCreate, update: CharacterUpdate },
  session: { create: SessionCreate, update: SessionUpdate },
  // An encounter proposal's payload is the seeded GENERATOR request, not a persisted
  // encounter row — approving re-runs `generate_encounter` (issue #313). The server
  // validates it with `EncounterGenerate.strict()` for BOTH create and update
  // (`proposals.service.ts` CREATE_SCHEMAS/UPDATE_SCHEMAS), so mapping it to
  // Encounter{Create,Update} here rendered controls for fields the payload does not have
  // while silently dropping the ones it does (`difficulty`, `seed`, `party`, `filters`),
  // and the approve then 400d on the missing required `difficulty` (issue #769 review).
  encounter: { create: EncounterGenerate, update: EncounterGenerate },
};

/** The Create/Update schema for a known proposal entity type, or null (falls back to raw JSON). */
export function schemaForProposal(
  entityType: string,
  action: ProposalEditableAction,
): z.AnyZodObject | null {
  const entry = PROPOSAL_SCHEMAS[entityType as ProposalEntityType];
  if (!entry) return null;
  return action === 'create' ? entry.create : entry.update;
}

export type ProposalFieldKind = 'text' | 'textarea' | 'number' | 'boolean' | 'select';

export interface ProposalFieldDescriptor {
  key: string;
  kind: ProposalFieldKind;
  label: string;
  help: string;
  /** May be omitted from the payload entirely (optional or has a server default). */
  optional: boolean;
  /** May be explicit `null`. */
  nullable: boolean;
  options?: string[];
}

const ACRONYMS = new Set(['id', 'url', 'ai', 'dm', 'xp', 'hp', 'ac', 'eac', 'kac', 'sp', 'rp', 'npc']);

/** "mapAttachmentId" -> "Map attachment ID"; "dmSecret" -> "DM secret"; "hidden" -> "Hidden". */
export function humanizeFieldKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean);
  return words
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

interface UnwrapResult {
  inner: z.ZodTypeAny;
  optional: boolean;
  nullable: boolean;
}

/** Peels ZodOptional/ZodNullable/ZodDefault wrappers to find the leaf type. */
function unwrap(schema: z.ZodTypeAny): UnwrapResult {
  let cur = schema;
  let optional = false;
  let nullable = false;
  for (;;) {
    if (cur instanceof z.ZodOptional) {
      optional = true;
      cur = cur.unwrap();
      continue;
    }
    if (cur instanceof z.ZodNullable) {
      nullable = true;
      cur = cur.unwrap();
      continue;
    }
    if (cur instanceof z.ZodDefault) {
      optional = true;
      cur = cur.removeDefault();
      continue;
    }
    break;
  }
  return { inner: cur, optional, nullable };
}

function numericChecks(inner: z.ZodNumber): { min?: number; max?: number; int: boolean } {
  const checks = inner._def.checks;
  let min: number | undefined;
  let max: number | undefined;
  let int = false;
  for (const check of checks) {
    if (check.kind === 'min') min = check.value;
    else if (check.kind === 'max') max = check.value;
    else if (check.kind === 'int') int = true;
  }
  return { min, max, int };
}

function stringChecks(inner: z.ZodString): { min?: number; max?: number } {
  const checks = inner._def.checks;
  let min: number | undefined;
  let max: number | undefined;
  for (const check of checks) {
    if (check.kind === 'min') min = check.value;
    else if (check.kind === 'max') max = check.value;
  }
  return { min, max };
}

/** Long strings (bodies, secrets, notes) get a textarea; everything else a single-line input. */
const TEXTAREA_MIN_MAX_LENGTH = 200;

function describeField(key: string, raw: z.ZodTypeAny): ProposalFieldDescriptor | null {
  const { inner, optional, nullable } = unwrap(raw);
  const label = humanizeFieldKey(key);
  const requiredNote = optional || nullable ? 'Optional.' : 'Required.';

  if (inner instanceof z.ZodString) {
    const { min, max } = stringChecks(inner);
    const bounds = min && max ? `${min}–${max} characters.` : max ? `Up to ${max} characters.` : min ? `At least ${min} characters.` : '';
    const kind: ProposalFieldKind = max && max > TEXTAREA_MIN_MAX_LENGTH ? 'textarea' : 'text';
    return { key, kind, label, help: [requiredNote, bounds].filter(Boolean).join(' '), optional, nullable };
  }
  if (inner instanceof z.ZodNumber) {
    const { min, max, int } = numericChecks(inner);
    const bounds = min !== undefined && max !== undefined ? `${min} to ${max}.` : max !== undefined ? `Up to ${max}.` : min !== undefined ? `At least ${min}.` : '';
    return {
      key,
      kind: 'number',
      label,
      help: [requiredNote, int ? 'Whole number.' : 'Number.', bounds].filter(Boolean).join(' '),
      optional,
      nullable,
    };
  }
  if (inner instanceof z.ZodBoolean) {
    return { key, kind: 'boolean', label, help: requiredNote, optional, nullable };
  }
  if (inner instanceof z.ZodEnum) {
    const options = inner.options as string[];
    return {
      key,
      kind: 'select',
      label,
      help: `${requiredNote} Choose one of: ${options.join(', ')}.`,
      optional,
      nullable,
      options,
    };
  }
  // Arrays, nested objects, records, unions, etc. — not a guided control; the editor
  // falls back to a per-field JSON box (see `jsonFieldKeys`).
  return null;
}

/** Every top-level field the editor knows how to render as a guided control. */
export function describeProposalFields(schema: z.AnyZodObject): ProposalFieldDescriptor[] {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  return Object.keys(shape)
    .map((key) => describeField(key, shape[key]))
    .filter((field): field is ProposalFieldDescriptor => field !== null);
}

/** Top-level keys the schema declares that `describeProposalFields` can't render as a
 *  guided control (nested objects/arrays/records/unions) — each still gets its own
 *  labeled JSON box rather than being silently dropped into the untouched-passthrough set. */
export function jsonFieldKeys(schema: z.AnyZodObject): string[] {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  return Object.keys(shape).filter((key) => describeField(key, shape[key]) === null);
}

export function jsonFieldMeta(key: string, schema: z.AnyZodObject): { label: string; optional: boolean; nullable: boolean } {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const { optional, nullable } = unwrap(shape[key]);
  return { label: humanizeFieldKey(key), optional, nullable };
}

export type ProposalFieldTextState = Record<string, string>;
/**
 * Tri-state, not boolean (issue #769 review, Devin). `undefined` means NOT SET — the key is
 * absent from the payload — and that is a third, meaningful state, not a synonym for `false`.
 *
 * `resolveCreateHidden` (#754) reads an omitted `hidden` on a create as DM-only and an
 * explicit `false` as public, so a plain checkbox both misreported the state (rendered
 * unchecked, i.e. "public", for a payload that would create the entity DM-only) and made the
 * explicit-`false` case unreachable: unchecking an already-unchecked box still omits.
 */
export type ProposalFieldBoolState = Record<string, boolean | undefined>;

function fieldToText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value);
}

export function initProposalFieldText(
  fields: ProposalFieldDescriptor[],
  jsonKeys: string[],
  payload: Record<string, unknown>,
): ProposalFieldTextState {
  const text: ProposalFieldTextState = {};
  for (const f of fields) {
    if (f.kind === 'boolean') continue;
    text[f.key] = fieldToText(payload[f.key]);
  }
  for (const key of jsonKeys) {
    const value = payload[key];
    text[key] = value === undefined ? '' : JSON.stringify(value, null, 2);
  }
  return text;
}

export function initProposalFieldBool(
  fields: ProposalFieldDescriptor[],
  payload: Record<string, unknown>,
): ProposalFieldBoolState {
  const bool: ProposalFieldBoolState = {};
  for (const f of fields) {
    if (f.kind !== 'boolean') continue;
    // Absent stays absent — see the tri-state note on ProposalFieldBoolState.
    bool[f.key] = f.key in payload ? Boolean(payload[f.key]) : undefined;
  }
  return bool;
}

export interface ProposalDraftBuild {
  /** Best-effort merged object: known fields from `text`/`bool`, JSON fields parsed where
   *  possible, plus every original key this schema doesn't know about, passed through
   *  untouched. Always populated — used for the mode-switch serialization and for the
   *  preview even when invalid. */
  data: Record<string, unknown>;
  /** Field key -> message, for keys where a guided control couldn't build a valid value
   *  (empty required field, non-numeric number box, invalid per-field JSON). */
  fieldErrors: Record<string, string>;
}

function applyScalarField(
  f: ProposalFieldDescriptor,
  raw: string,
  data: Record<string, unknown>,
  fieldErrors: Record<string, string>,
  wasPresent: boolean,
): void {
  if (raw === '') {
    // Same "omit != false" invariant the boolean branch below documents, and it applies
    // here for the same reason — this branch originally checked `nullable` FIRST, which
    // meant every optional+nullable field the proposal never mentioned was materialized
    // as an explicit `null` (issue #769 review, Devin). That is not a cosmetic
    // difference: `QuestsService.update` writes `.set({ ...input })`, so an explicit
    // `null` CLEARS the column while an omitted key leaves it untouched. A DM who opened
    // this editor to fix a title and approved would silently unlink the quest's
    // `giverNpcId` and `parentId` (both `Id.nullable().default(null)`, made optional by
    // `QuestUpdate = QuestCreate.partial()`), or wipe a faction's `portraitUrl`.
    //
    // An empty control therefore means "leave it alone" when the key was ABSENT from the
    // proposal, and "clear it" only when the key was actually there for the user to
    // clear. `wasPresent` is passed rather than derived from `data`, because `data` is
    // seeded from the original payload and mutated as fields are applied.
    // Round 3 (review). A field that WAS present and is optional-but-not-nullable — Quest's
    // `reward` / `body` / `dmSecret`, all `z.string().default('')` made optional by
    // `.partial()` — used to fall through to the same omission, so a DM who deliberately
    // blanked a description got nothing: `.set({ ...input })` leaves an omitted column
    // untouched, while the preview (which sees `'Gold'` become `undefined`) told them the
    // field WOULD be cleared. An empty string is the clear those fields actually have, and
    // sending it makes the request do what the preview promises.
    //
    // Number and select have no empty representation — `''` is not a number and not a member
    // of any enum — so those keep omitting, and the diff below no longer reports an omitted
    // key as a change, so the preview stops promising a clear that cannot be expressed.
    if (f.optional && !wasPresent) delete data[f.key];
    else if (f.nullable) data[f.key] = null;
    else if (f.optional && (f.kind === 'text' || f.kind === 'textarea')) data[f.key] = '';
    else if (f.optional) delete data[f.key];
    else fieldErrors[f.key] = f.kind === 'select' ? 'Choose an option.' : f.kind === 'number' ? 'Enter a number.' : 'This field is required.';
    return;
  }
  if (f.kind === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) {
      fieldErrors[f.key] = 'Enter a valid number.';
      return;
    }
    data[f.key] = n;
    return;
  }
  data[f.key] = raw;
}

/** Builds the merged draft object from guided-editor state (scalar fields + per-field JSON
 *  boxes) plus untouched passthrough of any key the schema doesn't cover at all. */
export function buildProposalDraftPayload(
  fields: ProposalFieldDescriptor[],
  jsonKeys: string[],
  text: ProposalFieldTextState,
  bool: ProposalFieldBoolState,
  originalPayload: Record<string, unknown>,
  /** Seed for passthrough keys — see `computeGuidedProposalPreview`. Defaults to the
   *  original payload, which is correct until the draft has been through advanced mode. */
  passthroughBase: Record<string, unknown> = originalPayload,
): ProposalDraftBuild {
  const data: Record<string, unknown> = { ...passthroughBase };
  const fieldErrors: Record<string, string> = {};

  for (const f of fields) {
    if (f.kind === 'boolean') {
      const checked = bool[f.key];
      // "Omit != false" is a real, documented server invariant for optional booleans
      // with no Zod default (e.g. `hidden` — issue #754's `resolveCreateHidden`: an
      // omitted `hidden` defaults to DM-only, while an explicit `false` makes a create
      // public). An untouched checkbox for a key absent from the original payload must
      // therefore stay OMITTED, not be coerced to an explicit `false` just because a
      // checkbox always renders some boolean. Checking it True, or a key that was
      // already explicitly present (any value), is always sent explicitly.
      // Tri-state: "not set" omits the key in BOTH modes, and it means the right thing in
      // each — on a create the server applies its own default (DM-only, for `hidden`), on an
      // update `.set({ ...input })` leaves the column alone. `true`/`false` are both sent
      // explicitly, which is what makes an intentionally-public create expressible here at
      // all rather than only in raw JSON.
      if (checked === undefined) {
        delete data[f.key];
      } else {
        data[f.key] = checked;
      }
      continue;
    }
    applyScalarField(f, text[f.key] ?? '', data, fieldErrors, f.key in passthroughBase);
  }

  for (const key of jsonKeys) {
    const raw = (text[key] ?? '').trim();
    if (raw === '') {
      delete data[key];
      continue;
    }
    try {
      data[key] = JSON.parse(raw);
    } catch {
      fieldErrors[key] = 'Invalid JSON.';
    }
  }

  return { data, fieldErrors };
}

export interface ProposalValidation {
  ok: boolean;
  data: Record<string, unknown>;
  fieldErrors: Record<string, string>;
  formError: string | null;
}

/** Runs the actual server-side Create/Update schema against a built draft object, mapping
 *  Zod issues back onto field keys so guided AND advanced mode share one error surface. */
export function validateProposalPayload(schema: z.ZodTypeAny, data: Record<string, unknown>): ProposalValidation {
  const result = schema.safeParse(data);
  if (result.success) {
    return { ok: true, data: result.data as Record<string, unknown>, fieldErrors: {}, formError: null };
  }
  const fieldErrors: Record<string, string> = {};
  let formError: string | null = null;
  for (const issue of result.error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string') {
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    } else if (!formError) {
      formError = issue.message;
    }
  }
  return { ok: false, data, fieldErrors, formError };
}

function sameJson(a: unknown, b: unknown): boolean {
  // NOT `a ?? null` on both sides (issue #769 review — Copilot and Kilo, independently).
  // Coercing `undefined` to `null` made "key omitted" and "key explicitly null"
  // indistinguishable, so the preview stayed silent about the single most destructive
  // edit this editor can make: an explicit `null` is what CLEARS a column server-side
  // (`.set({ ...input })`), while omission leaves it untouched. `JSON.stringify(undefined)`
  // is `undefined` and `JSON.stringify(null)` is `"null"`, so they now compare unequal and
  // the changed-fields list reports a deliberate clear.
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Top-level keys whose value differs (structurally) between the original proposal
 *  payload and a candidate next payload — drives the preview's changed-fields list. */
export function diffProposalChangedKeys(
  original: Record<string, unknown>,
  next: Record<string, unknown>,
  /**
   * Which approve path this payload will take. It decides what an OMITTED key means, and the
   * two meanings are opposite (round 3 review, Devin):
   *
   *  - `'update'` — `.set({ ...input })` leaves an absent column exactly as it was, so an
   *    omission changes nothing and reporting `reward  Gold → —` promises a clear the request
   *    cannot perform.
   *  - `'create'` — there is no existing row to leave alone. An absent key falls back to the
   *    schema/service default, so the created entity really does differ from what the proposal
   *    said. Silence there is worse than a false positive: dropping an explicit `hidden: false`
   *    from a create is exactly the #754 secrecy flip this feature exists to make visible, and
   *    the preview would have said "no changes".
   *
   * Encounter proposals take the create path too — their payload is a generator request that is
   * re-run on approve, never a patch over a stored row.
   */
  action: ProposalEditableAction = 'update',
): string[] {
  const keys = new Set([...Object.keys(original), ...Object.keys(next)]);
  return [...keys].filter((key) => {
    if (action === 'update' && key in original && !(key in next)) return false;
    return !sameJson(original[key], next[key]);
  });
}

export interface ProposalPreviewResult {
  /** Best-effort merged object, always present — used to serialize into raw JSON on a
   *  guided-to-advanced mode switch even while some fields are still invalid. */
  draft: Record<string, unknown>;
  fieldErrors: Record<string, string>;
  formError: string | null;
  changedKeys: string[];
  /** The schema-normalized payload ready to submit, or null while any error remains. */
  normalized: Record<string, unknown> | null;
}

/** Validates an already-built data object (guided or advanced) against the schema (if
 *  known) and computes the changed-fields preview against the original payload. */
export function computeProposalPreviewFromData(
  data: Record<string, unknown>,
  originalPayload: Record<string, unknown>,
  schema: z.ZodTypeAny | null,
  /** See `diffProposalChangedKeys` — decides what an omitted key means for this payload. */
  action: ProposalEditableAction = 'update',
): ProposalPreviewResult {
  if (!schema) {
    return { draft: data, fieldErrors: {}, formError: null, changedKeys: diffProposalChangedKeys(originalPayload, data, action), normalized: data };
  }
  const validated = validateProposalPayload(schema, data);
  if (!validated.ok) {
    return {
      draft: data,
      fieldErrors: validated.fieldErrors,
      formError: validated.formError,
      changedKeys: diffProposalChangedKeys(originalPayload, data, action),
      normalized: null,
    };
  }
  // Zod 3 object parsing STRIPS keys the schema does not declare, and `validated.data` was
  // being returned as the submitted payload — so a key the proposer wrote but this shared
  // schema doesn't know about was silently deleted on approve (issue #769 review, Devin).
  //
  // That is precisely the failure the server guards against: proposal payloads are not
  // validated when filed (only on approve/revise), so a stored payload can legitimately
  // carry undeclared keys, and `proposals.service.ts` applies `.strict()` specifically
  // because "the proposal path is where silent key-stripping was WORST (an invisible drop
  // until a DM approves an emptier-than-intended entity)". Stripping them client-side
  // reintroduced exactly that, one layer up, and additionally hid it from the server's
  // strict check.
  //
  // Re-applying the validated (normalized, defaulted) values OVER the draft keeps unknown
  // keys intact so they reach the server, where a genuinely misnamed key now surfaces as a
  // visible 400 rather than vanishing.
  const normalized = { ...data, ...validated.data };
  return {
    draft: data,
    fieldErrors: {},
    formError: null,
    changedKeys: diffProposalChangedKeys(originalPayload, normalized, action),
    normalized,
  };
}

/** The guided editor's full pipeline: build the draft from field state, then validate. */
export function computeGuidedProposalPreview(
  fields: ProposalFieldDescriptor[],
  jsonKeys: string[],
  text: ProposalFieldTextState,
  bool: ProposalFieldBoolState,
  originalPayload: Record<string, unknown>,
  schema: z.ZodTypeAny | null,
  /**
   * The object the guided draft is SEEDED from — i.e. the current working payload,
   * which after a round-trip through advanced mode is what the user last typed there,
   * not the proposal as originally submitted. Defaults to `originalPayload` so every
   * existing caller and test is unchanged.
   *
   * These are two genuinely different things and conflating them lost work (issue #769
   * review, Devin): `buildProposalDraftPayload` seeds from this base, so keys the schema
   * does not declare at all are carried through from it — meaning a raw-JSON edit to an
   * unknown key was reverted, and an unknown key deleted there came back, on switching
   * to guided. `originalPayload` stays the reference for the changed-keys diff and for
   * the omit-vs-explicit presence checks, which are questions about the ORIGINAL
   * proposal and must not drift as the user edits.
   */
  passthroughBase: Record<string, unknown> = originalPayload,
  /** See `diffProposalChangedKeys` — decides what an omitted key means for this payload. */
  action: ProposalEditableAction = 'update',
): ProposalPreviewResult {
  const { data, fieldErrors } = buildProposalDraftPayload(fields, jsonKeys, text, bool, originalPayload, passthroughBase);
  if (Object.keys(fieldErrors).length > 0) {
    return { draft: data, fieldErrors, formError: null, changedKeys: diffProposalChangedKeys(originalPayload, data, action), normalized: null };
  }
  return computeProposalPreviewFromData(data, originalPayload, schema, action);
}
