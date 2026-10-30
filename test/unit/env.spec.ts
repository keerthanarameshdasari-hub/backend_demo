import { InvalidEnvironmentError, loadEnv } from '../../src/config/env';
import { TEST_ENV } from '../test-env';

describe('loadEnv', () => {
  it('accepts a complete environment and coerces types', () => {
    const env = loadEnv(TEST_ENV);
    expect(env.PORT).toBe(3000);
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.PAYMENT_PROVIDER).toBe('mock');
  });

  it('lists every missing variable by name', () => {
    const { DATABASE_URL: _a, JWT_SECRET: _b, ...rest } = TEST_ENV;
    expect(() => loadEnv(rest)).toThrow(InvalidEnvironmentError);
    try {
      loadEnv(rest);
    } catch (error) {
      expect((error as InvalidEnvironmentError).problems).toEqual(['DATABASE_URL: is required', 'JWT_SECRET: is required']);
    }
  });

  it('treats an empty string as missing', () => {
    expect(() => loadEnv({ ...TEST_ENV, MIN_APP_VERSION: '' })).toThrow(/MIN_APP_VERSION: is required/);
  });

  it('never includes values in the error message', () => {
    const secret = 'too-short-secret-value';
    const dbUrl = 'mysql://user:hunter2@db/app';
    let message = '';
    try {
      loadEnv({ ...TEST_ENV, JWT_SECRET: secret, DATABASE_URL: dbUrl, PAYMENT_PROVIDER: 'stripe-live-xyz' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/JWT_SECRET/);
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/PAYMENT_PROVIDER/);
    for (const value of [secret, dbUrl, 'hunter2', 'stripe-live-xyz']) expect(message).not.toContain(value);
  });

  it('rejects an unknown adapter name', () => {
    expect(() => loadEnv({ ...TEST_ENV, KYC_PROVIDER: 'onfido' })).toThrow(/KYC_PROVIDER/);
  });

  it('requires S3 keys as a pair', () => {
    const { S3_SECRET_ACCESS_KEY: _s, ...rest } = TEST_ENV;
    expect(() => loadEnv(rest)).toThrow(/set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/);
    const { S3_ACCESS_KEY_ID: _k, ...neither } = rest;
    expect(() => loadEnv(neither)).not.toThrow();
  });
});
