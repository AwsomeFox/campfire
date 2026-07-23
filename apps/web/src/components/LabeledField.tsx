/**
 * Shared labeled form-field primitive (issue #777).
 *
 * NPC and Faction editors used to render visible labels that were not associated
 * with their controls (`<label>` without `htmlFor`, inputs without `id`/`name`).
 * This module owns the stable id/name contract, label association, help/error
 * wiring (`aria-describedby` / `aria-invalid`), and the DM-only privacy grouping
 * that distinguishes secret-field privacy from whole-entity hiding.
 *
 * Id shape: `${idPrefix}-${name}` (plus `-help` / `-error` suffixes). Prefixes
 * stay stable across proposal mode so assistive tech and tests keep the same
 * accessible names when DM-only fields are omitted.
 */
import {
  type ChangeEvent,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { GameIcon } from './GameIcon';
import { TextArea, TextInput } from './ui';

export const NPC_EDITOR_ID_PREFIX = 'npc-editor';
export const FACTION_EDITOR_ID_PREFIX = 'faction-editor';

/** Shared DM-privacy control names (entity hide vs secret-field privacy). */
export const PRIVACY_FIELD_NAMES = {
  dmSecret: 'dmSecret',
  hidden: 'hidden',
} as const;

/** Stable form `name` / id suffix values for the NPC editor. */
export const NPC_FIELD_NAMES = {
  name: 'name',
  role: 'role',
  disposition: 'disposition',
  locationId: 'locationId',
  factionId: 'factionId',
  body: 'body',
  ...PRIVACY_FIELD_NAMES,
} as const;

/** Stable form `name` / id suffix values for the Faction editor. */
export const FACTION_FIELD_NAMES = {
  name: 'name',
  kind: 'kind',
  standing: 'standing',
  reputation: 'reputation',
  body: 'body',
  goals: 'goals',
  ...PRIVACY_FIELD_NAMES,
} as const;

export type LabeledFieldIds = {
  controlId: string;
  helpId: string;
  errorId: string;
};

/** Build the stable id triple for one field under an editor prefix. */
export function labeledFieldIds(idPrefix: string, name: string): LabeledFieldIds {
  return {
    controlId: `${idPrefix}-${name}`,
    helpId: `${idPrefix}-${name}-help`,
    errorId: `${idPrefix}-${name}-error`,
  };
}

/** Uppercase field labels — slate-300 keeps WCAG AA contrast on cf-card surfaces. */
const LABEL_CLASS =
  'text-[10px] text-slate-300 font-bold uppercase tracking-wide';

type CommonProps = {
  idPrefix: string;
  /** Stable field key — used as both the control `id` suffix and the `name` attribute. */
  name: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string | null;
  disabled?: boolean;
  className?: string;
  labelClassName?: string;
  /** Extra ids to append to aria-describedby (e.g. form-level error). */
  describedBy?: string;
  style?: CSSProperties;
};

type InputFieldProps = CommonProps & {
  as?: 'input';
  type?: InputHTMLAttributes<HTMLInputElement>['type'];
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  min?: number | string;
  max?: number | string;
  autoFocus?: boolean;
  /** Optional; omitted by default so browsers can autocomplete non-sensitive fields. */
  autoComplete?: InputHTMLAttributes<HTMLInputElement>['autoComplete'];
};

type TextareaFieldProps = CommonProps & {
  as: 'textarea';
  value: string;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  minHeight?: number;
};

type SelectFieldProps = CommonProps & {
  as: 'select';
  value: string;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  children: ReactNode;
};

export type LabeledFieldProps = InputFieldProps | TextareaFieldProps | SelectFieldProps;

/** Same predicate as the help-block render — keep aria-describedby in lockstep. */
function hasHelpContent(help: ReactNode | undefined): boolean {
  return help != null && help !== false;
}

function describedByFor(ids: LabeledFieldIds, help: ReactNode | undefined, error: string | null | undefined, extra?: string) {
  return [hasHelpContent(help) ? ids.helpId : null, error ? ids.errorId : null, extra || null].filter(Boolean).join(' ') || undefined;
}

/**
 * One labeled control: associates a visible `<label htmlFor>` with a named
 * text/number/select/textarea input, and wires help + error announcements.
 */
export function LabeledField(props: LabeledFieldProps) {
  const {
    idPrefix,
    name,
    label,
    help,
    error,
    disabled,
    className = 'space-y-1',
    labelClassName = '',
    describedBy,
    style,
  } = props;
  const ids = labeledFieldIds(idPrefix, name);
  const ariaDescribedBy = describedByFor(ids, help, error, describedBy);
  const invalid = Boolean(error) || undefined;

  let control: ReactNode;
  if (props.as === 'textarea') {
    const textareaProps: TextareaHTMLAttributes<HTMLTextAreaElement> = {
      id: ids.controlId,
      name,
      value: props.value,
      onChange: props.onChange,
      placeholder: props.placeholder,
      disabled,
      'aria-invalid': invalid,
      'aria-describedby': ariaDescribedBy,
      style: { minHeight: props.minHeight ?? 140, ...style },
    };
    control = <TextArea {...textareaProps} />;
  } else if (props.as === 'select') {
    const selectProps: SelectHTMLAttributes<HTMLSelectElement> = {
      id: ids.controlId,
      name,
      className: 'cf-select',
      value: props.value,
      onChange: props.onChange,
      disabled,
      'aria-invalid': invalid,
      'aria-describedby': ariaDescribedBy,
      style,
    };
    control = <select {...selectProps}>{props.children}</select>;
  } else {
    const inputProps: InputHTMLAttributes<HTMLInputElement> = {
      id: ids.controlId,
      name,
      type: props.type ?? 'text',
      value: props.value,
      onChange: props.onChange,
      placeholder: props.placeholder,
      disabled,
      min: props.min,
      max: props.max,
      autoFocus: props.autoFocus,
      'aria-invalid': invalid,
      'aria-describedby': ariaDescribedBy,
      style,
      ...(props.autoComplete != null ? { autoComplete: props.autoComplete } : {}),
    };
    control = <TextInput {...inputProps} />;
  }

  return (
    <div className={className}>
      <label htmlFor={ids.controlId} className={`${LABEL_CLASS} ${labelClassName}`.trim()}>
        {label}
      </label>
      {control}
      {hasHelpContent(help) && (
        <p id={ids.helpId} className="m-0 text-xs text-slate-400">
          {help}
        </p>
      )}
      {error ? (
        <p id={ids.errorId} role="alert" className="m-0 text-xs text-rose-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export type DmPrivacyGroupProps = {
  idPrefix: string;
  /** Singular entity noun used in copy, e.g. "NPC" or "faction". */
  entityLabel: string;
  dmSecret: string;
  onDmSecretChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  hidden: boolean;
  onHiddenChange: (event: ChangeEvent<HTMLInputElement>) => void;
  dmSecretError?: string | null;
  hiddenError?: string | null;
  disabled?: boolean;
  describedBy?: string;
};

/**
 * Semantically grouped DM-only privacy controls.
 *
 * Distinguishes (1) secret-field privacy — markdown only the DM reads — from
 * (2) entity hiding — the whole record is withheld from players.
 */
export function DmPrivacyGroup({
  idPrefix,
  entityLabel,
  dmSecret,
  onDmSecretChange,
  hidden,
  onHiddenChange,
  dmSecretError,
  hiddenError,
  disabled,
  describedBy,
}: DmPrivacyGroupProps) {
  const legendId = `${idPrefix}-dm-privacy-legend`;
  const helpId = `${idPrefix}-dm-privacy-help`;
  const hiddenIds = labeledFieldIds(idPrefix, PRIVACY_FIELD_NAMES.hidden);
  const groupDescribedBy = [helpId, describedBy].filter(Boolean).join(' ') || undefined;
  const hiddenDescribedBy = [helpId, hiddenError ? hiddenIds.errorId : null, describedBy]
    .filter(Boolean)
    .join(' ') || undefined;

  return (
    <fieldset
      className="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-divider)] px-3 py-3"
      aria-labelledby={legendId}
      aria-describedby={groupDescribedBy}
    >
      <legend id={legendId} className="text-[10px] text-amber-400 font-bold uppercase tracking-wide px-1">
        <span className="inline-flex items-center gap-1">
          <GameIcon slug="padlock" size={11} /> DM-only privacy
        </span>
      </legend>
      <p id={helpId} className="m-0 text-xs text-slate-300">
        The DM secret is private field content never shown to players. Hiding the {entityLabel} conceals
        the whole entity from players — not just the secret.
      </p>
      <LabeledField
        idPrefix={idPrefix}
        name={PRIVACY_FIELD_NAMES.dmSecret}
        as="textarea"
        label="DM secret"
        labelClassName="!text-amber-400"
        value={dmSecret}
        onChange={onDmSecretChange}
        minHeight={90}
        help="Secret-field privacy: stays on this record for DMs only."
        error={dmSecretError}
        disabled={disabled}
        describedBy={describedBy}
      />
      <div className="space-y-1">
        <label
          htmlFor={hiddenIds.controlId}
          className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none"
        >
          <input
            id={hiddenIds.controlId}
            name={PRIVACY_FIELD_NAMES.hidden}
            type="checkbox"
            checked={hidden}
            onChange={onHiddenChange}
            disabled={disabled}
            aria-invalid={hiddenError ? true : undefined}
            aria-describedby={hiddenDescribedBy}
          />
          <span className="inline-flex items-center gap-1">
            <GameIcon slug="sight-disabled" size={12} /> Hidden from players (whole {entityLabel}, not just the
            secret)
          </span>
        </label>
        {hiddenError ? (
          <p id={hiddenIds.errorId} role="alert" className="m-0 text-xs text-rose-400">
            {hiddenError}
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}
