/**
 * Responsive page header (issue #707, #1714).
 *
 * List/hub screens used to pack the title and several compact actions into a
 * single non-wrapping row, overriding the design-system 44px touch target
 * (`!min-h-0 !py-1.5`). This shared header:
 *  - keeps the title and primary action visible, using the canonical display font
 *    (`--font-display` and `--font-display-weight`) aligned with `<PageTitle>` (#1714)
 *  - stacks the action row under the title on narrow viewports / high zoom
 *  - moves secondary actions into an accessible overflow menu below the
 *    stacking breakpoint, while showing them inline on wider layouts
 *  - never shrinks primary/secondary controls below 44×44 CSS px
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDialog } from './useDialog';
import { Btn } from './ui';

export type PageHeaderSecondaryAction = {
  key: string;
  /** Visible label for both the wide inline control and the overflow menuitem. */
  label: string;
  onClick?: () => void;
  href?: string;
  /** Prefer a ghost (secondary) look for the wide inline control. Default true. */
  ghost?: boolean;
  /** Dialog/popover disclosure wiring when the action opens a modal (e.g. Draft with AI). */
  ariaHaspopup?: 'dialog' | 'menu' | boolean;
  ariaExpanded?: boolean;
  ariaControls?: string;
};

export type PageHeaderProps = {
  title: ReactNode;
  /** Optional muted trailing text after the title (e.g. "· Locations"). */
  subtitle?: ReactNode;
  /** Always-visible primary CTA (create / add). Must meet 44×44 when interactive. */
  primaryAction?: ReactNode;
  /**
   * Secondary actions. Shown inline beside the primary on wide layouts; collapsed
   * into an accessible overflow menu on narrow layouts / high zoom.
   */
  secondaryActions?: readonly PageHeaderSecondaryAction[];
  /**
   * Heading level. List hubs use h1; card-embedded headers (World tabs) may use
   * h1 as well since they are the page's sole heading.
   */
  headingLevel?: 'h1' | 'h2';
  /** Card-style bottom border used by World list cards. */
  variant?: 'page' | 'card';
  className?: string;
  /** Optional leading icon rendered inside the title. */
  icon?: ReactNode;
};

export function PageHeader({
  title,
  subtitle,
  primaryAction,
  secondaryActions = [],
  headingLevel = 'h1',
  variant = 'page',
  className = '',
  icon,
}: PageHeaderProps) {
  const Heading = headingLevel;
  const hasSecondary = secondaryActions.length > 0;
  const hasActions = Boolean(primaryAction) || hasSecondary;

  return (
    <header
      className={`cf-page-header cf-page-header--${variant} ${className}`.trim()}
      data-testid="page-header"
    >
      <Heading className="cf-page-header__title">
        {icon ? <span className="cf-page-header__icon" aria-hidden="true">{icon}</span> : null}
        <span className="cf-page-header__title-text">{title}</span>
        {subtitle != null && subtitle !== false ? (
          <span className="cf-page-header__subtitle">{subtitle}</span>
        ) : null}
      </Heading>

      {hasActions && (
        <div className="cf-page-header__actions">
          {hasSecondary && (
            <>
              <div className="cf-page-header__secondary-inline" data-testid="page-header-secondary-inline">
                {secondaryActions.map((action) => (
                  <SecondaryInline key={action.key} action={action} />
                ))}
              </div>
              <PageHeaderOverflowMenu actions={secondaryActions} />
            </>
          )}
          {primaryAction ? (
            <div className="cf-page-header__primary" data-testid="page-header-primary">
              {primaryAction}
            </div>
          ) : null}
        </div>
      )}
    </header>
  );
}

function secondaryAriaProps(action: PageHeaderSecondaryAction) {
  return {
    'aria-haspopup': action.ariaHaspopup,
    'aria-expanded': action.ariaExpanded,
    'aria-controls': action.ariaControls,
  };
}

function SecondaryInline({ action }: { action: PageHeaderSecondaryAction }) {
  const ghost = action.ghost !== false;
  const className = `cf-btn ${ghost ? 'cf-btn-ghost' : ''} cf-page-header__action`.trim();
  if (action.href) {
    return (
      <Link to={action.href} className={`${className} no-underline`} {...secondaryAriaProps(action)}>
        {action.label}
      </Link>
    );
  }
  return (
    <Btn
      ghost={ghost}
      type="button"
      className="cf-page-header__action"
      onClick={action.onClick}
      {...secondaryAriaProps(action)}
    >
      {action.label}
    </Btn>
  );
}

function PageHeaderOverflowMenu({ actions }: { actions: readonly PageHeaderSecondaryAction[] }) {
  const { t } = useTranslation();
  const reactId = useId();
  const buttonId = `${reactId}-overflow-trigger`;
  const menuId = `${reactId}-overflow-menu`;
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current) return;
      if (event.target instanceof Node && containerRef.current.contains(event.target)) return;
      close(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="cf-page-header__overflow relative inline-flex">
      <Btn
        ref={buttonRef}
        ghost
        type="button"
        id={buttonId}
        className="cf-page-header__overflow-trigger cf-page-header__action"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t('common.moreActions')}
        data-testid="page-header-overflow"
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        ⋯
      </Btn>
      {open && (
        <OverflowMenuPanel
          id={menuId}
          labelledBy={buttonId}
          actions={actions}
          anchorRef={buttonRef}
          onClose={() => close(true)}
          onDismissWithoutFocus={() => close(false)}
        />
      )}
    </div>
  );
}

function OverflowMenuPanel({
  id,
  labelledBy,
  actions,
  anchorRef,
  onClose,
  onDismissWithoutFocus,
}: {
  id: string;
  labelledBy: string;
  actions: readonly PageHeaderSecondaryAction[];
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onDismissWithoutFocus: () => void;
}) {
  const { t } = useTranslation();
  const menuRef = useDialog<HTMLDivElement>({ onClose, trapFocus: false });

  // Clamp the menu to the viewport so it stays usable at 320px / 400% zoom.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const button = anchorRef.current;
    if (!menu || !button) return;

    const place = () => {
      menu.style.left = '';
      menu.style.right = '';
      menu.style.top = '';
      menu.style.maxHeight = '';

      const buttonRect = button.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight;
      const margin = 8;

      const rightEdge = buttonRect.right;
      const leftEdge = rightEdge - menuRect.width;
      if (leftEdge < margin) {
        const clampedLeft = Math.min(
          Math.max(margin, buttonRect.left),
          Math.max(margin, viewportWidth - menuRect.width - margin),
        );
        menu.style.left = `${clampedLeft}px`;
        menu.style.right = 'auto';
      } else {
        menu.style.right = `${viewportWidth - rightEdge}px`;
        menu.style.left = 'auto';
      }

      const spaceBelow = viewportHeight - buttonRect.bottom;
      const spaceAbove = buttonRect.top;
      const maxHeight = Math.max(spaceBelow, spaceAbove) - margin * 2;
      menu.style.maxHeight = `${Math.max(120, Math.min(menuRect.height, maxHeight))}px`;
      const placeBelow = spaceBelow >= menuRect.height || spaceBelow >= spaceAbove;
      if (placeBelow) {
        menu.style.top = `${buttonRect.bottom + 4}px`;
      } else {
        menu.style.top = `${buttonRect.top - Math.min(menuRect.height, maxHeight) - 4}px`;
      }
    };

    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { passive: true });
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place);
    };
  }, [actions.length, anchorRef, menuRef]);

  return (
    <div
      ref={menuRef}
      id={id}
      role="menu"
      aria-labelledby={labelledBy}
      aria-label={t('common.pageActionsMenu')}
      className="cf-page-header__menu card elev-md"
      data-testid="page-header-overflow-menu"
      style={{ position: 'fixed', zIndex: 40 }}
    >
      {actions.map((action) => {
        if (action.href) {
          return (
            <Link
              key={action.key}
              to={action.href}
              role="menuitem"
              className="cf-page-header__menuitem"
              onClick={onDismissWithoutFocus}
              {...secondaryAriaProps(action)}
            >
              {action.label}
            </Link>
          );
        }
        return (
          <button
            key={action.key}
            type="button"
            role="menuitem"
            className="cf-page-header__menuitem"
            onClick={() => {
              onDismissWithoutFocus();
              action.onClick?.();
            }}
            {...secondaryAriaProps(action)}
          >
            {action.label}
          </button>
        );
      })}
    </div>
  );
}
