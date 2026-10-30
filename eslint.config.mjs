// ESLint flat config. Run with `npm run lint`; CI runs it on every pull request.
// Formatting is Prettier's job (`npm run format:check`), so no style rules here.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/', 'dist/', 'coverage/', 'src/generated/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Unused values are bugs, except deliberate placeholders named _x.
      // (No consistent-type-imports rule: with emitDecoratorMetadata, Nest needs
      // DTO classes imported as values, or request validation silently stops.)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
  {
    // Test helpers declare Jest matcher types on the global `jest` namespace.
    files: ['test/**/*.ts'],
    languageOptions: { globals: { ...globals.jest } },
    rules: { '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }] },
  },
  {
    // Entry points and setup scripts report progress on the console.
    files: ['src/main.ts', 'src/scripts/**/*.ts', 'test/integration/global-*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // The Jest configs are CommonJS.
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
