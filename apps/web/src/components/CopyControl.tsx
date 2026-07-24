/**
 * Shared Copy control (issue #796).
 *
 * One button every surface can reuse:
 *   - capability-detects before claiming success
 *   - marks success only after `writeText` resolves
 *   - on failure selects the adjacent text and announces manual-copy guidance
 *   - consistently resets "Copied!" / failure feedback after {@link COPY_FEEDBACK_MS}
 *   - clears feedback when the copied `text` changes (stale "Copied" after URL swap)
 *
 * Pure write / feedback logic lives in `clipboardCopy.ts`; this component owns
 * the React timer, announcer, and DOM selection side effects.
 */
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type RefObject,
} from 'react';
import { useAnnounce } from './Announcer';
import { Btn } from './ui';
import {
  COPY_FEEDBACK_MS,
  DEFAULT_COPY_FAILURE,
  DEFAULT_COPY_SUCCESS,
  initialCopyFeedback,
  reduceCopyFeedback,
  resolveSelectTarget,
  selectElementText,
  writeClipboardText,
  type CopyFeedbackSnapshot,
  type CopyOutcome,
} from './clipboardCopy';

type CopyControlProps = {
  /** Exact string written to the clipboard on click. */
  text: string;
  /** Idle button label. */
  label?: string;
  /** Label shown after a resolved write. */
  copiedLabel?: string;
  /** Polite live-region announcement on success. */
  successAnnouncement?: string;
  /** Polite live-region (+ optional visible) guidance on failure. */
  failureAnnouncement?: string;
  /** Element whose contents should be selected on failure for manual copy. */
  selectRef?: RefObject<HTMLElement | null>;
  /** Alternate to `selectRef` — looks up `document.getElementById`. */
  selectTargetId?: string;
  /** When false, callers own visible failure UI (e.g. MembersPage card error). */
  showFailureMessage?: boolean;
  /** Forwarded after every attempt so callers can sync adjacent state. */
  onResult?: (outcome: CopyOutcome) => void;
  /** How long copied/failed feedback stays before resetting. */
  feedbackMs?: number;
  ghost?: boolean;
  /**
   * When true, render a plain `<button>` so callers can supply full chrome
   * (e.g. `btn btn-primary` or an underline link). Default uses {@link Btn}.
   */
  unstyled?: boolean;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'onClick' | 'children'>;

export function CopyControl({
  text,
  label = 'Copy',
  copiedLabel = 'Copied!',
  successAnnouncement = DEFAULT_COPY_SUCCESS,
  failureAnnouncement = DEFAULT_COPY_FAILURE,
  selectRef,
  selectTargetId,
  showFailureMessage = true,
  onResult,
  feedbackMs = COPY_FEEDBACK_MS,
  ghost,
  unstyled = false,
  className = '',
  'aria-label': ariaLabel,
  ...rest
}: CopyControlProps) {
  const announce = useAnnounce();
  const [feedback, setFeedback] = useState<CopyFeedbackSnapshot>(initialCopyFeedback);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // Generation token so a slow write can't clobber a newer attempt's feedback.
  const generationRef = useRef(0);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    };
  }, []);

  // When the value to copy changes (new share/invite/reset URL), drop any
  // leftover "Copied!" so we never claim a different string was copied.
  useEffect(() => {
    generationRef.current += 1;
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setFeedback(initialCopyFeedback);
  }, [text]);

  function armResetTimer() {
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setFeedback((current) => reduceCopyFeedback(current, { type: 'reset' }));
      timerRef.current = null;
    }, feedbackMs);
  }

  async function copy() {
    const generation = ++generationRef.current;
    const outcome = await writeClipboardText(text);
    if (generation !== generationRef.current) return;

    if (outcome.ok) {
      setFeedback((current) => reduceCopyFeedback(current, { type: 'succeeded' }));
      announce(successAnnouncement);
      armResetTimer();
    } else {
      setFeedback((current) => reduceCopyFeedback(current, { type: 'failed' }));
      // Select recovery text, then restore focus to the Copy button so failure
      // never moves keyboard focus (invite-form a11y #516 / e2e contract).
      selectElementText(resolveSelectTarget(selectRef, selectTargetId));
      buttonRef.current?.focus({ preventScroll: true });
      announce(failureAnnouncement);
      armResetTimer();
    }
    onResult?.(outcome);
  }

  const buttonLabel = feedback.status === 'copied' ? copiedLabel : label;

  const sharedProps = {
    ...rest,
    ref: buttonRef,
    type: 'button' as const,
    className,
    'aria-label': ariaLabel,
    onClick: () => {
      void copy();
    },
  };

  const button = unstyled ? (
    <button {...sharedProps}>{buttonLabel}</button>
  ) : (
    <Btn {...sharedProps} ghost={ghost}>
      {buttonLabel}
    </Btn>
  );

  // Failure copy is announced via the app-root polite live region
  // (`useAnnounce`); this visible line is guidance only — no role="alert",
  // so screen readers aren't told the same message twice (see MembersPage #516).
  // When the caller owns failure UI (or the control sits inline in prose),
  // skip the wrapper so layout isn't disturbed.
  if (!showFailureMessage) return button;

  return (
    <span className="inline-flex flex-col items-stretch gap-1 min-w-0">
      {button}
      {feedback.status === 'failed' && (
        <span className="text-[11px] text-rose-400 m-0" data-testid="copy-control-failure">
          {failureAnnouncement}
        </span>
      )}
    </span>
  );
}
