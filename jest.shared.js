/**
 * Settings shared by the three test layers. Each layer has its own config:
 *
 *   jest.unit.config.js  test/unit         domain + small units, in-memory fakes, coverage gate on src/domain
 *   jest.int.config.js   test/integration  Prisma adapters against a real, migrated Postgres
 *   jest.api.config.js   test/api          every HTTP endpoint through supertest
 *
 * Run them through the npm scripts (test:unit, test:int, test:api), which
 * start Jest with --experimental-vm-modules: NestJS 12 ships as ES modules
 * only, and Jest needs that flag to require() them from our CommonJS tests.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  transform: {
    // 151002: ts-jest's notice about module "nodenext"; harmless here.
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: { ignoreCodes: [151002] } }],
  },
  // The generated Prisma client imports "./x.js" while the file on disk is x.ts.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/support/matchers.ts'],
};
