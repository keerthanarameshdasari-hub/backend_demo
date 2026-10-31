import { type MiddlewareConsumer, Module, type NestModule, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { MulterModule } from '@nestjs/platform-express';
import type { Env } from '../config/env';
import { CONTROLLERS } from '../http/controllers';
import { AdminGuard } from '../http/auth/admin.guard';
import { JwtAuthGuard } from '../http/auth/jwt-auth.guard';
import { ErrorFilter } from '../http/error.filter';
import { RequestLoggerMiddleware } from '../http/request-logger.middleware';
import { AdaptersModule } from './adapters.module';
import { ConfigModule } from './config.module';
import { DomainModule } from './domain.module';
import { ENV } from './tokens';

@Module({
  imports: [
    ConfigModule,
    AdaptersModule,
    DomainModule,
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        secret: env.JWT_SECRET,
        signOptions: { algorithm: 'HS256', expiresIn: env.JWT_EXPIRES_IN_SECONDS, issuer: env.JWT_ISSUER },
        verifyOptions: { algorithms: ['HS256'], issuer: env.JWT_ISSUER },
      }),
    }),
    MulterModule.registerAsync({
      inject: [ENV],
      // Files stay in memory (they're small and go straight to storage). Multer
      // stops reading past the limit; the domain then rejects the oversized file.
      useFactory: (env: Env) => ({ limits: { fileSize: env.KYC_MAX_DOCUMENT_BYTES + 1, files: 1, fields: 10 } }),
    }),
  ],
  controllers: CONTROLLERS,
  providers: [
    JwtAuthGuard,
    AdminGuard,
    { provide: APP_FILTER, useClass: ErrorFilter },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*path');
  }
}
