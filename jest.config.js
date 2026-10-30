/**
 * For editors and `npx jest`: all three layers as Jest projects. The npm
 * scripts run each layer with its own config instead (see jest.shared.js).
 *
 * @type {import('jest').Config}
 */
module.exports = {
  projects: ['<rootDir>/jest.unit.config.js', '<rootDir>/jest.api.config.js', '<rootDir>/jest.int.config.js'],
};
