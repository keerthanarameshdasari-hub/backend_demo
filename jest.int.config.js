const shared = require('./jest.shared');

/**
 * Integration layer: the Prisma adapters against a real Postgres with the
 * real migrations applied. test/integration/global-setup.ts either starts a
 * throwaway Postgres with Testcontainers (needs Docker) or, when
 * TEST_DATABASE_URL is set (a CI service container), uses that database.
 * Either way it runs `prisma migrate deploy` before any test.
 *
 * One worker: the suites share one database and empty it between tests.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...shared,
  displayName: 'int',
  roots: ['<rootDir>/test/integration'],
  testRegex: '\\.int-spec\\.ts$',
  globalSetup: '<rootDir>/test/integration/global-setup.ts',
  globalTeardown: '<rootDir>/test/integration/global-teardown.ts',
  maxWorkers: 1,
  testTimeout: 30_000,
};
