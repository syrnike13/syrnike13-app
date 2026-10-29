import css from '@eslint/css'
import { plugin as shadcn } from '@shadcn/lint'
import tsParser from '@typescript-eslint/parser'
import { defineConfig } from 'eslint/config'

import {
  designCssPlugin,
  designPlugin,
} from './tooling/eslint-plugin-design/index.mjs'

/**
 * Design-system lint (`pnpm lint:design`). Screens are built from
 * @syrnike13/ui primitives and never restyle them; a new look is a variant in
 * packages/ui. Policy: packages/ui/AGENTS.md. No baseline: every finding is a
 * violation; a deliberate exception is
 * `// eslint-disable-next-line <rule> -- <reason>` on that line only.
 */
const SOURCES = [
  'apps/web/src/**/*.{ts,tsx}',
  'apps/landing/src/**/*.{ts,tsx}',
  'apps/admin/src/**/*.{ts,tsx}',
  'packages/ui/src/**/*.{ts,tsx}',
]
const STYLES = [
  'apps/web/src/**/*.css',
  'apps/landing/src/**/*.css',
  'apps/admin/src/**/*.css',
]

const ICON_LIBRARIES = [
  '@remixicon/react',
  '@iconify/react',
  'iconoir-react',
  'iconoir-react/solid',
  'lucide-react',
].map((name) => ({
  name,
  message: 'Icons come from the registry: @syrnike13/ui/icons or the app-local components/icons.',
}))

const RAW_SLIDER = {
  name: '@syrnike13/ui/primitives/slider',
  message:
    'Settings sliders use PresetSlider (#/components/ui/preset-slider); the Slider primitive is its internal base.',
}

export default defineConfig([
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.output/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
      '**/*.gen.ts',
      '**/*.d.ts',
      '**/messages/**',
      '**/test-fixtures/**',
      '**/test-utils/**',
      '**/test/**',
      // Literal shadcn base-nova sources: they define the look the rules protect.
      'packages/ui/src/primitives/**',
      // Literal upstream Prism sources: keep the vendored library byte-for-byte.
      'packages/ui/src/tokens/prism/**',
    ],
  },
  {
    files: SOURCES,
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: { shadcn, design: designPlugin },
    settings: {
      shadcn: {
        ui: '@syrnike13/ui/primitives',
        mergeFunctions: ['cn'],
        variantFunctions: ['cva'],
        note: 'Design rules: packages/ui/AGENTS.md; client metrics: docs/client-metrics-reference.md.',
      },
    },
    rules: {
      'design/no-restyle': 'error',
      'design/no-lookalike': 'error',
      // Brand, units, key names and protocol terms read the same in every locale.
      'design/no-hardcoded-text': [
        'error',
        { allow: ['syrnike13', 'nightly', 'FPS', 'dB', 'esc', 'Ctrl', 'K', '@everyone', 'Chromium / Node', 'AKA', '/.proxy/'] },
      ],
      'design/require-disable-reason': 'error',
      'shadcn/no-raw-colors': 'error',
      'shadcn/no-arbitrary-values': 'error',
      'shadcn/no-inline-styles': 'error',
      'shadcn/require-static-classes': 'error',
      // Electron marker class styled by the native window shell, not by Tailwind.
      'shadcn/no-unknown-classes': [
        'error',
        { allow: ['shell-title-bar-window-controls'] },
      ],
      'no-restricted-imports': ['error', { paths: ICON_LIBRARIES }],
    },
  },
  {
    files: [
      'packages/ui/src/icons/**',
      'apps/web/src/components/icons/**',
      'apps/landing/src/components/icons.tsx',
      'apps/landing/src/components/icons/**',
      'apps/admin/src/components/icons.ts',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: [
      'apps/web/src/components/{settings,sounds,notifications,channels,servers}/**/*.tsx',
    ],
    rules: {
      'no-restricted-imports': ['error', { paths: [...ICON_LIBRARIES, RAW_SLIDER] }],
    },
  },
  {
    // Developer-only surfaces (DEV overlay, component gallery, RTC stats) are not
    // localised and lay out raw diagnostics rather than product UI.
    files: [
      'apps/web/src/features/dev-tools/**',
      'apps/web/src/features/ui-gallery/**',
      'apps/web/src/routes/dev/**',
      'apps/web/src/components/voice/voice-rtc-debug-view.tsx',
      'apps/landing/src/components/landing/landing-game-homages/**',
    ],
    rules: {
      'design/no-hardcoded-text': 'off',
      'design/no-restyle': 'off',
      'design/no-lookalike': 'off',
    },
  },
  {
    // SVG masks use white/black as alpha semantics, not as theme colours.
    files: [
      'apps/web/src/components/icons/restricted-text-channel-icon.tsx',
      'apps/web/src/components/icons/restricted-voice-channel-icon.tsx',
    ],
    rules: { 'shadcn/no-raw-colors': 'off' },
  },
  {
    files: STYLES,
    language: 'css/css',
    languageOptions: { tolerant: true },
    plugins: { css, 'design-css': designCssPlugin },
    rules: {
      'design-css/no-primitive-selectors': 'error',
      'design-css/no-raw-colors': 'error',
    },
  },
])
