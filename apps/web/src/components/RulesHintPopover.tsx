/**
 * RulesHintPopover — inline rules hints for new players (issue #1939).
 *
 * A real `<button>` disclosure (not `title=` — hover-only tooltips are invisible on touch
 * and to keyboard/screen-reader users) that reveals a small labelled popover with a
 * one-to-two-sentence mechanical summary for a standard action or condition. Operable by
 * click, tap, and keyboard (Enter/Space via the native button, Escape to close); outside
 * pointerdown also dismisses it.
 *
 * Callers resolve whether a hint exists at all via `standardActionHintKey` /
 * `conditionHintKey` (`../lib/rulesHints`) and only mount this component when a key comes
 * back — an adapter with no authored hint renders no affordance, never 5e text on a
 * non-5e system.
 *
 * Positioning reuses `fitTermHelpPanel` (`./termHelpPosition`): the panel is
 * `position: fixed`, anchored from the trigger's bounding rect and clamped inside the
 * viewport, so it isn't clipped by narrow/overflow-hidden hosts like the combatant list or
 * the standard-actions bar's own horizontal scroller.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card } from './ui';
import { useDisclosure } from './useDisclosure';
import { fitTermHelpPanel, type TermHelpPanelPosition } from './termHelpPosition';

export interface RulesHintPopoverProps {
  /** Stable id for data-testid / element ids (e.g. the standard-action id, or the condition
   *  name lowercased) — distinct from `termLabel`, which is the rendered display text. */
  termId: string;
  /** Display name shown in the popover heading and used for the compendium search query
   *  (e.g. "Dodge", "Restrained"). */
  termLabel: string;
  /** i18n key for the 1-2 sentence rules-hint body, resolved via `t()`. */
  hintKey: string;
  /** Compendium search link ("Full rule"), only when the campaign resolves to an installed
   *  rule pack with entries (issue #1939 criterion 3) — omitted hides the link entirely. */
  compendiumHref?: string;
  /** Panel anchor side, same convention as TermHelp. Defaults to 'start'. */
  align?: 'start' | 'end';
  className?: string;
}

export function RulesHintPopover({
  termId,
  termLabel,
  hintKey,
  compendiumHref,
  align = 'start',
  className = '',
}: RulesHintPopoverProps) {
  const { t } = useTranslation();
  const { open, setOpen, regionId, buttonProps, regionProps } = useDisclosure({
    focusManagement: false,
    regionLabel: t('encounters.rulesHints.regionLabel', { term: termLabel }),
  });
  const { ref: regionRef, ...regionAttrs } = regionProps;
  const { ref: triggerRef, ...buttonAttrs } = buttonProps;
  const panelRef = useRef<HTMLSpanElement | null>(null);
  const [position, setPosition] = useState<TermHelpPanelPosition | null>(null);

  const setPanelRef = useCallback(
    (node: HTMLSpanElement | null) => {
      panelRef.current = node;
      (regionRef as unknown as { current: HTMLElement | null }).current = node;
    },
    [regionRef],
  );

  const updatePosition = useCallback(() => {
    const trigger = triggerRef?.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    setPosition(
      fitTermHelpPanel(trigger.getBoundingClientRect(), panel.getBoundingClientRect(), align, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [align, triggerRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    if (triggerRef?.current) observer.observe(triggerRef.current);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener('resize', updatePosition);
    // Capture: the combatant list and the standard-actions bar are their own scroll containers.
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, triggerRef, updatePosition]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef?.current?.focus();
      }
    }
    function dismissOutside(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef?.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', dismissOutside);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', dismissOutside);
    };
  }, [open, setOpen, triggerRef]);

  return (
    <span className={`cf-rules-hint ${className}`.trim()}>
      <button
        {...buttonAttrs}
        ref={triggerRef}
        type="button"
        className="cf-rules-hint__trigger cf-target-44"
        aria-label={t('encounters.rulesHints.triggerAria', { term: termLabel })}
        // Issue #1939 acceptance criteria: aria-expanded (from useDisclosure) plus
        // aria-describedby pointing at the open region, alongside aria-controls.
        aria-describedby={open ? regionId : undefined}
        data-testid={`rules-hint-trigger-${termId}`}
      >
        i
      </button>
      {open && (
        <Card
          {...(regionAttrs as HTMLAttributes<HTMLSpanElement>)}
          ref={setPanelRef}
          density="compact"
          elev="md"
          as="span"
          className="cf-rules-hint__panel"
          data-testid={`rules-hint-panel-${termId}`}
          style={{
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            maxHeight: position?.maxHeight,
            visibility: position ? 'visible' : 'hidden',
          }}
        >
          <span className="cf-rules-hint__title">{termLabel}</span>
          <span className="cf-rules-hint__body">{t(hintKey)}</span>
          {compendiumHref && (
            <Link to={compendiumHref} className="cf-rules-hint__link" onClick={() => setOpen(false)}>
              {t('encounters.rulesHints.fullRule')}
            </Link>
          )}
        </Card>
      )}
    </span>
  );
}
