import { plugin as shadcn } from '@shadcn/lint'
import tsParser from '@typescript-eslint/parser'
import { defineConfig } from 'eslint/config'

/**
 * Design-system linting for Tailwind v4.
 * Rules and policy: packages/ui/AGENTS.md, DESIGN.md.
 * Discord metrics reference: docs/discord-design-reference.md.
 */
// `packages/ui/src/primitives` contains literal shadcn base-nova sources and is
// checked by tooling/scripts/check-ui.mjs, not by this linter.
const UI_SCOPES = [
  'apps/web/src/**/*.{ts,tsx}',
  'apps/admin/src/**/*.{ts,tsx}',
]

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
    ],
  },
  {
    files: UI_SCOPES,
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: { shadcn },
    settings: {
      shadcn: {
        ui: '@syrnike13/ui/primitives',
        mergeFunctions: ['cn'],
        variantFunctions: ['cva'],
        note: 'Design rules: packages/ui/AGENTS.md, DESIGN.md; Discord reference: docs/discord-design-reference.md.',
      },
    },
    rules: {
      'shadcn/no-raw-colors': 'error',
      'shadcn/no-arbitrary-values': 'error',
      // Electron marker class styled by the native window shell, not by Tailwind.
      'shadcn/no-unknown-classes': [
        'error',
        { allow: ['shell-title-bar-window-controls'] },
      ],
      'shadcn/require-static-classes': 'error',
      'shadcn/no-inline-styles': 'error',
      // `no-restyle` is intentionally off: tooling/scripts/check-ui.mjs already
      // enforces this repository's exact policy (layout + text tokens allowed).
    },
  },
  {
    // SVG masks use white/black as alpha semantics, not as theme colors.
    files: [
      'apps/web/src/components/icons/restricted-text-channel-icon.tsx',
      'apps/web/src/components/icons/restricted-voice-channel-icon.tsx',
    ],
    rules: {
      'shadcn/no-raw-colors': 'off',
    },
  },
])
