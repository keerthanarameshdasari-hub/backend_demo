/**
 * `npm run openapi`: writes openapi.json at the repo root with sorted keys.
 * Runs in Nest's preview mode, so no provider factory executes: no env
 * vars, database or S3 are needed.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from '../app/app.module';
import { buildOpenApiDocument, sortKeysDeep } from '../app/openapi';

async function main(): Promise<void> {
  const root = join(__dirname, '..', '..');
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

  const app = await NestFactory.create(AppModule, { preview: true, logger: false, abortOnError: false });
  const document = buildOpenApiDocument(app, version);
  await app.close();

  const out = join(root, 'openapi.json');
  writeFileSync(out, `${JSON.stringify(sortKeysDeep(document), null, 2)}\n`);
  console.log(`Wrote ${out}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
