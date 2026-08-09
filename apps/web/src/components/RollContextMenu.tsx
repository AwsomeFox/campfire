import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

export type RollMode = 'normal' | 'advantage' | 'disadvantage' | 'crit';

interface RollContextMenuProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  /**
   * Called with the mode this interaction asked for.
   *
   * The `event` argument is only passed on the PLAIN-CLICK path, never from the context /
   * long-press menu, and callers rely on that to tell the two apart: both emit `'normal'`,
   * but a plain click means "no preference" (defer to a chooser, if the caller has one)
   * while the menu's Normal item is an explicit request for a flat roll. See
   * `rollModeForClick` in features/characters/rollMode.ts. Keep the asymmetry.
   */
  onRoll: (mode: RollMode, event?: React.MouseEvent) => void;
  /**
   * Whether the menu offers "Critical Hit". Default true.
   *
   * `crit` only means something for a DAMAGE roll, where the caller doubles the dice. A
   * catalog CHECK has no critical variant — `checkRollExpr` and the server's `rollCheck`
   * both treat the mode as an ordinary single die — so offering it on a save, skill, ability
   * or initiative control let the user pick a command that silently produced a plain roll.
   * Those call sites pass false.
   */
  allowCrit?: boolean;
  /**
   * Whether the menu offers Advantage / Disadvantage. Default true.
   *
   * A catalog check carries `supportsAdvantage`, and a system that is not roll-two-keep
   * (PF2e) sets it false — callers then collapse either mode to `normal`, so offering the
   * commands meant an explicit selection silently produced a flat roll. Those call sites
   * pass the definition's own capability.
   */
  allowAdvantage?: boolean;
}

export function RollContextMenu({ children, onRoll, allowCrit = true, allowAdvantage = true, className, disabled, onClick, onContextMenu, onPointerDown, onPointerUp, onPointerCancel, ...rest }: RollContextMenuProps) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const pressTimer = useRef<NodeJS.Timeout | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (disabled) return;
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
  }, [disabled]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (disabled || e.button !== 0 || e.pointerType !== 'touch') return;
    pressTimer.current = setTimeout(() => {
      setMenuPos({ x: e.clientX, y: e.clientY });
    }, 500); // 500ms long press
  }, [disabled]);

  const handlePointerUp = useCallback(() => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (disabled) return;
    // Let keyboard modifiers override
    if (e.shiftKey) {
      onRoll('advantage', e);
    } else if (e.altKey || e.metaKey || e.ctrlKey) {
      onRoll('disadvantage', e);
    } else {
      onRoll('normal', e);
    }
  }, [disabled, onRoll]);

  const closeMenu = useCallback(() => setMenuPos(null), []);

  useEffect(() => {
    if (menuPos) {
      const handleGlobalClick = () => closeMenu();
      const handleGlobalKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
      window.addEventListener('pointerdown', handleGlobalClick);
      window.addEventListener('keydown', handleGlobalKey);
      return () => {
        window.removeEventListener('pointerdown', handleGlobalClick);
        window.removeEventListener('keydown', handleGlobalKey);
      };
    }
  }, [menuPos, closeMenu]);

  return (
    <>
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={(e) => {
          handleClick(e);
          onClick?.(e);
        }}
        onContextMenu={(e) => {
          handleContextMenu(e);
          onContextMenu?.(e);
        }}
        onPointerDown={(e) => {
          handlePointerDown(e);
          onPointerDown?.(e);
        }}
        onPointerUp={(e) => {
          handlePointerUp();
          onPointerUp?.(e);
        }}
        onPointerCancel={(e) => {
          handlePointerUp();
          onPointerCancel?.(e);
        }}
        {...rest}
      >
        {children}
      </button>
      {menuPos && createPortal(
        <div
          className="cf-popover"
          role="menu"
          style={{
            position: 'fixed',
            left: menuPos.x,
            top: menuPos.y,
            zIndex: 10000,
            background: 'var(--color-bg-elevated, #ffffff)',
            border: '1px solid var(--color-border, #e5e5e5)',
            borderRadius: 6,
            padding: 4,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            minWidth: 160
          }}
          onPointerDown={(e) => e.stopPropagation()} // prevent closing immediately
        >
          <button type="button" role="menuitem" className="cf-menu-item" onClick={() => { onRoll('normal'); closeMenu(); }}>
            🎲 Normal
          </button>
          {allowAdvantage && (
            <>
              <button type="button" role="menuitem" className="cf-menu-item" style={{ color: 'var(--color-success, #10b981)' }} onClick={() => { onRoll('advantage'); closeMenu(); }}>
                ✅ Advantage
              </button>
              <button type="button" role="menuitem" className="cf-menu-item" style={{ color: 'var(--color-danger, #ef4444)' }} onClick={() => { onRoll('disadvantage'); closeMenu(); }}>
                ❌ Disadvantage
              </button>
            </>
          )}
          {allowCrit && (
            <button type="button" role="menuitem" className="cf-menu-item" style={{ color: 'var(--cf-crit, #fbbf24)' }} onClick={() => { onRoll('crit'); closeMenu(); }}>
              💥 Critical Hit
            </button>
          )}
        </div>,
        document.body
      )}
    </>
  );
}
