import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import type { ReadinessProbe } from '../../domain';

/**
 * One Prisma client per process. Logging is limited to warnings and errors
 * and never includes query parameters, so user data and secrets stay out of logs.
 */
export class PrismaDatabase implements ReadinessProbe {
  readonly name = 'database';
  readonly client: PrismaClient;

  constructor(databaseUrl: string) {
    this.client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
      log: [
        { level: 'warn', emit: 'stdout' },
        { level: 'error', emit: 'stdout' },
      ],
      errorFormat: 'minimal',
    });
  }

  async check(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }
}
