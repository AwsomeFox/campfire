/**
 * Canonical UI density ramp (issue #674).
 *
 * compact    — list tiles, dashboard widgets, dense toolbars (Nocturne-native spacing)
 * default    — standard forms and panels
 * comfortable — primary content cards and auth shells
 */
export type UiDensity = 'compact' | 'default' | 'comfortable';

export type UiElevation = 'sm' | 'md' | 'lg';

const DENSITY_CLASS: Record<UiDensity, string> = {
  compact: 'cf-density-compact',
  default: 'cf-density-default',
  comfortable: 'cf-density-comfortable',
};

const ELEV_CLASS: Record<UiElevation, string> = {
  sm: 'elev-sm',
  md: 'elev-md',
  lg: 'elev-lg',
};

export function densityClass(density: UiDensity = 'default'): string {
  return DENSITY_CLASS[density];
}

export function elevClass(elev?: UiElevation): string {
  return elev ? ELEV_CLASS[elev] : '';
}
