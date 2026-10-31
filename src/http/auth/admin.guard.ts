import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AdminService } from '../../domain';
import type { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * Lets the request through only if the signed-in user is an ADMIN. Must run
 * after JwtAuthGuard. The role is read from the database on every request
 * rather than trusted from the token, so demoting an admin takes effect at
 * once instead of when their token expires.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly admin: AdminService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const userId = context.switchToHttp().getRequest<AuthenticatedRequest>().userId;
    if (!userId) throw new UnauthorizedException();
    await this.admin.assertAdmin(userId); // throws ForbiddenError -> 403
    return true;
  }
}
