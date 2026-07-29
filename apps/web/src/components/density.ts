/**
 * Canonical UI density ramp (issue #674, `xs` added by issue #1683).
 *
 * xs         — dense inline row actions / toolbar buttons ONLY (e.g. a
 *              "Resolve →" action inside a list row). Never a page's primary
 *              or only interactive control, and never used for anything that
 *              is someone's sole way to reach a function — `xs` controls
 *              still meet the WCAG 2.2 SC 2.5.8 24×24 CSS px minimum via
 *              `--cf-density-xs-control-min-height` (index.css), but that is
 *              the legal floor, not a comfortable target — prefer `compact`
 *              when there is room for it.
 * compact    — list tiles, dashboard widgets, dense toolbars (Nocturne-native spacing)
 * default    — standard forms and panels
 * comfortable — primary content cards and auth shells
 */
export type UiDensity = 'xs' | 'compact' | 'default' | 'comfortable';

export type UiElevation = 'sm' | 'md' | 'lg';

const DENSITY_CLASS: Record<UiDensity, string> = {
  xs: 'cf-density-xs',
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
