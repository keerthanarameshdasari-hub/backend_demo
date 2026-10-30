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
 * Error type, optional driver code (e.g. Prisma's P2002) and stack frames,
 * but not the message: messages from database or SDK errors can quote the
 * values that were sent, such as an email or a token.
 */
export function describeForLog(error: unknown): string {
  if (!(error instanceof Error)) return 'Non-error value thrown';
  const code = (error as { code?: unknown }).code;
  const head = typeof code === 'string' ? `${error.name} [${code}]` : error.name;
  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .join('\n');
  return frames ? `${head}\n${frames}` : head;
}

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

    this.logger.error(describeForLog(error));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, code: 'INTERNAL', message: 'Something went wrong' });
  }
}
