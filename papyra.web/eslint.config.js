import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // The local-first editor deliberately conditionally setState()s inside the
      // remote-sync effect (caret protection) and reads the draft ref to seed the
      // recovery panel. These are intentional design patterns, not bugs — keep them
      // visible as warnings but don't fail the build/CI over them.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
  {
    // One tooltip for the whole app (components/TooltipLayer). The browser's own `title` tooltip is unstyled,
    // slow, mouse-only and unreadable on touch. Say `data-tooltip="…"` (and `data-tooltip-keys="Ctrl+B"` for a
    // shortcut) instead. An <iframe title> is its accessible name, not a tooltip, so it stays.
    files: ['**/*.tsx'],
    ignores: ['**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "JSXOpeningElement[name.type='JSXIdentifier'][name.name=/^[a-z]/][name.name!='iframe'] > JSXAttribute[name.name='title']",
          message: 'Use data-tooltip instead of title: the browser tooltip is replaced by <TooltipLayer>.',
        },
        {
          selector: "JSXOpeningElement[name.name=/^(Link|NavLink|BusyButton)$/] > JSXAttribute[name.name='title']",
          message: 'Use data-tooltip instead of title: the browser tooltip is replaced by <TooltipLayer>.',
        },
      ],
    },
  },
])
