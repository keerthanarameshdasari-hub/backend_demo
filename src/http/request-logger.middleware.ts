import { Logger, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * One line per request: method, path, status, duration and a request id.
 * Deliberately NOT logged: bodies, headers (Authorization), query strings.
 */
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const started = process.hrtime.bigint();
    const incoming = req.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', requestId);

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // req.path has no query string; originalUrl would.
      this.logger.log(`${req.method} ${req.baseUrl}${req.path} ${res.statusCode} ${ms.toFixed(1)}ms id=${requestId}`);
    });
    next();
  }
}
