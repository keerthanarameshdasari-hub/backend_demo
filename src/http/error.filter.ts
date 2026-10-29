import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError, type DomainErrorCode } from '../domain';

const STATUS: Record<DomainErrorCode, number> = {
  VALIDATION: HttpStatus.BAD_REQUEST,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
};

/**
 * Turns every error into `{ statusCode, code, message }`. Unexpected errors
 * become a generic 500: their details are logged (name and stack only, never
 * the request) and never sent to the client.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Error');

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (error instanceof DomainError) {
      res.status(STATUS[error.code]).json({ statusCode: STATUS[error.code], code: error.code, message: error.message });
      return;
    }

    if (error instanceof HttpException) {
      const status = error.getStatus();
      const body = error.getResponse();
      const raw = typeof body === 'string' ? body : (body as { message?: string | string[] }).message;
      const message = Array.isArray(raw) ? raw.join('; ') : (raw ?? error.message);
      res.status(status).json({ statusCode: status, code: HttpStatus[status] ?? 'ERROR', message });
      return;
    }

    this.logger.error(error instanceof Error ? (error.stack ?? error.name) : 'Non-error thrown');
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ statusCode: 500, code: 'INTERNAL', message: 'Something went wrong' });
  }
}
