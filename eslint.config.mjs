import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // docs/는 글과 로컬 전용 도구(.git/info/exclude)가 있는 곳이라 lint 대상이 아니다 — 로컬 `pnpm lint`가 CI와 같은 결과를 내게.
    ignores: ['**/dist/**', '**/node_modules/**', '**/.auth/**', 'docs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
