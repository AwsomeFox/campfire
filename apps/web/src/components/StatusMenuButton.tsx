/**
 * StatusMenuButton — a shared accessible status picker (issue #705).
 *
 * QuestPage and LocationPage each had a plain absolute <div> popover for the DM
 * "set status" action: no popup semantics, no selected state, no focus movement,
 * no Escape / outside dismissal, and no keyboard navigation. This component
 * replaces both with a single listbox-style popup that is keyboard and screen
 * reader complete.
 *
 * Pattern (WAI-ARIA Listbox, since each option has a selected state and the
 * trigger should announce the current selection):
 *  - trigger: <button aria-haspopup="listbox" aria-expanded aria-controls>
 *  - popup:   <ul role="listbox" aria-labelledby="trigger">
 *  - option:  <li role="option" aria-selected>
 *
 * Keyboard contract:
 *  - Enter / Space / ArrowDown / ArrowUp on the trigger opens the popup and
 *    moves focus onto the selected (or first) option.
 *  - ArrowUp / ArrowDown move between options, wrapping at the ends.
 *  - Home / End jump to the first / last option.
 *  - Enter / Space commits the focused option.
 *  - Escape closes and returns focus to the trigger.
 *  - Tab from an open popup commits the focused option and moves on: the menu
 *    closes immediately (without restoring focus) before the async save
 *    settles; a click outside dismisses without committing.
 *
 * The popup is anchored to the trigger and clamped to the viewport so it stays
 * on screen at high zoom / on narrow viewports. Selection is preserved when a
 * save fails: the caller passes the current (server-acknowledged) value back in
 * `value`, and a failure surfaced via `announceFailure` re-asserts the popup's
 * selected state.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

export interface StatusMenuOption<V extends string> {
  value: V;
  /** Visible label, usually the badge text (icon + word). */
  label: React.ReactNode;
}

export interface StatusMenuButtonProps<V extends string> {
  /** Accessible name for the trigger button, e.g. "Quest status: Active". */
  triggerLabel: string;
  /** Accessible description appended via aria-describedby (optional). */
  triggerDescription?: string;
  /** Stable id suffix; the menu generates its own ids when omitted. */
  id?: string;
  /** The currently-committed (server-acknowledged) value. */
  value: V;
  options: readonly StatusMenuOption<V>[];
  /**
   * Called when the user commits an option. Enter/Space keep the menu open
   * until this settles (then close with focus restored); Tab closes the menu
   * immediately without restoring focus, then awaits this in the background.
   */
  onSelect: (value: V) => void | Promise<void>;
  /** Disables the trigger (e.g. while a status save is in flight). */
  disabled?: boolean;
  /** Visible trigger text. Defaults to the selected option's label. */
  triggerText?: React.ReactNode;
  /** Extra classes for the trigger button. */
  className?: string;
  /**
   * Optional announcement emitted to the app live region when a save fails so
   * the user's selection is preserved visibly and the failure is spoken.
   */
  announceFailure?: (message: string) => void;
  failureMessage?: string;
}

export function StatusMenuButton<V extends string>({
  triggerLabel,
  triggerDescription,
  id,
  value,
  options,
  onSelect,
  disabled = false,
  triggerText,
  className = '',
  announceFailure,
  failureMessage,
}: StatusMenuButtonProps<V>) {
  const reactId = useId();
  const baseId = id ?? reactId;
  const buttonId = `${baseId}-trigger`;
  const listboxId = `${baseId}-listbox`;

  const [open, setOpen] = useState(false);
  // Index of the option currently focused within the listbox (visual focus, not
  // DOM focus). Tracks the selected value when closed so opening returns the
  // user to where they were.
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);
  const commitInFlight = useRef(false);
  // Latched when the menu closes without restoring focus (outside click, Tab,
  // in-flight dismiss). An in-flight commit's completion must honor this so
  // focus is not yanked back to the trigger after the user has moved on.
  const suppressFocusRestore = useRef(false);

  // Keep the active index in sync with the committed selection while closed so
  // re-opening always starts the keyboard journey on the current value.
  useEffect(() => {
    if (!open) setActiveIndex(selectedIndex);
  }, [selectedIndex, open]);

  const focusOption = useCallback((index: number) => {
    const node = optionRefs.current[index];
    if (node) node.focus();
  }, []);

  const openMenu = useCallback(() => {
    suppressFocusRestore.current = false;
    setOpen(true);
    setActiveIndex(selectedIndex);
  }, [selectedIndex]);

  const closeMenu = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (!restoreFocus) {
      suppressFocusRestore.current = true;
      return;
    }
    if (suppressFocusRestore.current) return;
    buttonRef.current?.focus();
    // Escape / trigger-click dismiss restores focus now, but if a save is still
    // pending the later finish() must not restore again — the user may have
    // already tabbed or clicked elsewhere after this dismiss.
    if (commitInFlight.current) {
      suppressFocusRestore.current = true;
    }
  }, []);

  // Move the DOM focus to the active option whenever it changes while open.
  useEffect(() => {
    if (!open) return;
    // Defer one frame so the option list has rendered before we focus it.
    const handle = requestAnimationFrame(() => focusOption(activeIndex));
    return () => cancelAnimationFrame(handle);
  }, [open, activeIndex, focusOption]);

  // Escape + outside-click dismissal while open.
  useEffect(() => {
    if (!open) return;
    const root = containerRef.current;
    function onPointerDown(event: PointerEvent) {
      if (!root) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      // Close without forcing focus back to the trigger: a forced refocus on
      // pointerdown fights the user's click target (focus would briefly jump
      // to the trigger and can disrupt clicking/focusing whatever they
      // actually clicked outside the popup).
      closeMenu(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, closeMenu]);

  // Clamp the popup to the viewport so it stays visible at high zoom / on small
  // screens. Recompute on open and on any viewport change while open.
  useLayoutEffect(() => {
    if (!open) return;
    const root = containerRef.current;
    const listbox = listboxRef.current;
    const button = buttonRef.current;
    if (!root || !listbox || !button) return;

    const place = () => {
      // Reset to the default CSS position (right-anchored under the trigger)
      // before measuring so we never accumulate stale inline overrides.
      listbox.style.left = '';
      listbox.style.right = '';
      listbox.style.top = '';
      listbox.style.maxHeight = '';

      const buttonRect = button.getBoundingClientRect();
      const listboxRect = listbox.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight;

      // Horizontal: prefer right-aligned under the trigger, but if it would
      // overflow the left edge, push it right; if it overflows the viewport
      // width, fall back to left alignment. Keep at least an 8px margin.
      const margin = 8;
      const rightEdge = buttonRect.right;
      const leftEdge = rightEdge - listboxRect.width;
      if (leftEdge < margin) {
        // Not enough room on the left — anchor to the left of the viewport area.
        const clampedLeft = Math.min(
          Math.max(margin, buttonRect.left),
          Math.max(margin, viewportWidth - listboxRect.width - margin),
        );
        listbox.style.left = `${clampedLeft}px`;
        listbox.style.right = 'auto';
      } else {
        listbox.style.right = `${viewportWidth - rightEdge}px`;
        listbox.style.left = 'auto';
      }

      // Vertical: prefer below the trigger; flip above when below would clip.
      const spaceBelow = viewportHeight - buttonRect.bottom;
      const spaceAbove = buttonRect.top;
      const maxHeight = Math.max(spaceBelow, spaceAbove) - margin * 2;
      listbox.style.maxHeight = `${Math.max(120, Math.min(listboxRect.height, maxHeight))}px`;
      const placeBelow = spaceBelow >= listboxRect.height || spaceBelow >= spaceAbove;
      if (placeBelow) {
        listbox.style.top = `${buttonRect.bottom}px`;
      } else {
        listbox.style.top = `${buttonRect.top - Math.min(listboxRect.height, maxHeight)}px`;
      }
    };

    place();
    const onResize = () => place();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, { passive: true });
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize);
    };
  }, [open]);

  function cycle(delta: number) {
    if (options.length === 0) return;
    setActiveIndex((prev) => {
      const next = (prev + delta + options.length) % options.length;
      return next;
    });
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    switch (event.key) {
      case 'Enter':
      case ' ':
      case 'Spacebar':
        event.preventDefault();
        openMenu();
        break;
      case 'ArrowDown':
        event.preventDefault();
        openMenu();
        break;
      case 'ArrowUp':
        event.preventDefault();
        openMenu();
        break;
      default:
        break;
    }
  }

  function handleOptionKeyDown(event: React.KeyboardEvent<HTMLLIElement>, index: number) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        cycle(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        cycle(-1);
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
      case 'Spacebar':
        event.preventDefault();
        void commit(options[index]);
        break;
      case 'Tab':
        // Tab commits the focused option and lets the user keep moving —
        // matches native <select> behavior on Windows/Linux. Close happens
        // immediately inside commit (restoreFocus: false) so aria-expanded
        // flips and Escape/outside listeners detach while focus moves on.
        void commit(options[index], { restoreFocus: false });
        break;
      case 'Escape':
        event.preventDefault();
        closeMenu(true);
        break;
      default:
        // Type-ahead: jump to the first option whose label starts with the key.
        if (event.key.length === 1) {
          const needle = event.key.toLowerCase();
          const match = options.findIndex((opt) => textOf(opt.label).toLowerCase().startsWith(needle));
          if (match >= 0) setActiveIndex(match);
        }
        break;
    }
  }

  async function commit(option: StatusMenuOption<V>, opts?: { restoreFocus?: boolean }) {
    const restoreFocus = opts?.restoreFocus ?? true;
    const finish = () => {
      const shouldRestore = restoreFocus && !suppressFocusRestore.current;
      closeMenu(shouldRestore);
    };
    if (option.value === value) {
      // Selecting the already-selected option is a no-op apart from closing.
      // This must run before the in-flight guard below: dismissing on the
      // current value (Escape-style) should always close the menu, even
      // while an earlier save for a different option is still pending.
      finish();
      return;
    }
    if (commitInFlight.current) {
      // Duplicate activation while a save is pending: close without focus so
      // the menu doesn't hang open looking unresponsive.
      closeMenu(false);
      return;
    }
    commitInFlight.current = true;
    try {
      // Tab (restoreFocus: false): close immediately so aria-expanded flips and
      // Escape/outside listeners detach while focus continues to the next
      // control. Enter/Space keep the menu open until onSelect settles
      // (unless the user dismisses in the meantime, which latches
      // suppressFocusRestore so finish() does not yank focus back).
      if (!restoreFocus) {
        closeMenu(false);
      }
      await onSelect(option.value);
      finish();
    } catch {
      // The caller's onSelect is expected to surface its own failure UI. The
      // selection is preserved (value is unchanged), and we surface a spoken
      // failure when an announcer was supplied so screen reader users learn
      // the save did not stick.
      if (announceFailure && failureMessage) announceFailure(failureMessage);
      finish();
    } finally {
      commitInFlight.current = false;
    }
  }

  const triggerTextNode =
    triggerText ?? options.find((o) => o.value === value)?.label ?? triggerLabel;

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className={className}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => (open ? closeMenu(true) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
        aria-label={triggerLabel}
        aria-describedby={triggerDescription ? `${baseId}-desc` : undefined}
      >
        {triggerTextNode}
      </button>
      {triggerDescription && (
        <span id={`${baseId}-desc`} className="sr-only">
          {triggerDescription}
        </span>
      )}
      {open && (
        <ul
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          aria-labelledby={buttonId}
          tabIndex={-1}
          className="cf-card p-1 space-y-0.5 min-w-[140px] z-20 cf-status-menu"
          style={{ position: 'fixed', marginBlockStart: 4 }}
        >
          {options.map((option, index) => {
            const selected = option.value === value;
            const isActive = index === activeIndex;
            return (
              <li
                key={option.value}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                role="option"
                tabIndex={isActive ? 0 : -1}
                aria-selected={selected}
                data-active={isActive ? '' : undefined}
                className={`w-full text-left text-xs rounded px-2 py-1.5 cursor-pointer outline-none focus-visible:bg-slate-700 hover:bg-slate-700 ${
                  selected ? 'text-white font-semibold' : 'text-slate-300'
                }`}
                onClick={(event) => {
                  event.stopPropagation();
                  setActiveIndex(index);
                  void commit(option);
                }}
                onMouseMove={() => {
                  if (!isActive) setActiveIndex(index);
                }}
                onKeyDown={(event) => handleOptionKeyDown(event, index)}
              >
                <span className="inline-flex items-center justify-between gap-2 w-full">
                  <span className="inline-flex items-center gap-1.5">{option.label}</span>
                  {selected && (
                    <span aria-hidden="true" className="text-[10px]">
                      ✓
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Flatten React label fragments to plain text for type-ahead matching. */
function textOf(node: React.ReactNode): string {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in (node as React.ReactElement)) {
    return textOf((node as React.ReactElement).props.children);
  }
  return '';
}
