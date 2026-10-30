/**
 * The migrations themselves: they applied cleanly, they produce exactly what
 * prisma/schema.prisma describes, and the hand-written down.sql reverses them.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaDatabase } from '../../src/adapters/prisma/prisma.service';
import { connect, MIGRATIONS_DIR, prisma } from './database';

const migrationNames = readdirSync(MIGRATIONS_DIR)
  .filter((name) => statSync(join(MIGRATIONS_DIR, name)).isDirectory())
  .sort();

let db: PrismaDatabase;
beforeAll(() => (db = connect()));
afterAll(async () => db.disconnect());

describe('prisma migrations', () => {
  it('applied every migration in prisma/migrations, successfully and in order', async () => {
    const rows = await db.client.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at, migration_name`;
    expect(rows.map((r) => r.migration_name)).toEqual(migrationNames);
    expect(rows.every((r) => r.finished_at !== null && r.rolled_back_at === null)).toBe(true);
  });

  it('report no pending migrations', () => {
    expect(prisma(['migrate', 'status'])).toMatch(/Database schema is up to date/);
  });

  it('produce exactly the schema in schema.prisma (no drift)', () => {
    // --exit-code: 0 = no difference, 2 = difference (execFileSync throws with the diff in stdout).
    expect(() =>
      prisma(['migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code']),
    ).not.toThrow();
  });

  it('create the constraints the adapters rely on', async () => {
    const indexes = await db.client.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`;
    const byName = Object.fromEntries(indexes.map((i) => [i.indexname, i.indexdef]));
    expect(byName.users_email_key).toMatch(/UNIQUE INDEX .* \(email\)/);
    expect(byName.top_ups_user_id_idempotency_key_key).toMatch(/UNIQUE INDEX .* \(user_id, idempotency_key\)/);

    const fks = await db.client.$queryRaw<{ table_name: string; delete_rule: string }[]>`
      SELECT tc.table_name, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      ORDER BY tc.table_name`;
    expect(fks).toEqual([
      { table_name: 'kyc_submissions', delete_rule: 'CASCADE' },
      { table_name: 'top_ups', delete_rule: 'CASCADE' },
      { table_name: 'wallets', delete_rule: 'CASCADE' },
    ]);
  });

  it('can be reversed with down.sql and applied again', async () => {
    const tables = async () =>
      (
        await db.client.$queryRaw<{ tablename: string }[]>`
          SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`
      ).map((t) => t.tablename);
    expect(await tables()).toEqual(['kyc_submissions', 'top_ups', 'users', 'wallets']);

    // Newest first, as an operator would roll back.
    for (const name of [...migrationNames].reverse()) {
      prisma(['db', 'execute', '--file', join('prisma', 'migrations', name, 'down.sql')]);
    }
    expect(await tables()).toEqual([]);

    prisma(['migrate', 'deploy']);
    expect(await tables()).toEqual(['kyc_submissions', 'top_ups', 'users', 'wallets']);
  });
});
