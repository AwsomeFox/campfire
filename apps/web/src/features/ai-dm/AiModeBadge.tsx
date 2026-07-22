/**
 * Mode-aware chrome (issue #343) — a small badge that surfaces whether an AI participates
 * in this campaign BEFORE it ever speaks, so players aren't surprised by an AI at the table.
 *
 *   - off (or seat unreadable): renders nothing.
 *   - driver: a link to the Table, where the AI-run session is played.
 *   - co_dm: a disclosure that expands the "what the AI can do here" transparency note —
 *     players see what data it sees and that canon changes still need the DM.
 *
 * Reads the seat mode (GET /campaigns/:id/ai-dm) — non-secret, so it's safe for players
 * (unlike the DM `instructions`, which the server redacts per #261). The seat read stops
 * on a 4xx (feature off / not a member), so the badge simply stays hidden then.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAiDmSeat } from '../../lib/query';
import { AiTransparencyNote } from './AiSetupChecklist';
import { GameIcon } from '../../components/GameIcon';
import { useDialog } from '../../components/useDialog';

const POPOVER_GAP = 8;
const VIEWPORT_MARGIN = 12;

interface PopoverPosition {
  top: number;
  left: number;
  maxHeight: number;
  placement: 'top' | 'bottom';
}

function fitPopover(trigger: DOMRect, popover: DOMRect): PopoverPosition {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const spaceBelow = viewportHeight - trigger.bottom - POPOVER_GAP - VIEWPORT_MARGIN;
  const spaceAbove = trigger.top - POPOVER_GAP - VIEWPORT_MARGIN;
  const placement = popover.height <= spaceBelow || spaceBelow >= spaceAbove ? 'bottom' : 'top';
  const availableHeight = Math.max(0, placement === 'bottom' ? spaceBelow : spaceAbove);
  const renderedHeight = Math.min(popover.height, availableHeight);
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - VIEWPORT_MARGIN - popover.width);
  const left = Math.min(Math.max(trigger.left, VIEWPORT_MARGIN), maxLeft);
  const unclampedTop = placement === 'bottom'
    ? trigger.bottom + POPOVER_GAP
    : trigger.top - POPOVER_GAP - renderedHeight;
  const top = Math.min(
    Math.max(unclampedTop, VIEWPORT_MARGIN),
    Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - renderedHeight),
  );

  return { top, left, maxHeight: availableHeight, placement };
}

export function AiModeBadge({ campaignId }: { campaignId: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const { data: seat } = useAiDmSeat(campaignId);
  const mode = seat?.mode;

  useEffect(() => {
    if (!open) return;
    function dismissOutside(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || document.getElementById(popoverId)?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [open, popoverId]);

  if (mode !== 'co_dm' && mode !== 'driver') return null;

  if (mode === 'driver') {
    return (
      <Link
        to={`/c/${campaignId}/table`}
        className="tag tag-accent"
        style={{ whiteSpace: 'nowrap', cursor: 'pointer', textDecoration: 'none' }}
        aria-label={t('aiOnboarding.badge.driverAria')}
      >
        <GameIcon slug="sparkles" size={12} className="inline align-text-bottom mr-1" />{t('aiOnboarding.badge.driver')}
      </Link>
    );
  }

  // co_dm — a disclosure into the transparency explainer for players.
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={triggerRef}
        type="button"
        className="tag tag-accent-2"
        style={{ whiteSpace: 'nowrap', cursor: 'pointer', border: 'none' }}
        aria-expanded={open}
        aria-controls={popoverId}
        aria-haspopup="dialog"
        aria-label={t('aiOnboarding.badge.coDmAria')}
        onClick={() => setOpen((v) => !v)}
      >
        <GameIcon slug="sparkles" size={12} className="inline align-text-bottom mr-1" />{t('aiOnboarding.badge.coDm')}
      </button>
      {open && (
        <AiModePopover id={popoverId} triggerRef={triggerRef} onClose={() => setOpen(false)} />
      )}
    </span>
  );
}

function AiModePopover({
  id,
  triggerRef,
  onClose,
}: {
  id: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const focused = useRef(false);
  const popoverRef = useDialog<HTMLDivElement>({ onClose, trapFocus: false });

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    setPosition(fitPopover(trigger.getBoundingClientRect(), popover.getBoundingClientRect()));
  }, [popoverRef, triggerRef]);

  useLayoutEffect(() => {
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    if (triggerRef.current) observer.observe(triggerRef.current);
    if (popoverRef.current) observer.observe(popoverRef.current);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [popoverRef, triggerRef, updatePosition]);

  useEffect(() => {
    if (!position || focused.current) return;
    focused.current = true;
    popoverRef.current?.focus();
  }, [popoverRef, position]);

  return (
    <div
      id={id}
      ref={popoverRef}
      className="card elev-md overflow-y-auto"
      style={{
        position: 'fixed',
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        zIndex: 40,
        width: 'min(300px, calc(100vw - 24px))',
        maxHeight: position?.maxHeight,
        padding: 4,
        visibility: position ? 'visible' : 'hidden',
      }}
      role="dialog"
      aria-label={t('aiOnboarding.badge.coDmPopover')}
      tabIndex={-1}
      data-placement={position?.placement}
    >
      <AiTransparencyNote />
    </div>
  );
}
