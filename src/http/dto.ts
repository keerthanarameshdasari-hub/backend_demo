/**
 * Request/response shapes for the HTTP API. They also drive openapi.json, so
 * changing one here changes the published contract: keep changes additive.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import {
  DOCUMENT_TYPES,
  KYC_STATUSES,
  type KycSubmission,
  MIN_PASSWORD_LENGTH,
  type PublicUser,
  TOP_UP_STATUSES,
  type TopUp,
  type Wallet,
} from '../domain';

// ------------------------------------------------------------------ auth

export class RegisterRequest {
  @ApiProperty({ example: 'asha@example.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: MIN_PASSWORD_LENGTH, example: 'correct-horse-battery' })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ example: 'Asha Rao' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName!: string;
}

export class LoginRequest {
  @ApiProperty({ example: 'asha@example.com' })
  @IsString()
  @IsNotEmpty()
  email!: string;

  @ApiProperty({ example: 'correct-horse-battery' })
  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class TokenResponse {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty({ enum: ['Bearer'] })
  tokenType!: 'Bearer';

  @ApiProperty({ description: 'Lifetime in seconds' })
  expiresIn!: number;
}

// ------------------------------------------------------------------ users

export class UserResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ enum: KYC_STATUSES }) kycStatus!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;

  static from(user: PublicUser): UserResponse {
    return { ...user, createdAt: user.createdAt.toISOString() };
  }
}

// ------------------------------------------------------------------ kyc

/** Multipart form fields that come with the uploaded document. */
export class KycSubmissionForm {
  @ApiProperty({ enum: DOCUMENT_TYPES })
  @IsIn(DOCUMENT_TYPES)
  documentType!: string;

  @ApiProperty({
    example: 'P1234567',
    description: 'With the mock provider, a number starting REJECT is rejected and TIMEOUT never answers.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  documentNumber!: string;

  @ApiProperty({ type: 'string', format: 'binary', description: 'JPEG, PNG or PDF' })
  @IsOptional() // arrives as a file part, not a body field
  document?: unknown;
}

export class KycSubmissionResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: DOCUMENT_TYPES }) documentType!: string;
  @ApiProperty({ example: '4567' }) documentNumberLast4!: string;
  @ApiProperty({ enum: KYC_STATUSES }) status!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) decisionReason!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) decidedAt!: string | null;

  static from(s: KycSubmission): KycSubmissionResponse {
    return {
      id: s.id,
      documentType: s.documentType,
      documentNumberLast4: s.documentNumberLast4,
      status: s.status,
      decisionReason: s.decisionReason,
      createdAt: s.createdAt.toISOString(),
      decidedAt: s.decidedAt?.toISOString() ?? null,
    };
  }
}

// ------------------------------------------------------------------ wallet

export class WalletResponse {
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty({ description: 'Balance in minor units (paise for INR)', example: 50000 }) balanceMinor!: number;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;

  static from(w: Wallet): WalletResponse {
    return { currency: w.currency, balanceMinor: w.balanceMinor, updatedAt: w.updatedAt.toISOString() };
  }
}

export class TopUpRequest {
  @ApiProperty({ description: 'Amount in minor units (paise for INR)', example: 50000 })
  @IsInt()
  @Min(1)
  amountMinor!: number;

  @ApiProperty({
    example: 'tok_visa',
    description: 'Token from the payment SDK. With the mock provider, tok_reject… is declined and tok_timeout… never answers.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  paymentToken!: string;
}

export class TopUpResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() amountMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: TOP_UP_STATUSES }) status!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) failureReason!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) completedAt!: string | null;

  static from(t: TopUp): TopUpResponse {
    return {
      id: t.id,
      amountMinor: t.amountMinor,
      currency: t.currency,
      status: t.status,
      failureReason: t.failureReason,
      createdAt: t.createdAt.toISOString(),
      completedAt: t.completedAt?.toISOString() ?? null,
    };
  }
}

export class TopUpResultResponse {
  @ApiProperty({ type: TopUpResponse }) topUp!: TopUpResponse;
  @ApiProperty({ type: WalletResponse }) wallet!: WalletResponse;
}

// ------------------------------------------------------------------ ops

export class HealthResponse {
  @ApiProperty({ enum: ['ok'] }) status!: 'ok';
}

export class ReadinessCheckResult {
  @ApiProperty({ example: 'database' }) name!: string;
  @ApiProperty({ enum: ['up', 'down'] }) status!: 'up' | 'down';
}

export class ReadinessResponse {
  @ApiProperty({ enum: ['ready', 'not_ready'] }) status!: 'ready' | 'not_ready';
  @ApiProperty({ type: [ReadinessCheckResult] }) checks!: ReadinessCheckResult[];
}

export class MinAppVersionResponse {
  @ApiProperty({ example: '1.0.0', description: 'Oldest mobile app version the API still supports (semver)' })
  minAppVersion!: string;
}

export class ErrorResponse {
  @ApiProperty() statusCode!: number;
  @ApiProperty({ example: 'VALIDATION' }) code!: string;
  @ApiProperty() message!: string;
}
