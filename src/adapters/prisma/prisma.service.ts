import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import type { ReadinessProbe } from '../../domain';

/**
 * One Prisma client per process. Only warnings are logged. Errors are not:
 * their messages can quote query values, and they surface as exceptions anyway
 * (the HTTP error filter logs them without the message).
 */
export class PrismaDatabase implements ReadinessProbe {
  readonly name = 'database';
  readonly client: PrismaClient;

  constructor(databaseUrl: string) {
    this.client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
      log: [{ level: 'warn', emit: 'stdout' }],
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
