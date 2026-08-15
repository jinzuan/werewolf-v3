import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Legacy offline game files are not part of the V3 route graph. Keep the
    // exception file-scoped until their removal is tracked, while V3 shell,
    // pages, network, store, feature, and UI code stays in this gate.
    ignores: [
      'dist',
      'src.bak.v2.4.11-UI/**',
      'src/stores/gameStore.ts',
      'src/utils/**',
      'src/hooks/**',
      'src/components/ChatTabs.tsx',
      'src/components/DynamicBackground.tsx',
      'src/components/GameProgressPanel.tsx',
      'src/components/MessageStream.tsx',
      'src/components/MyRolePanel.tsx',
      'src/components/NightActionSheet.tsx',
      'src/components/PlayerCard.tsx',
      'src/components/WolfChatPanel.tsx',
      'src/components/WolfVoteModal.tsx',
      'src/pages/GameRoom.tsx',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
)
