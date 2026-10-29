import { z } from 'zod';

/**
 * Every setting the API reads, validated once at startup. Nothing else in the
 * codebase touches `process.env`.
 */

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);
const SEMVER = /^\d+\.\d+\.\d+$/;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: int(1, 65535),
    LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']),

    DATABASE_URL: z
      .string()
      .min(1)
      .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// or postgresql:// URL'),

    JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ISSUER: z.string().min(1),
    JWT_EXPIRES_IN_SECONDS: int(60, 60 * 60 * 24),

    MIN_APP_VERSION: z.string().regex(SEMVER, 'must look like 1.2.3'),

    // Adapter selection. Add a value here when a real provider adapter lands.
    STORAGE_PROVIDER: z.enum(['s3']),
    PAYMENT_PROVIDER: z.enum(['mock']),
    KYC_PROVIDER: z.enum(['mock']),
    PROVIDER_TIMEOUT_MS: int(10, 60_000),

    S3_BUCKET: z.string().min(3),
    S3_REGION: z.string().min(1),
    /** Leave unset for real AWS; set to the MinIO URL locally. */
    S3_ENDPOINT: z.string().url().optional(),
    S3_FORCE_PATH_STYLE: bool,
    /** Leave both unset to use the default AWS credential chain (IAM role etc.). */
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),

    WALLET_CURRENCY: z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code such as INR'),
    TOP_UP_MIN_MINOR: int(1),
    TOP_UP_MAX_MINOR: int(1),
    KYC_MAX_DOCUMENT_BYTES: int(1024, 20 * 1024 * 1024),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_ACCESS_KEY_ID'],
        message: 'set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither',
      });
    }
    if (env.TOP_UP_MIN_MINOR > env.TOP_UP_MAX_MINOR) {
      ctx.addIssue({ code: 'custom', path: ['TOP_UP_MIN_MINOR'], message: 'must not exceed TOP_UP_MAX_MINOR' });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class InvalidEnvironmentError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'InvalidEnvironmentError';
  }
}

/**
 * Parses and validates the environment. Error messages name the variable and
 * the rule it broke but never include the value, so secrets can't leak into
 * logs. Empty strings count as missing.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = envSchema.safeParse(cleaned);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    const missing = issue.code === 'invalid_type' && cleaned[key] === undefined;
    return missing ? `${key}: is required` : `${key}: ${issue.message}`;
  });
  throw new InvalidEnvironmentError([...new Set(problems)].sort());
}
