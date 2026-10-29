import { defineConfig } from 'prisma/config';

// Used by the Prisma CLI (generate, migrate). The running API gets its URL
// from validated env config instead. `generate` doesn't need a database, so a
// missing DATABASE_URL is only an error for commands that connect.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
