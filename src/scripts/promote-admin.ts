/**
 * `npm run admin:promote -- <email>`: gives an existing account the ADMIN role.
 *
 * There is deliberately no HTTP endpoint for this: the first admin has to be
 * made by someone with database access (an operator running this against the
 * environment's DATABASE_URL), and admins can't create more admins over the API.
 * Needs the API's normal environment; only DATABASE_URL is actually used.
 */
import 'reflect-metadata';
import { PrismaUserRepository } from '../adapters/prisma/prisma-user.repository';
import { PrismaDatabase } from '../adapters/prisma/prisma.service';
import { InvalidEnvironmentError, loadEnv } from '../config/env';
import { DomainError, promoteToAdmin } from '../domain';

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npm run admin:promote -- <email>');
    process.exit(2);
  }

  const env = loadEnv();
  const db = new PrismaDatabase(env.DATABASE_URL);
  try {
    const user = await promoteToAdmin(new PrismaUserRepository(db), email);
    console.log(`${user.email} is now an ADMIN`);
  } finally {
    await db.disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof InvalidEnvironmentError || error instanceof DomainError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
