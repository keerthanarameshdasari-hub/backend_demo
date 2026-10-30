import { Global, Module } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { ENV } from './tokens';

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
