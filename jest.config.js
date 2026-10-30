/**
 * Run with `npm test`, which sets NODE_OPTIONS=--experimental-vm-modules:
 * NestJS 12 ships as ES modules only, and Jest needs that flag to require()
 * them from our CommonJS test files (plain Node 26 does it without a flag).
 *
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testRegex: '\\.(spec|e2e-spec|int-spec)\\.ts$',
  transform: {
    // 151002: ts-jest's notice about module "nodenext"; harmless here.
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: { ignoreCodes: [151002] } }],
  },
  // The generated Prisma client imports "./x.js" while the file on disk is x.ts.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/generated/**', '!src/main.ts', '!src/scripts/**'],
};
