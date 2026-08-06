/**
 * Schema-driven proposal payload editor (issue #769).
 *
 * Replaces the bare, unlabeled JSON textarea that both `ProposalCard` (DM edit-before-
 * approve) and `MyProposalCard` (proposer revise) used to render inline. For a known
 * proposal entity type this shows one labeled control per top-level scalar/enum field
 * (`describeProposalFields`), with its own persistent help text and, on a failed
 * submit, an associated error announced via `aria-describedby`/`role="alert"` and
 * focused directly. Anything the guided walker can't render as a simple control
 * (arrays/objects/records) still gets its own labeled JSON box rather than one
 * undifferentiated blob. "Advanced: edit raw JSON" is always one click away and is the
 * only mode for an entity type this module doesn't recognize (`schemaForProposal` ->
 * null). A preview panel shows the normalized result and exactly which top-level
 * fields changed vs. the original proposal (`computeProposalPreviewFromData`).
 *
 * State lives entirely in this component and is never cleared on a validation or
 * network failure — the parent only unmounts it by leaving edit mode (Cancel) or by
 * the proposal itself leaving the pending list (a successful resolve).
 */
import { forwardRef, useImperativeHandle, useMemo, useState } from 'react';
import { TextArea, TextInput } from '../../components/ui';
import {
  buildProposalDraftPayload,
  computeGuidedProposalPreview,
  computeProposalPreviewFromData,
  humanizeFieldKey,
  describeProposalFields,
  initProposalFieldBool,
  initProposalFieldText,
  jsonFieldKeys,
  jsonFieldMeta,
  schemaForProposal,
  type ProposalEditableAction,
  type ProposalEntityType,
  type ProposalFieldDescriptor,
  type ProposalPreviewResult,
} from './proposalPayloadForm';

export interface ProposalPayloadEditorHandle {
  /** Validates the current draft. Returns the normalized payload to submit, or `null`
   *  after surfacing and focusing the first invalid control. */
  submit(): Record<string, unknown> | null;
}

export interface ProposalPayloadEditorProps {
  /** Unique per-instance id root (e.g. `proposal-123`) so multiple cards on one page
   *  never collide on field ids. */
  idPrefix: string;
  entityType: ProposalEntityType;
  action: ProposalEditableAction;
  originalPayload: Record<string, unknown>;
}

function fieldId(prefix: string, key: string): string {
  return `${prefix}-field-${key}`;
}
function fieldHelpId(prefix: string, key: string): string {
  return `${fieldId(prefix, key)}-help`;
}
function fieldErrorId(prefix: string, key: string): string {
  return `${fieldId(prefix, key)}-error`;
}
function rawJsonId(prefix: string): string {
  return `${prefix}-raw-json`;
}

function parseJsonObject(raw: string): { ok: true; data: Record<string, unknown> } | { ok: false; message: string } {
  // An emptied box is an ERROR, not `{}` (review). The editor this replaces called
  // `JSON.parse(draft)` directly, so a wiped textarea threw and surfaced "Invalid JSON",
  // blocking the approve. Mapping '' to `{}` removed that guardrail: `{}` validates cleanly
  // against every `*Update` schema (all fields optional), and under update omission semantics
  // the preview then reports "no changes from the current proposal" — for a payload that
  // dropped every field. A DM who cleared the box by accident got no warning at all.
  if (raw.trim() === '') return { ok: false, message: 'The payload must be a JSON object.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? `Invalid JSON: ${err.message}` : 'Invalid JSON.' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'The payload must be a JSON object.' };
  }
  return { ok: true, data: parsed as Record<string, unknown> };
}

export const ProposalPayloadEditor = forwardRef<ProposalPayloadEditorHandle, ProposalPayloadEditorProps>(
  function ProposalPayloadEditor({ idPrefix, entityType, action, originalPayload }, ref) {
    const schema = useMemo(() => schemaForProposal(entityType, action), [entityType, action]);
    const fields = useMemo(() => (schema ? describeProposalFields(schema) : []), [schema]);
    const jsonKeys = useMemo(() => (schema ? jsonFieldKeys(schema) : []), [schema]);

    const [mode, setMode] = useState<'guided' | 'advanced'>(schema ? 'guided' : 'advanced');
    const [text, setText] = useState(() => initProposalFieldText(fields, jsonKeys, originalPayload));
    const [bool, setBool] = useState(() => initProposalFieldBool(fields, originalPayload));
    const [rawText, setRawText] = useState(() => JSON.stringify(originalPayload, null, 2));
    const [modeSwitchError, setModeSwitchError] = useState<string | null>(null);
    // Only surface field-level errors after a failed submit attempt — matches the
    // codebase's on-submit validation convention (see QuestPage's title error).
    const [showErrors, setShowErrors] = useState(false);

    // The working payload the guided draft is seeded from. Starts as the proposal as
    // submitted, and is replaced by whatever the user last had in advanced mode on a
    // successful switch back — otherwise a raw-JSON edit to a key the schema does not
    // declare was silently reverted (issue #769 review, Devin). `originalPayload` remains
    // the reference for the diff and the presence checks.
    const [passthroughBase, setPassthroughBase] = useState<Record<string, unknown>>(originalPayload);

    const guidedPreview = useMemo(
      () => computeGuidedProposalPreview(fields, jsonKeys, text, bool, originalPayload, schema, passthroughBase),
      [fields, jsonKeys, text, bool, originalPayload, schema, passthroughBase],
    );

    const advancedPreview = useMemo<ProposalPreviewResult>(() => {
      const parsed = parseJsonObject(rawText);
      if (!parsed.ok) {
        return { draft: originalPayload, fieldErrors: {}, formError: parsed.message, changedKeys: [], normalized: null };
      }
      return computeProposalPreviewFromData(parsed.data, originalPayload, schema);
    }, [rawText, originalPayload, schema]);

    const preview = mode === 'guided' ? guidedPreview : advancedPreview;

    function switchToAdvanced() {
      // Refuse the switch when the draft does NOT hold what the reviewer typed (review).
      //
      // `buildProposalDraftPayload` seeds `data` from the working payload and then overwrites
      // each key from the controls. When a control cannot produce a value it records an error
      // and leaves the SEEDED value in place — an emptied required field, a number box holding
      // non-numeric text, a JSON box that fails to parse. Serializing that draft into raw mode
      // therefore writes the ORIGINAL value back over what was typed, and switching back
      // re-seeds guided state from it, so the edit is gone from both modes with nothing said.
      //
      // Its build-stage `fieldErrors` are exactly that set, which makes them the right
      // predicate — narrower than "any error" and broader than "bad JSON". A scalar that is
      // merely SCHEMA-invalid (too long, out of enum) still had its typed value written, so
      // the switch is lossless there and stays allowed: raw mode is often how someone fixes
      // one. An earlier version of this guard tested only JSON.parse and its comment claimed
      // the draft always held the typed text for everything else — it does not.
      //
      // Showing the error matters as much as refusing: field errors are gated on
      // `showErrors`, which only flips on a failed submit, so before any submit this named a
      // field whose own message was not rendered.
      const build = buildProposalDraftPayload(fields, jsonKeys, text, bool, originalPayload, passthroughBase);
      const unrepresentedKey = Object.keys(build.fieldErrors)[0];
      if (unrepresentedKey) {
        setShowErrors(true);
        setModeSwitchError(`Fix ${humanizeFieldKey(unrepresentedKey)} before switching to raw JSON.`);
        return;
      }
      setRawText(JSON.stringify(guidedPreview.draft, null, 2));
      setModeSwitchError(null);
      setMode('advanced');
    }

    function switchToGuided() {
      const parsed = parseJsonObject(rawText);
      if (!parsed.ok) {
        // Preserve the raw draft — do not lose it just because switching modes failed.
        setModeSwitchError('Fix the JSON before switching to the guided editor.');
        return;
      }
      setText(initProposalFieldText(fields, jsonKeys, parsed.data));
      setBool(initProposalFieldBool(fields, parsed.data));
      // Carry the raw-mode object forward as the passthrough seed, so keys the schema
      // does not declare reflect what the user just typed rather than snapping back to
      // the original proposal (issue #769 review, Devin).
      setPassthroughBase(parsed.data);
      setModeSwitchError(null);
      setMode('guided');
    }

    useImperativeHandle(
      ref,
      () => ({
        submit() {
          if (preview.normalized) return preview.normalized;
          setShowErrors(true);
          if (mode === 'guided') {
            const firstInvalidKey = [...fields.map((f) => f.key), ...jsonKeys].find((key) => preview.fieldErrors[key]);
            if (firstInvalidKey) document.getElementById(fieldId(idPrefix, firstInvalidKey))?.focus();
          } else {
            document.getElementById(rawJsonId(idPrefix))?.focus();
          }
          return null;
        },
      }),
      [preview, mode, fields, jsonKeys, idPrefix],
    );

    function renderScalarField(f: ProposalFieldDescriptor) {
      const id = fieldId(idPrefix, f.key);
      const helpId = fieldHelpId(idPrefix, f.key);
      const errorId = fieldErrorId(idPrefix, f.key);
      const error = showErrors ? preview.fieldErrors[f.key] : undefined;
      const describedBy = [helpId, error ? errorId : null].filter(Boolean).join(' ');

      if (f.kind === 'boolean') {
        // A three-option select, not a checkbox (issue #769 review, Devin). A checkbox has two
        // states and this field has three: set true, set false, and NOT SET. They are not
        // interchangeable — `resolveCreateHidden` (#754) reads an omitted `hidden` on a create
        // as DM-only and an explicit `false` as public. Rendered as a checkbox, an omitted
        // `hidden` drew UNCHECKED, telling the reviewer the entity would be visible to players
        // when approving would create it DM-only, and there was no way to say "explicitly
        // public" at all without dropping to raw JSON.
        const current = bool[f.key];
        const value = current === undefined ? '' : current ? 'true' : 'false';
        return (
          <div key={f.key} className="space-y-1">
            <label htmlFor={id} className="text-[11px] font-semibold text-secondary">{f.label}</label>
            <select
              id={id}
              className="cf-select"
              value={value}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              onChange={(e) =>
                setBool((cur) => ({
                  ...cur,
                  [f.key]: e.target.value === '' ? undefined : e.target.value === 'true',
                }))
              }
            >
              <option value="">Not set — the server's default applies</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
            <p id={helpId} className="text-[10px] text-secondary m-0">{f.help}</p>
            {error && (
              <p id={errorId} role="alert" className="text-[11px] text-rose-400 m-0">{error}</p>
            )}
          </div>
        );
      }

      if (f.kind === 'select') {
        return (
          <div key={f.key} className="space-y-1">
            <label htmlFor={id} className="text-[11px] font-semibold text-secondary">{f.label}</label>
            <select
              id={id}
              className="cf-select"
              value={text[f.key] ?? ''}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              onChange={(e) => setText((cur) => ({ ...cur, [f.key]: e.target.value }))}
            >
              <option value="">{f.nullable || f.optional ? '(none)' : 'Choose…'}</option>
              {(f.options ?? []).map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
            <p id={helpId} className="text-[10px] text-secondary m-0">{f.help}</p>
            {error && (
              <p id={errorId} role="alert" className="text-[11px] text-rose-400 m-0">{error}</p>
            )}
          </div>
        );
      }

      if (f.kind === 'textarea') {
        return (
          <div key={f.key} className="space-y-1">
            <label htmlFor={id} className="text-[11px] font-semibold text-secondary">{f.label}</label>
            <TextArea
              id={id}
              style={{ minHeight: 90 }}
              value={text[f.key] ?? ''}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              onChange={(e) => setText((cur) => ({ ...cur, [f.key]: e.target.value }))}
            />
            <p id={helpId} className="text-[10px] text-secondary m-0">{f.help}</p>
            {error && (
              <p id={errorId} role="alert" className="text-[11px] text-rose-400 m-0">{error}</p>
            )}
          </div>
        );
      }

      return (
        <div key={f.key} className="space-y-1">
          <label htmlFor={id} className="text-[11px] font-semibold text-secondary">{f.label}</label>
          <TextInput
            id={id}
            type={f.kind === 'number' ? 'number' : 'text'}
            value={text[f.key] ?? ''}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(e) => setText((cur) => ({ ...cur, [f.key]: e.target.value }))}
          />
          <p id={helpId} className="text-[10px] text-secondary m-0">{f.help}</p>
          {error && (
            <p id={errorId} role="alert" className="text-[11px] text-rose-400 m-0">{error}</p>
          )}
        </div>
      );
    }

    function renderJsonField(key: string) {
      if (!schema) return null;
      const meta = jsonFieldMeta(key, schema);
      const id = fieldId(idPrefix, key);
      const helpId = fieldHelpId(idPrefix, key);
      const errorId = fieldErrorId(idPrefix, key);
      const error = showErrors ? preview.fieldErrors[key] : undefined;
      const describedBy = [helpId, error ? errorId : null].filter(Boolean).join(' ');
      return (
        <div key={key} className="space-y-1">
          <label htmlFor={id} className="text-[11px] font-semibold text-secondary">{meta.label} (JSON)</label>
          <TextArea
            id={id}
            className="font-mono"
            style={{ minHeight: 80, fontSize: 12 }}
            value={text[key] ?? ''}
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(e) => setText((cur) => ({ ...cur, [key]: e.target.value }))}
          />
          <p id={helpId} className="text-[10px] text-secondary m-0">
            {meta.optional || meta.nullable ? 'Optional.' : 'Required.'} Structured value — edit as JSON.
          </p>
          {error && (
            <p id={errorId} role="alert" className="text-[11px] text-rose-400 m-0">{error}</p>
          )}
        </div>
      );
    }

    const rawErrorText = preview.formError
      ?? (Object.keys(preview.fieldErrors).length > 0
        ? Object.entries(preview.fieldErrors).map(([key, message]) => `${key}: ${message}`).join(' ')
        : null);

    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-bold text-secondary uppercase tracking-wide m-0">Edit proposed payload</p>
          {schema && (
            <button
              type="button"
              className="text-[11px] text-secondary hover:text-white underline"
              onClick={() => (mode === 'guided' ? switchToAdvanced() : switchToGuided())}
            >
              {mode === 'guided' ? 'Advanced: edit raw JSON' : 'Back to guided editor'}
            </button>
          )}
        </div>
        {modeSwitchError && (
          <p role="alert" className="text-[11px] text-rose-400 m-0">{modeSwitchError}</p>
        )}

        {mode === 'guided' ? (
          <div className="space-y-2">
            {fields.map(renderScalarField)}
            {jsonKeys.map(renderJsonField)}
          </div>
        ) : (
          <div className="space-y-1">
            <label htmlFor={rawJsonId(idPrefix)} className="text-[11px] font-semibold text-secondary">
              Raw JSON payload
            </label>
            <TextArea
              id={rawJsonId(idPrefix)}
              className="font-mono"
              style={{ minHeight: 140, fontSize: 12 }}
              value={rawText}
              spellCheck={false}
              aria-invalid={showErrors && rawErrorText ? true : undefined}
              aria-describedby={[`${rawJsonId(idPrefix)}-help`, showErrors && rawErrorText ? `${rawJsonId(idPrefix)}-error` : null]
                .filter(Boolean)
                .join(' ')}
              onChange={(e) => setRawText(e.target.value)}
            />
            <p id={`${rawJsonId(idPrefix)}-help`} className="text-[10px] text-secondary m-0">
              Advanced mode — edit the full proposed payload as JSON.
            </p>
            {showErrors && rawErrorText && (
              <p id={`${rawJsonId(idPrefix)}-error`} role="alert" className="text-[11px] text-rose-400 m-0">
                {rawErrorText}
              </p>
            )}
          </div>
        )}

        <ProposalPreviewPanel preview={preview} originalPayload={originalPayload} />
      </div>
    );
  },
);

function ProposalPreviewPanel({
  preview,
  originalPayload,
}: {
  preview: ProposalPreviewResult;
  originalPayload: Record<string, unknown>;
}) {
  if (preview.normalized) {
    if (preview.changedKeys.length === 0) {
      return <p className="text-[11px] text-secondary m-0">Preview: no changes from the current proposal.</p>;
    }
    return (
      <div className="border border-[var(--color-divider)] rounded-[var(--radius-md)] overflow-hidden">
        <div className="px-3 py-1.5 text-[11px] text-secondary border-b border-[var(--color-divider)]">
          Preview — {preview.changedKeys.length} changed field{preview.changedKeys.length === 1 ? '' : 's'}
        </div>
        {preview.changedKeys.map((key, i) => (
          <div
            key={key}
            className="flex gap-2.5 px-3 py-2 text-[12.5px] items-baseline"
            style={i > 0 ? { borderTop: '1px solid var(--color-divider)' } : undefined}
          >
            <span className="text-muted w-[86px] shrink-0 text-[11px]">{key}</span>
            {key in originalPayload && (
              <span className="line-through text-secondary whitespace-pre-wrap break-all shrink-0 max-w-[45%]">
                {formatPreviewValue(originalPayload[key])}
              </span>
            )}
            <span style={{ color: 'var(--color-accent-300)' }} className="whitespace-pre-wrap break-all">
              {/*
                "not sent" and "cleared" are DIFFERENT outcomes and must not render alike
                (review). `formatPreviewValue` maps both `null` and `undefined` to `—`, so a key
                the payload omits looked exactly like one being cleared to null — the former
                leaves the stored column alone (and, on an update, silently drops the change the
                proposer asked for), the latter wipes it. Saying "not sent" is what lets a DM see
                that clearing a select or a JSON box removed a proposed change rather than
                applying one.
              */}
              → {preview.normalized && key in preview.normalized ? formatPreviewValue(preview.normalized[key]) : 'not sent'}
            </span>
          </div>
        ))}
      </div>
    );
  }
  const count = Object.keys(preview.fieldErrors).length;
  return (
    <p className="text-[11px] text-secondary m-0">
      {preview.formError
        ? `Preview unavailable: ${preview.formError}`
        : count > 0
          ? `Preview unavailable — fix ${count} field${count === 1 ? '' : 's'} above.`
          : 'Preview unavailable.'}
    </p>
  );
}

function formatPreviewValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
