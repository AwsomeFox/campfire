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
  CampaignCreate,
  CampaignUpdate,
  CharacterCreate,
  CharacterUpdate,
  EncounterCreate,
  EncounterUpdate,
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
  campaign: { create: CampaignCreate, update: CampaignUpdate },
  encounter: { create: EncounterCreate, update: EncounterUpdate },
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
export type ProposalFieldBoolState = Record<string, boolean>;

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
    bool[f.key] = Boolean(payload[f.key]);
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
): void {
  if (raw === '') {
    if (f.nullable) data[f.key] = null;
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
): ProposalDraftBuild {
  const data: Record<string, unknown> = { ...originalPayload };
  const fieldErrors: Record<string, string> = {};

  for (const f of fields) {
    if (f.kind === 'boolean') {
      const checked = bool[f.key] ?? false;
      // "Omit != false" is a real, documented server invariant for optional booleans
      // with no Zod default (e.g. `hidden` — issue #754's `resolveCreateHidden`: an
      // omitted `hidden` defaults to DM-only, while an explicit `false` makes a create
      // public). An untouched checkbox for a key absent from the original payload must
      // therefore stay OMITTED, not be coerced to an explicit `false` just because a
      // checkbox always renders some boolean. Checking it True, or a key that was
      // already explicitly present (any value), is always sent explicitly.
      if (!checked && f.optional && !(f.key in originalPayload)) {
        delete data[f.key];
      } else {
        data[f.key] = checked;
      }
      continue;
    }
    applyScalarField(f, text[f.key] ?? '', data, fieldErrors);
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
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Top-level keys whose value differs (structurally) between the original proposal
 *  payload and a candidate next payload — drives the preview's changed-fields list. */
export function diffProposalChangedKeys(original: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(original), ...Object.keys(next)]);
  return [...keys].filter((key) => !sameJson(original[key], next[key]));
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
): ProposalPreviewResult {
  if (!schema) {
    return { draft: data, fieldErrors: {}, formError: null, changedKeys: diffProposalChangedKeys(originalPayload, data), normalized: data };
  }
  const validated = validateProposalPayload(schema, data);
  if (!validated.ok) {
    return {
      draft: data,
      fieldErrors: validated.fieldErrors,
      formError: validated.formError,
      changedKeys: diffProposalChangedKeys(originalPayload, data),
      normalized: null,
    };
  }
  return {
    draft: data,
    fieldErrors: {},
    formError: null,
    changedKeys: diffProposalChangedKeys(originalPayload, validated.data),
    normalized: validated.data,
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
): ProposalPreviewResult {
  const { data, fieldErrors } = buildProposalDraftPayload(fields, jsonKeys, text, bool, originalPayload);
  if (Object.keys(fieldErrors).length > 0) {
    return { draft: data, fieldErrors, formError: null, changedKeys: diffProposalChangedKeys(originalPayload, data), normalized: null };
  }
  return computeProposalPreviewFromData(data, originalPayload, schema);
}
