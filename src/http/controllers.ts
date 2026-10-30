import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  ParseIntPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
  DefaultValuePipe,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ENV, READINESS_PROBES } from '../app/tokens';
import type { Env } from '../config/env';
import { KycService, type ReadinessProbe, UserService, WalletService } from '../domain';
import { CurrentUserId, JwtAuthGuard } from './auth/jwt-auth.guard';
import {
  ErrorResponse,
  HealthResponse,
  KycSubmissionForm,
  KycSubmissionResponse,
  LoginRequest,
  MinAppVersionResponse,
  ReadinessResponse,
  RegisterRequest,
  TokenResponse,
  TopUpRequest,
  TopUpResponse,
  TopUpResultResponse,
  UserResponse,
  WalletResponse,
} from './dto';

// ------------------------------------------------------------------ ops

@ApiTags('ops')
@Controller()
export class HealthController {
  constructor(@Inject(READINESS_PROBES) private readonly probes: ReadinessProbe[]) {}

  @Get('health')
  @ApiOperation({ summary: 'Liveness: the process is up. Touches no dependencies.' })
  @ApiOkResponse({ type: HealthResponse })
  health(): HealthResponse {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: the database is reachable.' })
  @ApiOkResponse({ type: ReadinessResponse })
  @ApiServiceUnavailableResponse({ type: ReadinessResponse })
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const checks = await Promise.all(
      this.probes.map(async (probe) => {
        try {
          await probe.check();
          return { name: probe.name, status: 'up' as const };
        } catch {
          return { name: probe.name, status: 'down' as const };
        }
      }),
    );
    const ready = checks.every((c) => c.status === 'up');
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ready' : 'not_ready', checks };
  }
}

@ApiTags('meta')
@Controller('meta')
export class MetaController {
  constructor(@Inject(ENV) private readonly env: Env) {}

  @Get('min-app-version')
  @ApiOperation({ summary: 'Minimum supported mobile app version; older apps should force an update.' })
  @ApiOkResponse({ type: MinAppVersionResponse })
  minAppVersion(): MinAppVersionResponse {
    return { minAppVersion: this.env.MIN_APP_VERSION };
  }
}

// ------------------------------------------------------------------ auth

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly users: UserService,
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('register')
  @ApiOperation({ summary: 'Create an account' })
  @ApiCreatedResponse({ type: UserResponse })
  @ApiConflictResponse({ type: ErrorResponse, description: 'Email already registered' })
  async register(@Body() body: RegisterRequest): Promise<UserResponse> {
    return UserResponse.from(await this.users.register(body));
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange email and password for an access token' })
  @ApiOkResponse({ type: TokenResponse })
  @ApiUnauthorizedResponse({ type: ErrorResponse })
  async login(@Body() body: LoginRequest): Promise<TokenResponse> {
    const user = await this.users.authenticate(body.email, body.password);
    const accessToken = await this.jwt.signAsync({ sub: user.id });
    return { accessToken, tokenType: 'Bearer', expiresIn: this.env.JWT_EXPIRES_IN_SECONDS };
  }
}

// ------------------------------------------------------------------ users

@ApiTags('users')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorResponse })
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UserService) {}

  @Get('me')
  @ApiOperation({ summary: 'The signed-in user' })
  @ApiOkResponse({ type: UserResponse })
  async me(@CurrentUserId() userId: string): Promise<UserResponse> {
    return UserResponse.from(await this.users.getProfile(userId));
  }
}

// ------------------------------------------------------------------ kyc

@ApiTags('kyc')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorResponse })
@UseGuards(JwtAuthGuard)
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Post()
  @UseInterceptors(FileInterceptor('document'))
  @ApiOperation({ summary: 'Submit an identity document for verification' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: KycSubmissionForm })
  @ApiCreatedResponse({
    type: KycSubmissionResponse,
    description: 'Submission recorded. `status` is APPROVED, REJECTED or TIMED_OUT (resubmit allowed).',
  })
  @ApiConflictResponse({ type: ErrorResponse, description: 'Already approved, or a submission is in progress' })
  async submit(
    @CurrentUserId() userId: string,
    @Body() form: KycSubmissionForm,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<KycSubmissionResponse> {
    if (!file) throw new BadRequestException('document file is required');
    const submission = await this.kyc.submit({
      userId,
      documentType: form.documentType,
      documentNumber: form.documentNumber,
      document: { bytes: new Uint8Array(file.buffer), mimeType: file.mimetype },
    });
    return KycSubmissionResponse.from(submission);
  }

  @Get()
  @ApiOperation({ summary: 'The latest KYC submission' })
  @ApiOkResponse({ type: KycSubmissionResponse })
  @ApiNotFoundResponse({ type: ErrorResponse })
  async latest(@CurrentUserId() userId: string): Promise<KycSubmissionResponse> {
    return KycSubmissionResponse.from(await this.kyc.latest(userId));
  }
}

// ------------------------------------------------------------------ wallet

@ApiTags('wallet')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorResponse })
@UseGuards(JwtAuthGuard)
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  @ApiOperation({ summary: 'Wallet balance' })
  @ApiOkResponse({ type: WalletResponse })
  async get(@CurrentUserId() userId: string): Promise<WalletResponse> {
    return WalletResponse.from(await this.wallet.getWallet(userId));
  }

  @Get('top-ups')
  @ApiOperation({ summary: 'Recent top-ups, newest first' })
  @ApiOkResponse({ type: [TopUpResponse] })
  async list(
    @CurrentUserId() userId: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<TopUpResponse[]> {
    return (await this.wallet.listTopUps(userId, limit)).map(TopUpResponse.from);
  }

  @Post('top-ups')
  @ApiOperation({ summary: 'Top up the wallet with a payment. Requires approved KYC.' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Retrying with the same key returns the original result instead of charging again.',
  })
  @ApiCreatedResponse({
    type: TopUpResultResponse,
    description: '`topUp.status` is SUCCEEDED, FAILED or TIMED_OUT. Only SUCCEEDED credits the wallet.',
  })
  @ApiOkResponse({ type: TopUpResultResponse, description: 'Replay of an earlier request with the same Idempotency-Key' })
  @ApiForbiddenResponse({ type: ErrorResponse, description: 'KYC not approved' })
  @ApiConflictResponse({ type: ErrorResponse, description: 'Idempotency-Key reused with a different amount' })
  async topUp(
    @CurrentUserId() userId: string,
    @Body() body: TopUpRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TopUpResultResponse> {
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must be 8-64 letters, digits, dashes or underscores');
    }
    const result = await this.wallet.topUp({ userId, ...body, idempotencyKey });
    res.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return { topUp: TopUpResponse.from(result.topUp), wallet: WalletResponse.from(result.wallet) };
  }
}

export const CONTROLLERS = [
  HealthController,
  MetaController,
  AuthController,
  UsersController,
  KycController,
  WalletController,
];
