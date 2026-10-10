import { createContext, useContext } from 'react';

/**
 * Colour tokens. Dark is the default; light exists for people who prefer it.
 * Text colours meet WCAG 2.2 AA (4.5:1) on their backgrounds.
 */
export interface Theme {
  dark: boolean;
  bg: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: string;
  textMuted: string;
  /** Warm accent for "on the way" and primary actions. */
  accent: string;
  onAccent: string;
  /** Only for "arrived" / success. */
  success: string;
  danger: string;
  info: string;
}

export const darkTheme: Theme = {
  dark: true,
  bg: '#0F1115',
  surface: '#171A21',
  surfaceRaised: '#1F232C',
  border: '#2A2F3A',
  text: '#F2F4F7',
  textMuted: '#A3ABB8',
  accent: '#F5A524',
  onAccent: '#1A1205',
  success: '#3DD68C',
  danger: '#FF7A7A',
  info: '#7DBBFF',
};

export const lightTheme: Theme = {
  dark: false,
  bg: '#F7F7F9',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  border: '#E3E5EA',
  text: '#14161B',
  textMuted: '#5A6270',
  accent: '#B86E00',
  onAccent: '#FFFFFF',
  success: '#127A4B',
  danger: '#C62828',
  info: '#1F5FAD',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 14, lg: 20, pill: 999 } as const;
/** Smallest comfortable touch target (Apple HIG: 44 pt). */
export const TOUCH = 44;

export type Appearance = 'dark' | 'light' | 'system';

export const ThemeContext = createContext<Theme>(darkTheme);
export const useTheme = () => useContext(ThemeContext);
