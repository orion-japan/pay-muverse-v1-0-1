/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', project: false },
  plugins: ['@typescript-eslint'],
  extends: ['next/core-web-vitals', 'eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: [
    // ビルド成果物など
    '.next/**',
    'dist/**',
    'out/**',
    // テスト生成物・ユーティリティ
    'coverage/**',
    // 旧資産・未移行
    'src/lib_unused/**',
  ],
  rules: {
    // 先頭が _ の変数/引数は未使用許容
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      },
    ],
    // 自動修正系
    'prefer-const': 'error',
    'no-useless-escape': 'error',
    'no-irregular-whitespace': 'error',
    'no-var': 'error',

    // 空ブロック: catch {} は許可
    'no-empty': ['error', { allowEmptyCatch: true }],
  },

  overrides: [
    // サービスワーカーや純JSは最低限チェック
    {
      files: ['**/*.js'],
      rules: {
        'no-undef': 'off', // sw.js などの 'self' 警告を抑える（型定義が無いJSのため）
      },
    },
    // まず Iros 周りは厳しめのまま（品質担保）
    {
      files: ['src/ui/iroschat/**/*', 'src/app/iros*/**/*'],
      rules: {
        // 必要ならここだけ厳格化を追加
      },
    },
    // 大量の既存ページは一旦緩める：空ブロック許容
    {
      files: ['src/app/**/*', 'src/components/**/*', 'src/lib/**/*'],
      excludedFiles: ['src/ui/iroschat/**/*', 'src/app/iros*/**/*'],
      rules: {
        'no-empty': ['warn', { allowEmptyCatch: true }],
      },
    },
  ],
};
