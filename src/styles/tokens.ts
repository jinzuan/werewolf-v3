/**
 * The visual contract for the V3.1 UI.
 *
 * Values intentionally point at CSS custom properties instead of repeating
 * colour literals in TypeScript.  CSS is the single source of truth for the
 * day/night palettes; components can still consume this contract when they
 * need an inline style or a data attribute.
 */
const css = (name: string) => `var(--ww-${name})`;

export const colors = {
  moonCream: css('moon-cream'),
  nightSky: css('night-sky'),
  moonYellow: css('moon-yellow'),
  forestGreen: css('forest-green'),
  forestAction: css('forest-action'),
  wolfBerry: css('wolf-berry'),
  woodBrown: css('wood-brown'),
  mistBlue: css('mist-blue'),
  dangerRed: css('danger-red'),
  scene: css('bg-scene'),
  surface: css('bg-surface'),
  raised: css('bg-raised'),
  subtle: css('bg-subtle'),
  textStrong: css('text-strong'),
  textDefault: css('text-default'),
  textMuted: css('text-muted'),
  textDisabled: css('text-disabled'),
  border: css('border-default'),
  borderStrong: css('border-strong'),
  action: css('action-primary'),
  actionHover: css('action-hover'),
  success: css('state-success'),
  warning: css('state-warning'),
  danger: css('state-danger'),
  info: css('state-info'),
  focus: css('focus-ring'),
  overlay: css('overlay'),
} as const;

export const typography = {
  display: {
    family: css('font-family-display'),
    size: css('text-display-size'),
    lineHeight: css('text-display-line'),
    weight: 700,
  },
  pageTitle: {
    family: css('font-family-body'),
    size: css('text-page-title-size'),
    lineHeight: css('text-page-title-line'),
    weight: 700,
  },
  moduleTitle: {
    family: css('font-family-body'),
    size: css('text-module-title-size'),
    lineHeight: css('text-module-title-line'),
    weight: 600,
  },
  body: {
    family: css('font-family-body'),
    size: css('text-body-size'),
    lineHeight: css('text-body-line'),
    weight: 400,
  },
  auxiliary: {
    family: css('font-family-body'),
    size: css('text-caption-size'),
    lineHeight: css('text-caption-line'),
    weight: 400,
  },
  numeric: {
    family: css('font-family-number'),
    size: css('text-body-size'),
    lineHeight: css('text-body-line'),
    weight: 600,
  },
} as const;

export const spacing = {
  1: css('space-1'),
  2: css('space-2'),
  3: css('space-3'),
  4: css('space-4'),
  5: css('space-5'),
  6: css('space-6'),
  8: css('space-8'),
  10: css('space-10'),
  12: css('space-12'),
} as const;

export const radii = {
  control: css('radius-control'),
  card: css('radius-card'),
  modal: css('radius-dialog'),
  hero: css('radius-hero'),
  pill: css('radius-pill'),
} as const;

export const sizing = {
  controlHeight: css('height-control'),
  primaryActionHeight: css('height-action'),
  iconButton: css('size-icon-button'),
  contentMaxWidth: css('content-max'),
  desktopGutter: css('page-gutter-desktop'),
  tabletGutter: css('page-gutter-tablet'),
  mobileGutter: css('page-gutter-mobile'),
} as const;

export const shadows = {
  card: css('shadow-card'),
  dialog: css('shadow-dialog'),
} as const;

export const motion = {
  fast: css('motion-fast'),
  standard: css('motion-standard'),
  scene: css('motion-scene'),
  easing: css('motion-easing'),
} as const;

export const visualTokens = {
  colors,
  typography,
  spacing,
  radii,
  sizing,
  shadows,
  motion,
} as const;

export type VisualTokens = typeof visualTokens;

export type Scene = 'day' | 'dusk' | 'night' | 'dawn';
