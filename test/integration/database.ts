/** Test-side database access for the integration suites. */
import { PrismaDatabase } from '../../src/adapters/prisma/prisma.service';
import { testDatabaseUrl } from './environment';

export * from './environment';

export function connect(): PrismaDatabase {
  return new PrismaDatabase(testDatabaseUrl());
}

/** Empties every app table. Every row hangs off a user, so CASCADE covers them all. */
export async function truncateAll(db: PrismaDatabase): Promise<void> {
  await db.client.$executeRawUnsafe('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
}
