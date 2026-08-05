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
  computeGuidedProposalPreview,
  computeProposalPreviewFromData,
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
  let parsed: unknown;
  try {
    parsed = raw.trim() === '' ? {} : JSON.parse(raw);
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

    const guidedPreview = useMemo(
      () => computeGuidedProposalPreview(fields, jsonKeys, text, bool, originalPayload, schema),
      [fields, jsonKeys, text, bool, originalPayload, schema],
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
        return (
          <div key={f.key} className="space-y-1">
            <label htmlFor={id} className="text-[11px] font-semibold text-secondary inline-flex items-center gap-1.5 cursor-pointer">
              <input
                id={id}
                type="checkbox"
                checked={bool[f.key] ?? false}
                aria-describedby={describedBy}
                onChange={(e) => setBool((cur) => ({ ...cur, [f.key]: e.target.checked }))}
              />
              {f.label}
            </label>
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
              → {formatPreviewValue(preview.normalized ? preview.normalized[key] : undefined)}
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
