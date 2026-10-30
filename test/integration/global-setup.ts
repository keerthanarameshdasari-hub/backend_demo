/**
 * Runs once before the integration suites.
 *
 * 1. Database: if TEST_DATABASE_URL is set (a CI service container, or a
 *    database you started yourself) it is used as is. Otherwise a throwaway
 *    Postgres is started with Testcontainers, on the same image as
 *    docker-compose.yml. That needs a running Docker daemon.
 * 2. Schema: the real migrations in prisma/migrations are applied with
 *    `prisma migrate deploy`, exactly as the compose `migrate` job and a
 *    production deploy do. The suites never create tables themselves.
 *
 * The suites empty the tables they use, so never point TEST_DATABASE_URL at
 * data you care about.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { composePostgresImage, prisma } from './environment';

declare global {
  var __INT_POSTGRES__: StartedPostgreSqlContainer | undefined;
}

export default async function globalSetup(): Promise<void> {
  let url = process.env.TEST_DATABASE_URL;

  if (url) {
    console.log('\n[int] Using the database in TEST_DATABASE_URL');
  } else {
    const image = composePostgresImage();
    console.log(`\n[int] Starting ${image.split('@')[0]} with Testcontainers…`);
    try {
      globalThis.__INT_POSTGRES__ = await new PostgreSqlContainer(image)
        .withDatabase('wallet_test')
        .withUsername('wallet')
        .withPassword('wallet')
        .start();
    } catch (error) {
      throw new Error(
        'Could not start Postgres with Testcontainers. Start Docker, or set TEST_DATABASE_URL to a ' +
          `throwaway database.\nCause: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    url = globalThis.__INT_POSTGRES__.getConnectionUri();
    // Jest starts its test workers after global setup, so they inherit this.
    process.env.TEST_DATABASE_URL = url;
  }

  console.log('[int] Applying migrations (prisma migrate deploy)…');
  try {
    prisma(['migrate', 'deploy'], url);
  } catch (error) {
    const output = (error as { stdout?: string; stderr?: string }).stdout ?? '';
    throw new Error(`prisma migrate deploy failed:\n${output}\n${(error as { stderr?: string }).stderr ?? ''}`, {
      cause: error,
    });
  }
}
