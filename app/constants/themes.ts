// Lunel Design System - Theme Tokens
// Based on DESIGN.md - "Depth Through Color, Not Lines"

export type ThemeId =
  | 'light'
  | 'dark';
export type ThemeOption = ThemeId | 'system';

// =============================================================================
// Typography
// =============================================================================

export interface ThemeFonts {
  sans: {
    regular: string | undefined;
    medium: string | undefined;
    semibold: string | undefined;
    bold: string | undefined;
  };
  mono: {
    regular: string;
    medium: string;
    bold: string;
  };
  display: string;
}

// Font family definitions - maps to expo-google-fonts names
export type NormalFamilyId =
  // System
  | 'os-default'
  // Sans serif
  | 'inter' | 'roboto' | 'ibm-plex-sans' | 'source-sans' | 'dm-sans'
  // Serif
  | 'merriweather' | 'lora' | 'playfair-display' | 'ibm-plex-serif' | 'source-serif'
  // Monospace
  | 'jetbrains-mono' | 'fira-code' | 'source-code-pro' | 'ibm-plex-mono' | 'dm-mono';

export type MonoFamilyId = 'jetbrains-mono' | 'fira-code' | 'source-code-pro' | 'ibm-plex-mono' | 'dm-mono';
export type DisplayFamilyId = 'khand' | 'orbitron' | 'space-grotesk';

export interface NormalFamily {
  id: NormalFamilyId;
  name: string;
  regular: string | undefined;
  medium: string | undefined;
  semibold: string | undefined;
  bold: string | undefined;
}

export interface MonoFamily {
  id: MonoFamilyId;
  name: string;
  regular: string;
  medium: string;
  bold: string;
}

export interface DisplayFamily {
  id: DisplayFamilyId;
  name: string;
  font: string;
}

// Normal font families (sans, serif, and mono - all available for normal text)
export const normalFamilies: Record<NormalFamilyId, NormalFamily> = {
  // Default app font
  'ibm-plex-sans': {
    id: 'ibm-plex-sans',
    name: 'IBM Plex Sans',
    regular: 'IBMPlexSans_400Regular',
    medium: 'IBMPlexSans_500Medium',
    semibold: 'IBMPlexSans_600SemiBold',
    bold: 'IBMPlexSans_700Bold',
  },
  // OS default font (SF Pro on iOS, Roboto on Android)
  'os-default': {
    id: 'os-default',
    name: 'OS Default',
    regular: undefined,
    medium: undefined,
    semibold: undefined,
    bold: undefined,
  },
  // Sans serif
  'inter': {
    id: 'inter',
    name: 'Inter',
    regular: 'Inter_400Regular',
    medium: 'Inter_500Medium',
    semibold: 'Inter_600SemiBold',
    bold: 'Inter_700Bold',
  },
  'roboto': {
    id: 'roboto',
    name: 'Roboto',
    regular: 'Roboto_400Regular',
    medium: 'Roboto_500Medium',
    semibold: 'Roboto_500Medium',
    bold: 'Roboto_700Bold',
  },
  'source-sans': {
    id: 'source-sans',
    name: 'Source Sans 3',
    regular: 'SourceSans3_400Regular',
    medium: 'SourceSans3_500Medium',
    semibold: 'SourceSans3_600SemiBold',
    bold: 'SourceSans3_700Bold',
  },
  'dm-sans': {
    id: 'dm-sans',
    name: 'DM Sans',
    regular: 'DMSans_400Regular',
    medium: 'DMSans_500Medium',
    semibold: 'DMSans_600SemiBold',
    bold: 'DMSans_700Bold',
  },
  // Serif
  'merriweather': {
    id: 'merriweather',
    name: 'Merriweather',
    regular: 'Merriweather_400Regular',
    medium: 'Merriweather_400Regular',
    semibold: 'Merriweather_700Bold',
    bold: 'Merriweather_900Black',
  },
  'lora': {
    id: 'lora',
    name: 'Lora',
    regular: 'Lora_400Regular',
    medium: 'Lora_500Medium',
    semibold: 'Lora_600SemiBold',
    bold: 'Lora_700Bold',
  },
  'playfair-display': {
    id: 'playfair-display',
    name: 'Playfair Display',
    regular: 'PlayfairDisplay_400Regular',
    medium: 'PlayfairDisplay_500Medium',
    semibold: 'PlayfairDisplay_600SemiBold',
    bold: 'PlayfairDisplay_700Bold',
  },
  'ibm-plex-serif': {
    id: 'ibm-plex-serif',
    name: 'IBM Plex Serif',
    regular: 'IBMPlexSerif_400Regular',
    medium: 'IBMPlexSerif_500Medium',
    semibold: 'IBMPlexSerif_600SemiBold',
    bold: 'IBMPlexSerif_700Bold',
  },
  'source-serif': {
    id: 'source-serif',
    name: 'Source Serif 4',
    regular: 'SourceSerif4_400Regular',
    medium: 'SourceSerif4_500Medium',
    semibold: 'SourceSerif4_600SemiBold',
    bold: 'SourceSerif4_700Bold',
  },
  // Monospace
  'jetbrains-mono': {
    id: 'jetbrains-mono',
    name: 'JetBrains Mono',
    regular: 'JetBrainsMono_400Regular',
    medium: 'JetBrainsMono_500Medium',
    semibold: 'JetBrainsMono_500Medium',
    bold: 'JetBrainsMono_700Bold',
  },
  'fira-code': {
    id: 'fira-code',
    name: 'Fira Code',
    regular: 'FiraCode_400Regular',
    medium: 'FiraCode_500Medium',
    semibold: 'FiraCode_500Medium',
    bold: 'FiraCode_700Bold',
  },
  'source-code-pro': {
    id: 'source-code-pro',
    name: 'Source Code Pro',
    regular: 'SourceCodePro_400Regular',
    medium: 'SourceCodePro_500Medium',
    semibold: 'SourceCodePro_500Medium',
    bold: 'SourceCodePro_700Bold',
  },
  'ibm-plex-mono': {
    id: 'ibm-plex-mono',
    name: 'IBM Plex Mono',
    regular: 'IBMPlexMono_400Regular',
    medium: 'IBMPlexMono_500Medium',
    semibold: 'IBMPlexMono_500Medium',
    bold: 'IBMPlexMono_700Bold',
  },
  'dm-mono': {
    id: 'dm-mono',
    name: 'DM Mono',
    regular: 'DMMono_400Regular',
    medium: 'DMMono_500Medium',
    semibold: 'DMMono_500Medium',
    bold: 'DMMono_500Medium',
  },
};

// Monospace font families (for code)
export const monoFamilies: Record<MonoFamilyId, MonoFamily> = {
  'jetbrains-mono': {
    id: 'jetbrains-mono',
    name: 'JetBrains Mono',
    regular: 'JetBrainsMono_400Regular',
    medium: 'JetBrainsMono_500Medium',
    bold: 'JetBrainsMono_700Bold',
  },
  'fira-code': {
    id: 'fira-code',
    name: 'Fira Code',
    regular: 'FiraCode_400Regular',
    medium: 'FiraCode_500Medium',
    bold: 'FiraCode_700Bold',
  },
  'source-code-pro': {
    id: 'source-code-pro',
    name: 'Source Code Pro',
    regular: 'SourceCodePro_400Regular',
    medium: 'SourceCodePro_500Medium',
    bold: 'SourceCodePro_700Bold',
  },
  'ibm-plex-mono': {
    id: 'ibm-plex-mono',
    name: 'IBM Plex Mono',
    regular: 'IBMPlexMono_400Regular',
    medium: 'IBMPlexMono_500Medium',
    bold: 'IBMPlexMono_700Bold',
  },
  'dm-mono': {
    id: 'dm-mono',
    name: 'DM Mono',
    regular: 'DMMono_400Regular',
    medium: 'DMMono_500Medium',
    bold: 'DMMono_500Medium', // DM Mono doesn't have bold, use medium
  },
};

// Display font families
export const displayFamilies: Record<DisplayFamilyId, DisplayFamily> = {
  'khand': {
    id: 'khand',
    name: 'Khand',
    font: 'Khand_600SemiBold',
  },
  'orbitron': {
    id: 'orbitron',
    name: 'Orbitron',
    font: 'Orbitron_700Bold',
  },
  'space-grotesk': {
    id: 'space-grotesk',
    name: 'Space Grotesk',
    font: 'SpaceGrotesk_700Bold',
  },
};

// Font selection state
export interface FontSelection {
  normal: NormalFamilyId;
  mono: MonoFamilyId;
  display: DisplayFamilyId;
}

export const DEFAULT_FONT_SELECTION: FontSelection = {
  normal: 'ibm-plex-sans',
  mono: 'jetbrains-mono',
  display: 'khand',
};

export function normalizeFontSelection(selection: Partial<FontSelection> | null | undefined): FontSelection {
  const normal = selection?.normal && selection.normal in normalFamilies
    ? selection.normal
    : DEFAULT_FONT_SELECTION.normal;
  const mono = selection?.mono && selection.mono in monoFamilies
    ? selection.mono
    : DEFAULT_FONT_SELECTION.mono;
  const display = selection?.display && selection.display in displayFamilies
    ? selection.display
    : DEFAULT_FONT_SELECTION.display;

  return { normal, mono, display };
}

// Helper to build ThemeFonts from selection
export function buildFonts(selection: FontSelection): ThemeFonts {
  const normalized = normalizeFontSelection(selection);
  const normal = normalFamilies[normalized.normal];
  const mono = monoFamilies[normalized.mono];
  const display = displayFamilies[normalized.display];

  return {
    sans: {
      regular: normal.regular,
      medium: normal.medium,
      semibold: normal.semibold,
      bold: normal.bold,
    },
    mono: {
      regular: mono.regular,
      medium: mono.medium,
      bold: mono.bold,
    },
    display: display.font,
  };
}

// Default fonts (using default selection)
export const fonts: ThemeFonts = buildFonts(DEFAULT_FONT_SELECTION);

export interface ThemeTypography {
  caption: number;
  list: number;
  subHeading: number;
  body: number;
  heading: number;
}

export const typography: ThemeTypography = {
  caption: 11,
  list: 12,
  subHeading: 13,
  body: 14,
  heading: 15,
};

// =============================================================================
// Spacing (4px base grid)
// =============================================================================

export interface ThemeSpacing {
  0: number;
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
  6: number;
  7: number;
  8: number;
}

export const spacing: ThemeSpacing = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
  7: 48,
  8: 64,
};

// =============================================================================
// Radius
// =============================================================================

export interface ThemeRadius {
  none: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  '2xl': number;
  full: number;
}

export const radius: ThemeRadius = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 24,
  full: 9999,
};

// =============================================================================
// Color System
// =============================================================================

export interface ThemeColors {
  // Background layers (depth through color)
  bg: {
    base: string;       // Page canvas
    raised: string;     // Cards, inputs, sidebars
    elevated: string;   // Slightly brighter than raised — popovers, dropdowns
  };

  // Foreground/text (use opacity for hierarchy)
  fg: {
    default: string;    // 100% - Primary text
    muted: string;      // 60% - Secondary text
    subtle: string;     // 40% - Tertiary text
    disabled: string;   // 25% - Disabled text
  };

  // Border
  border: {
    main: string;
    secondary: string;
    tertiary: string;
  };

  // Accent color
  accent: {
    default: string;
  };

  // Blue color
  blue: string;

  // Git status colors
  git: {
    added: string;       // lighter green — staged/added files, push, HEAD
    modified: string;    // yellow — modified files
    deleted: string;     // red — deleted files
    info: string;        // blue — hashes, pull
  };

  // Terminal colors
  terminal: {
    bg: string;
    fg: string;
    cursor: string;
    selection: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
}

// =============================================================================
// Theme Definitions
// =============================================================================

const lightTheme: ThemeColors = {
  bg: {
    base: '#ffffff',
    raised: '#F5F5F5',
    elevated: '#F9F9F9',
  },
  fg: {
    default: '#0a0a0a',
    muted: '#555555',
    subtle: '#767676',
    disabled: '#aaaaaa',
  },
  border: {
    main: '#aaaaaa',
    secondary: '#aaaaaa80',
    tertiary: '#aaaaaa60',
  },
  accent: {
    default: '#6161F2',
  },
  blue: '#3b82f6',
  git: {
    added: '#22c55e',
    modified: '#f59e0b',
    deleted: '#ef4444',
    info: '#3b82f6',
  },
  terminal: {
    bg: '#ffffff',
    fg: '#0a0a0a',
    cursor: '#0a0a0a',
    selection: '#6366f130',
    black: '#0a0a0a',
    red: '#dc2626',
    green: '#16a34a',
    yellow: '#ca8a04',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: '#f0f0f0',
    brightBlack: '#666666',
    brightRed: '#ef4444',
    brightGreen: '#22c55e',
    brightYellow: '#eab308',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#06b6d4',
    brightWhite: '#ffffff',
  },
};

const darkTheme: ThemeColors = {
  bg: {
    base: '#161616',
    raised: '#212121',
    elevated: '#2A2A2A',
  },
  fg: {
    default: '#fafafa',
    muted: '#c0c0c0',
    subtle: '#9e9e9e',
    disabled: '#666666',
  },
  border: {
    main: '#575757',
    secondary: '#57575780',
    tertiary: '#57575760',
  },
  accent: {
    default: '#6161F2',
  },
  blue: '#60a5fa',
  git: {
    added: '#4ade80',
    modified: '#fbbf24',
    deleted: '#f87171',
    info: '#60a5fa',
  },
  terminal: {
    bg: '#161616',
    fg: '#d4d4d4',
    cursor: '#fafafa',
    selection: '#818cf830',
    black: '#111111',
    red: '#f07178',
    green: '#a5d6a7',
    yellow: '#ffcb6b',
    blue: '#82aaff',
    magenta: '#c792ea',
    cyan: '#89ddff',
    white: '#d4d4d4',
    brightBlack: '#545454',
    brightRed: '#ff8a80',
    brightGreen: '#b9f6ca',
    brightYellow: '#ffe57f',
    brightBlue: '#80d8ff',
    brightMagenta: '#ea80fc',
    brightCyan: '#a7ffeb',
    brightWhite: '#fafafa',
  },
};

// =============================================================================
// Theme Registry
// =============================================================================

export const themes: Record<ThemeId, ThemeColors> = {
  'light': lightTheme,
  'dark': darkTheme,
};

export const themeLabels: Record<ThemeOption, string> = {
  'system': 'System Default',
  'light': 'Light',
  'dark': 'Dark',
};

export const themeDescriptions: Record<ThemeOption, string> = {
  'system': 'Follows your device appearance setting',
  'light': 'Light theme',
  'dark': 'Dark theme',
};

// =============================================================================
// Utilities
// =============================================================================

export function isDarkTheme(themeId: ThemeId): boolean {
  return themeId === 'dark';
}

export function getTheme(themeId: ThemeId): ThemeColors {
  return themes[themeId];
}

export function isValidTheme(theme: string): theme is ThemeOption {
  return theme === 'system' || theme in themes;
}

// Get Prism token colors from theme
export function getPrismTokenColors(colors: ThemeColors): Record<string, string> {
  return {
    'keyword': colors.accent.default,
    'string': colors.git.added,
    'comment': colors.fg.subtle,
    'function': colors.blue,
    'number': colors.blue,
    'operator': colors.fg.muted,
    'punctuation': colors.fg.muted,
    'class-name': colors.blue,
    'boolean': colors.accent.default,
    'property': colors.fg.default,
    'tag': colors.accent.default,
    'attr-name': colors.blue,
    'attr-value': colors.git.added,
    'builtin': colors.blue,
    'char': colors.git.added,
    'constant': colors.blue,
    'deleted': colors.git.deleted,
    'doctype': colors.fg.subtle,
    'entity': colors.accent.default,
    'important': colors.accent.default,
    'inserted': colors.git.added,
    'namespace': colors.blue,
    'prolog': colors.fg.subtle,
    'regex': colors.git.modified,
    'selector': colors.accent.default,
    'symbol': colors.blue,
    'variable': colors.fg.default,
    'parameter': colors.fg.default,
    'template-string': colors.git.added,
    'template-punctuation': colors.fg.muted,
    'interpolation-punctuation': colors.accent.default,
    'default': colors.fg.default,
  };
}
