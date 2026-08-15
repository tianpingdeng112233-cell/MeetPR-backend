import { z } from 'zod';

const BooleanEnvSchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

const HttpsUrlSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === 'https:', {
    message: 'must use https',
  });

const SelfSignupRolesSchema = z
  .string()
  .refine(
    (value) =>
      value
        .split(',')
        .map((role) => role.trim())
        .filter(Boolean)
        .every((role) => role === 'coached_student' || role === 'self_train_student'),
    { message: 'SELF_SIGNUP_ROLES may only contain student roles' },
  )
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
    // Dedicated limiter for /events + /events/feedback (keyed on anon_id, fail-open).
    // Wide by design: internal beta n<50, and fail-open never 429s a real user.
    EVENTS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    EVENTS_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
    // Analytics kill-switch (GET /events/config). NOT z.coerce.boolean(): that runs
    // JS Boolean(), so "false"/"0" both coerce to true and the switch never turns
    // off. enum + explicit transform is the only correct off path (SPEC §11).
    ANALYTICS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    SIGNALS_CRON_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    PUSH_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    PUSH_DAILY_DIGEST_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    APNS_KEY: z.string().min(1).optional(),
    APNS_KEY_ID: z.string().min(1).optional(),
    APNS_TEAM_ID: z.string().min(1).optional(),
    APNS_BUNDLE_ID: z.string().min(1).optional(),
    APNS_ENV: z.enum(['sandbox', 'production']).optional(),
    ANALYTICS_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
    CORS_ORIGIN: z.string().default('*'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    // Production is closed by default. A small invite/allowlist cohort may
    // explicitly opt in, but coach accounts must always be pre-provisioned.
    REGISTRATION_ENABLED: BooleanEnvSchema,
    REGISTRATION_ALLOWLIST: z.string().optional(),
    // Global identity providers are opt-in. Omitting every setting leaves the
    // existing phone paths fully operational while new registration fails shut.
    SELF_SIGNUP_ROLES: SelfSignupRolesSchema,
    APPLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    RESEND_API_KEY: z.string().min(1).optional(),
    EMAIL_FROM: z.string().min(1).optional(),
    SIWA_KEY_ID: z.string().min(1).optional(),
    SIWA_TEAM_ID: z.string().min(1).optional(),
    SIWA_PRIVATE_KEY: z.string().min(1).optional(),
    // Go-live blocker, off by default. Enable only once the business license,
    // ICP filing, and domain TLS are ready. When true, the app enforces HTTPS
    // (426 + HSTS) and the production checks below reject an incomplete setup.
    FORCE_HTTPS: BooleanEnvSchema,
    // Public TLS is terminated outside this process. This value documents the
    // canonical external endpoint and makes an incomplete production setup fail
    // at boot instead of silently serving credentials over a raw IP/HTTP URL.
    PUBLIC_BASE_URL: HttpsUrlSchema.optional(),
    // OSS credentials are optional: local dev runs without them and /uploads/* responds 503.
    OSS_ACCESS_KEY_ID: z.string().min(1).optional(),
    OSS_ACCESS_KEY_SECRET: z.string().min(1).optional(),
    OSS_BUCKET: z.string().min(1).optional(),
    OSS_REGION: z.string().min(1).optional(),
    OSS_ENDPOINT: z.string().min(1).optional(),
    OSS_ACCELERATE_ENDPOINT: z.string().min(1).optional(),
  })
  .superRefine((config, ctx) => {
    if (config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET',
      });
    }

    if (config.PUSH_ENABLED) {
      const requiredApnsFields = [
        'APNS_KEY',
        'APNS_KEY_ID',
        'APNS_TEAM_ID',
        'APNS_BUNDLE_ID',
        'APNS_ENV',
      ] as const;
      for (const field of requiredApnsFields) {
        if (config[field] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is required when PUSH_ENABLED=true`,
          });
        }
      }
    }

    if (config.NODE_ENV !== 'production') return;

    // HTTPS is a go-live blocker, not an immediate deploy gate: these checks
    // only run once FORCE_HTTPS is switched on, so a pre-TLS production build
    // still boots.
    if (config.FORCE_HTTPS === true) {
      if (config.CORS_ORIGIN === '*' || config.CORS_ORIGIN.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGIN'],
          message: 'CORS_ORIGIN must be an explicit HTTPS origin in production',
        });
      } else {
        for (const origin of config.CORS_ORIGIN.split(',').map((value) => value.trim())) {
          const parsed = HttpsUrlSchema.safeParse(origin);
          if (!parsed.success) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['CORS_ORIGIN'],
              message: 'every production CORS origin must use https',
            });
            break;
          }
        }
      }

      if (config.PUBLIC_BASE_URL === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PUBLIC_BASE_URL'],
          message: 'PUBLIC_BASE_URL must be an HTTPS URL in production',
        });
      }
      if (config.TRUST_PROXY < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TRUST_PROXY'],
          message: 'TRUST_PROXY must be at least 1 in production TLS deployments',
        });
      }
    }

    if (config.REGISTRATION_ENABLED === true && !hasRegistrationAllowlist(config)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REGISTRATION_ALLOWLIST'],
        message: 'REGISTRATION_ALLOWLIST is required when production registration is enabled',
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

export function isRegistrationEnabled(
  config: Pick<Config, 'NODE_ENV' | 'REGISTRATION_ENABLED'>,
): boolean {
  return config.REGISTRATION_ENABLED ?? config.NODE_ENV !== 'production';
}

export function registrationAllowlist(
  config: Pick<Config, 'REGISTRATION_ALLOWLIST'>,
): ReadonlySet<string> {
  return new Set(
    (config.REGISTRATION_ALLOWLIST ?? '')
      .split(',')
      .map((phone) => phone.trim())
      .filter((phone) => phone.length > 0),
  );
}

export function selfSignupRoles(
  config: Pick<Config, 'SELF_SIGNUP_ROLES'>,
): ReadonlySet<'coached_student' | 'self_train_student'> {
  return new Set(
    (config.SELF_SIGNUP_ROLES ?? '')
      .split(',')
      .map((role) => role.trim())
      .filter(
        (role): role is 'coached_student' | 'self_train_student' =>
          role === 'coached_student' || role === 'self_train_student',
      ),
  );
}

function hasRegistrationAllowlist(config: Pick<Config, 'REGISTRATION_ALLOWLIST'>): boolean {
  return registrationAllowlist(config).size > 0;
}
