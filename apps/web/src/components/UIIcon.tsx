/**
 * App chrome control icons (issue #678) — a fixed vocabulary of illustrated
 * game-icons slugs for buttons, toggles, and nav affordances. Domain art
 * (entities, empty states, tab bar modules) stays on <GameIcon>.
 */
import { GameIcon } from './GameIcon';
import {
  UI_CONTROL_ICON,
  UI_ICON_SIZE,
  type UiControlIcon,
  type UiIconSize,
} from '../lib/uiIcons';

export function UIIcon({
  name,
  size = 'sm',
  className = '',
  title,
}: {
  name: UiControlIcon;
  size?: UiIconSize;
  className?: string;
  title?: string;
}) {
  return (
    <GameIcon
      slug={UI_CONTROL_ICON[name]}
      size={UI_ICON_SIZE[size]}
      className={className}
      title={title}
    />
  );
}
