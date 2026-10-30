const shared = require('./jest.shared');

/**
 * Unit layer: no network, no database, no Docker. Domain services run against
 * the in-memory port fakes in test/fakes.ts. Coverage is measured on
 * src/domain only, and the run fails below 80% on any metric.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...shared,
  displayName: 'unit',
  roots: ['<rootDir>/test/unit'],
  testRegex: '\\.spec\\.ts$',
  collectCoverage: true,
  collectCoverageFrom: ['src/domain/**/*.ts'],
  coverageDirectory: 'coverage/unit',
  coverageReporters: ['text', 'text-summary', 'lcov'],
  coverageThreshold: {
    global: { statements: 80, branches: 80, functions: 80, lines: 80 },
  },
};
