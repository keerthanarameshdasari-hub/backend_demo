const shared = require('./jest.shared');

/**
 * API layer: the real Nest app (guards, pipes, filters, controllers, domain)
 * driven over HTTP with supertest. Persistence, storage and the external
 * providers are swapped for in-memory fakes through the DI port tokens, so
 * no Docker is needed.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...shared,
  displayName: 'api',
  roots: ['<rootDir>/test/api'],
  testRegex: '\\.api-spec\\.ts$',
};
