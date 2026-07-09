import { z } from 'zod';

const BooleanEnvSchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

export const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be >= 32 chars'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be >= 32 chars'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('30d'),
    // These are deliberately optional so existing local/test configs keep the
    // stable defaults below. Production can pin them explicitly for rotation.
    JWT_ISSUER: z.string().min(1).optional(),
    JWT_AUDIENCE: z.string().min(1).optional(),
    // Accept tokens minted before the typ/aud/iss claims existed. Defaults on so
    // a deploy does not force-log-out every existing session; signature and
    // expiry are always enforced. Set to 'false' once the fleet has rotated.
    AUTH_ALLOW_LEGACY_TOKENS: BooleanEnvSchema,
    LOG_LEVEL: z
      .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    CORS_ORIGIN: z.string().default('*'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    // OSS credentials are optional: local dev runs without them and /uploads/* responds 503.
    OSS_ACCESS_KEY_ID: z.string().min(1).optional(),
    OSS_ACCESS_KEY_SECRET: z.string().min(1).optional(),
    OSS_BUCKET: z.string().min(1).optional(),
    OSS_REGION: z.string().min(1).optional(),
    OSS_ENDPOINT: z.string().min(1).optional(),
  })
  .superRefine((config, ctx) => {
    if (config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET',
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse(env);
}

export const DEFAULT_JWT_ISSUER = 'meetpr-api';
export const DEFAULT_JWT_AUDIENCE = 'meetpr-client';

export function jwtIssuer(config: Pick<Config, 'JWT_ISSUER'>): string {
  return config.JWT_ISSUER ?? DEFAULT_JWT_ISSUER;
}

export function jwtAudience(config: Pick<Config, 'JWT_AUDIENCE'>): string {
  return config.JWT_AUDIENCE ?? DEFAULT_JWT_AUDIENCE;
}

export function allowLegacyTokens(config: Pick<Config, 'AUTH_ALLOW_LEGACY_TOKENS'>): boolean {
  return config.AUTH_ALLOW_LEGACY_TOKENS ?? true;
}
