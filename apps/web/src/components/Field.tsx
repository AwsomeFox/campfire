/**
 * Shared labeled form-field primitive (issue #886).
 *
 * Authoring and composer surfaces historically mixed placeholder-only inputs,
 * wrapping `<label>`s without `htmlFor`, and ad-hoc help/error markup. This
 * module owns one contract for every remaining core field:
 *
 *   - Stable control ids: `${idPrefix}-${name}` (+ `-help` / `-error`)
 *   - Visible `<label htmlFor>` association (not placeholder-as-name)
 *   - Help + error wired through `aria-describedby` / `aria-invalid`
 *   - Required / optional state exposed in the label for AT + speech input
 *   - `useId()` fallback when a caller omits `idPrefix` (multi-mount safe)
 *
 * Prefer an explicit `idPrefix` in tests and durable editors so locators stay
 * stable across remounts. File inputs always pair with purpose/format help.
 */
import {
  useId,
  type ChangeEvent,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEventHandler,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { TextArea, TextInput } from './ui';

export type FieldIds = {
  controlId: string;
  helpId: string;
  errorId: string;
};

/** Build the stable id triple for one field under a prefix. */
export function fieldIds(idPrefix: string, name: string): FieldIds {
  return {
    controlId: `${idPrefix}-${name}`,
    helpId: `${idPrefix}-${name}-help`,
    errorId: `${idPrefix}-${name}-error`,
  };
}

/** Sanitize React `useId()` (e.g. `:r1:`) into a CSS-safe prefix fragment. */
export function sanitizeFieldPrefix(reactId: string): string {
  return reactId.replace(/:/g, '');
}

/**
 * Resolve the id prefix: explicit `idPrefix` wins; otherwise a mount-local
 * `useId()` value so multiple Field instances never collide.
 */
export function useFieldPrefix(idPrefix?: string): string {
  const reactId = useId();
  return idPrefix ?? sanitizeFieldPrefix(reactId);
}

/** Visible + AT required marker for labels. */
export function RequiredMarker() {
  return (
    <>
      {' '}
      <span aria-hidden="true" style={{ color: 'var(--color-danger, #f87171)' }}>
        *
      </span>
      <span className="sr-only">(required)</span>
    </>
  );
}

/** Visible optional hint when the control is clearly non-required. */
export function OptionalMarker() {
  return <span className="text-muted font-normal normal-case tracking-normal"> (optional)</span>;
}

/** Same predicate as the help-block render — keep aria-describedby in lockstep. */
function hasHelpContent(help: ReactNode | undefined): boolean {
  return help != null && help !== false && help !== '';
}

export function describedByFor(
  ids: FieldIds,
  help: ReactNode | undefined,
  error: string | null | undefined,
  extra?: string,
): string | undefined {
  return [hasHelpContent(help) ? ids.helpId : null, error ? ids.errorId : null, extra || null]
    .filter(Boolean)
    .join(' ') || undefined;
}

type CommonProps = {
  /** Stable editor prefix. Omit to allocate a mount-local id via useId(). */
  idPrefix?: string;
  /** Stable field key — used as both the control `id` suffix and the `name` attribute. */
  name: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string | null;
  disabled?: boolean;
  required?: boolean;
  /** When true, append an "(optional)" hint to the visible label. */
  optional?: boolean;
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
  step?: number | string;
  inputMode?: InputHTMLAttributes<HTMLInputElement>['inputMode'];
  maxLength?: number;
  autoFocus?: boolean;
  autoComplete?: InputHTMLAttributes<HTMLInputElement>['autoComplete'];
  title?: string;
  list?: string;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  /** Composition-safe submit gates (IME confirm ≠ submit). */
  onCompositionStart?: InputHTMLAttributes<HTMLInputElement>['onCompositionStart'];
  onCompositionEnd?: InputHTMLAttributes<HTMLInputElement>['onCompositionEnd'];
};

type TextareaFieldProps = CommonProps & {
  as: 'textarea';
  value: string;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  minHeight?: number;
  rows?: number;
  maxLength?: number;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
};

type SelectFieldProps = CommonProps & {
  as: 'select';
  value: string;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  children: ReactNode;
  selectClassName?: string;
};

type FileFieldProps = CommonProps & {
  as: 'file';
  accept?: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  /** Purpose + accepted formats — required for file fields (issue #886). */
  help: ReactNode;
};

export type FieldProps = InputFieldProps | TextareaFieldProps | SelectFieldProps | FileFieldProps;

const DEFAULT_LABEL_CLASS = '';

/**
 * One labeled control: associates a visible `<label htmlFor>` with a named
 * text/number/select/textarea/file input, and wires help + error announcements.
 */
export function Field(props: FieldProps) {
  const {
    idPrefix: idPrefixProp,
    name,
    label,
    help,
    error,
    disabled,
    required,
    optional,
    className = 'field',
    labelClassName = DEFAULT_LABEL_CLASS,
    describedBy,
    style,
  } = props;
  const idPrefix = useFieldPrefix(idPrefixProp);
  const ids = fieldIds(idPrefix, name);
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
      required,
      onKeyDown: props.onKeyDown,
      'aria-required': required || undefined,
      'aria-invalid': invalid,
      'aria-describedby': ariaDescribedBy,
      rows: props.rows,
      maxLength: props.maxLength,
      style: { minHeight: props.minHeight ?? 90, ...style },
    };
    control = <TextArea {...textareaProps} />;
  } else if (props.as === 'select') {
    const selectProps: SelectHTMLAttributes<HTMLSelectElement> = {
      id: ids.controlId,
      name,
      className: props.selectClassName ?? 'cf-select w-full',
      value: props.value,
      onChange: props.onChange,
      disabled,
      required,
      'aria-required': required || undefined,
      'aria-invalid': invalid,
      'aria-describedby': ariaDescribedBy,
      style,
    };
    control = <select {...selectProps}>{props.children}</select>;
  } else if (props.as === 'file') {
    control = (
      <input
        id={ids.controlId}
        name={name}
        type="file"
        accept={props.accept}
        onChange={props.onChange}
        disabled={disabled}
        required={required}
        aria-required={required || undefined}
        aria-invalid={invalid}
        aria-describedby={ariaDescribedBy}
        style={{ fontSize: 11, ...style }}
      />
    );
  } else {
    const inputProps: InputHTMLAttributes<HTMLInputElement> = {
      id: ids.controlId,
      name,
      type: props.type ?? 'text',
      value: props.value,
      onChange: props.onChange,
      placeholder: props.placeholder,
      disabled,
      required,
      min: props.min,
      max: props.max,
      step: props.step,
      inputMode: props.inputMode,
      maxLength: props.maxLength,
      autoFocus: props.autoFocus,
      title: props.title,
      list: props.list,
      onKeyDown: props.onKeyDown,
      onCompositionStart: props.onCompositionStart,
      onCompositionEnd: props.onCompositionEnd,
      'aria-required': required || undefined,
      'aria-invalid': invalid,
      'aria-describedby': ariaDescribedBy,
      style,
      ...(props.autoComplete != null ? { autoComplete: props.autoComplete } : {}),
    };
    control = <TextInput {...inputProps} />;
  }

  return (
    <div className={className}>
      <label htmlFor={ids.controlId} className={labelClassName || undefined}>
        {label}
        {required ? <RequiredMarker /> : null}
        {!required && optional ? <OptionalMarker /> : null}
      </label>
      {control}
      {hasHelpContent(help) && (
        <p id={ids.helpId} className="m-0 text-xs text-slate-400" style={{ marginTop: 4 }}>
          {help}
        </p>
      )}
      {error ? (
        <p id={ids.errorId} role="alert" className="m-0 text-xs text-rose-400" style={{ marginTop: 4 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
