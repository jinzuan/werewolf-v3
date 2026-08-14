export const colors = {
  bgVoid: '#0C0911',
  bgNight: '#120D1A',
  bgSurface: '#19131F',
  bgRaised: '#221A2A',
  border: '#3B3044',
  borderStrong: '#5B4966',
  purple: '#6F4A86',
  purpleSoft: '#A887B8',
  gold: '#D6A85E',
  goldHover: '#E3BA73',
  goldMuted: '#8D7043',
  text: '#F2EDF4',
  textMuted: '#B8AFC0',
  textDisabled: '#756D7B',
  danger: '#C94F5B',
  dangerBg: '#32171D',
  success: '#4FA87A',
  info: '#5797C9',
  warning: '#D08A45',
  focus: '#F0C97D',
} as const;

export const typography = {
  brand: {
    family: "'Noto Serif SC', serif",
    size: '28px',
    lineHeight: '38px',
    weight: 600,
  },
  pageTitle: {
    family: "'Noto Sans SC', sans-serif",
    size: '20px',
    lineHeight: '28px',
    weight: 600,
  },
  moduleTitle: {
    family: "'Noto Sans SC', sans-serif",
    size: '16px',
    lineHeight: '24px',
    weight: 600,
  },
  body: {
    family: "'Noto Sans SC', sans-serif",
    size: '14px',
    lineHeight: '22px',
    weight: 400,
  },
  auxiliary: {
    family: "'Noto Sans SC', sans-serif",
    size: '12px',
    lineHeight: '18px',
    weight: 400,
  },
  numeric: {
    family: "Inter, 'Noto Sans SC', sans-serif",
    size: '14px',
    lineHeight: '20px',
    weight: 600,
  },
} as const;

export const spacing = {
  1: '4px',
  2: '8px',
  3: '12px',
  4: '16px',
  5: '20px',
  6: '24px',
  8: '32px',
  10: '40px',
  12: '48px',
} as const;

export const radii = {
  control: '6px',
  card: '8px',
  modal: '10px',
} as const;

export const sizing = {
  controlHeight: '40px',
  primaryActionHeight: '44px',
  iconButton: '40px',
  contentMaxWidth: '1440px',
  desktopGutter: '24px',
  tabletGutter: '16px',
  mobileGutter: '12px',
} as const;

export const shadows = {
  elevated: '0 8px 24px rgba(0, 0, 0, 0.28)',
} as const;

export const motion = {
  fast: '120ms',
  standard: '180ms',
  easing: 'ease',
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
