import 'reflect-metadata';
import { Logger, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app/app.module';
import { buildOpenApiDocument } from './app/openapi';
import { InvalidEnvironmentError, loadEnv } from './config/env';

const LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

async function bootstrap(): Promise<void> {
  // Fail fast, before anything else starts, if the config is incomplete.
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof InvalidEnvironmentError) {
      console.error(error.message); // names only, never values
      process.exit(1);
    }
    throw error;
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: LEVELS.slice(0, LEVELS.indexOf(env.LOG_LEVEL) + 1),
  });
  app.disable('x-powered-by');
  app.enableShutdownHooks();

  if (env.NODE_ENV !== 'production') {
    SwaggerModule.setup('docs', app, buildOpenApiDocument(app, process.env.npm_package_version ?? '0.0.0'));
  }

  await app.listen(env.PORT, '0.0.0.0');
  Logger.log(`Listening on port ${env.PORT} (${env.NODE_ENV})`, 'Bootstrap');
}

void bootstrap();
