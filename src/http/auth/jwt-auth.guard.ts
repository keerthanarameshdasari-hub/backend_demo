import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Missing bearer token');

    try {
      const payload = await this.jwt.verifyAsync<{ sub?: unknown }>(token);
      if (typeof payload.sub !== 'string') throw new Error('no subject');
      request.userId = payload.sub;
      return true;
    } catch {
      // Never echo the token or the verification error back.
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

/** The authenticated user's id, set by JwtAuthGuard. */
export const CurrentUserId = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const userId = context.switchToHttp().getRequest<AuthenticatedRequest>().userId;
  if (!userId) throw new UnauthorizedException();
  return userId;
});
