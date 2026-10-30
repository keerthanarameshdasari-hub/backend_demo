/**
 * Where the test database is and how to run the Prisma CLI against it.
 * Kept free of app imports: global-setup.ts loads it outside Jest's module
 * mapping, where the generated Prisma client can't be resolved.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(__dirname, '..', '..');
export const MIGRATIONS_DIR = join(ROOT, 'prisma', 'migrations');

/** Set by global-setup.ts (Testcontainers) or by the caller (CI service container). */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set: run this suite with `npm run test:int`');
  return url;
}

/**
 * The Postgres image docker-compose.yml uses, so the tests run on exactly the
 * version (and digest) the app runs on. One place to bump it.
 */
export function composePostgresImage(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  const match = /^\s{2}postgres:\s*\n\s+image:\s*(\S+)/m.exec(compose);
  if (!match?.[1]) throw new Error('Could not find the postgres image in docker-compose.yml');
  return match[1];
}

/** Runs the project's own Prisma CLI against the test database. Throws (with output) on a non-zero exit. */
export function prisma(args: string[], url = testDatabaseUrl()): string {
  return execFileSync(process.execPath, [join(ROOT, 'node_modules', 'prisma', 'build', 'index.js'), ...args], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
