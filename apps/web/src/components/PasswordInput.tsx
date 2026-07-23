/**
 * Shared password field with an accessible Show/Hide control (issue #868).
 *
 * Password-manager-safe: one persistent <input>, autocomplete/name/id preserved,
 * type toggled between password and text. Reveal is off by default and resets
 * on navigation. Selection, cursor, and focus are restored across the toggle.
 */
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type MutableRefObject,
  type Ref,
} from 'react';
import { useLocation } from 'react-router-dom';

export type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /**
   * Noun used in the toggle’s accessible name. Defaults to "password" so the
   * control reads as the explicit “Show password” / “Hide password” pair.
   */
  revealNoun?: string;
};

/** Accessible name for the reveal toggle (issue #868 acceptance copy). */
export function passwordRevealLabel(revealed: boolean, noun = 'password'): string {
  return revealed ? `Hide ${noun}` : `Show ${noun}`;
}

/** Input type for the current reveal state. */
export function passwordInputType(revealed: boolean): 'password' | 'text' {
  return revealed ? 'text' : 'password';
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === 'function') ref(value);
  else (ref as MutableRefObject<T | null>).current = value;
}

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput(
    { className = '', revealNoun = 'password', disabled, id, onChange, ...rest },
    ref,
  ) {
    const location = useLocation();
    const [revealed, setRevealed] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const pendingSelection = useRef<{ start: number; end: number; focusInput: boolean } | null>(null);
    const toggleId = id ? `${id}-reveal` : undefined;

    // Reveal stays off after route changes (including history stack moves).
    useEffect(() => {
      setRevealed(false);
    }, [location.key]);

    useLayoutEffect(() => {
      const pending = pendingSelection.current;
      if (!pending) return;
      pendingSelection.current = null;
      const el = inputRef.current;
      if (!el) return;
      if (pending.focusInput) el.focus();
      try {
        el.setSelectionRange(pending.start, pending.end);
      } catch {
        // Some engines reject setSelectionRange while type=password; ignore.
      }
    }, [revealed]);

    function toggleReveal(returnFocusToInput: boolean) {
      const el = inputRef.current;
      if (el) {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        // Mouse clicks return focus to the field for continued typing. Keyboard
        // activation (click.detail === 0) leaves focus on the toggle so the
        // updated Show/Hide name can be announced and toggled again.
        pendingSelection.current = { start, end, focusInput: returnFocusToInput };
      }
      setRevealed((value) => !value);
    }

    return (
      <div className="password-input">
        <input
          {...rest}
          id={id}
          ref={(node) => {
            inputRef.current = node;
            assignRef(ref, node);
          }}
          type={passwordInputType(revealed)}
          className={`password-input__control ${className}`.trim()}
          disabled={disabled}
          onChange={onChange}
          spellCheck={revealed ? rest.spellCheck : false}
        />
        <button
          id={toggleId}
          type="button"
          className="password-input__toggle"
          aria-label={passwordRevealLabel(revealed, revealNoun)}
          aria-controls={id || undefined}
          aria-pressed={revealed}
          disabled={disabled}
          onClick={(event) => toggleReveal(event.detail > 0)}
        >
          <span aria-hidden="true">{revealed ? 'Hide' : 'Show'}</span>
        </button>
      </div>
    );
  },
);
