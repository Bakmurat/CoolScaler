import { createTheme } from '@mui/material/styles';

export const palette = {
  ink: '#171c2e',
  inkStrong: '#1e2536',
  muted: '#6b7390',
  line: '#e9eaf0',
  bg: '#f3f4f9',
  brand: '#6366f1',
  brand50: '#eef2ff',
  brand100: '#e0e7ff',
  brand700: '#4f46e5',
  good: '#22c55e',
  good50: '#f0fdf4',
  good100: '#dcfce7',
  good600: '#16a34a',
  bad: '#e11d48',
  sidebarBg: '#0d0d24',
  sidebarIdle: '#8b90b0',
  sidebarHoverBg: '#1c1c3a',
  sidebarHoverText: '#e4e7f2',
  sidebarActiveBg: '#4f46e5',
  sidebarInert: '#4c5273',
  sidebarGroupLabel: '#6d72d8',
} as const;

export const fontSans =
  '"Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, sans-serif';
export const fontMono =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace';

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: palette.brand, dark: palette.brand700, light: palette.brand100 },
    success: { main: palette.good, dark: palette.good600, light: palette.good100 },
    error: { main: palette.bad },
    background: { default: palette.bg, paper: '#ffffff' },
    text: { primary: palette.ink, secondary: palette.muted },
    divider: palette.line,
  },
  typography: {
    fontFamily: fontSans,
    h1: { letterSpacing: '-0.02em' },
    h2: { letterSpacing: '-0.02em' },
    h3: { letterSpacing: '-0.02em' },
    allVariants: { letterSpacing: '-0.01em' },
  },
  shape: { borderRadius: 12 },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          border: `1px solid ${palette.line}`,
          borderRadius: 16,
          boxShadow:
            '0 1px 2px rgba(16,24,40,.05), 0 1px 3px rgba(16,24,40,.04)',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: { textTransform: 'none', fontWeight: 600 },
      },
    },
  },
});
