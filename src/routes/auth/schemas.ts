import { z } from 'zod';

import { USER_ROLES } from '../../db/types';

const PhoneSchema = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Phone must be E.164 format');

const PasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, {
    message: 'Password must be at most 72 UTF-8 bytes',
  });

export const RegisterBodySchema = z.object({
  phone: PhoneSchema,
  password: PasswordSchema,
  role: z.enum(USER_ROLES),
});

export const LoginBodySchema = z.object({
  phone: PhoneSchema,
  password: PasswordSchema,
});

export const RefreshBodySchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

/** PUT /me/password (spec 011): new password reuses the register rule. */
export const ChangePasswordBodySchema = z
  .object({
    old_password: PasswordSchema,
    new_password: PasswordSchema,
  })
  .strict();

export const RefreshTokenPayloadSchema = z
  .object({
    sub: z.string().min(1),
    role: z.enum(USER_ROLES),
    jti: z.string().uuid(),
    typ: z.literal('refresh'),
    aud: z.string().min(1),
    iss: z.string().min(1),
    iat: z.number().int(),
    exp: z.number().int(),
  })
  .strict();

// Refresh tokens issued before the typ/aud/iss claims existed only carry
// sub/role/jti. Rotation needs just those, and re-issuing mints a full-claim
// token, so a legacy holder migrates on its next refresh. A wrong typ is still
// rejected so an access token can never be replayed as a refresh token.
export const LegacyRefreshTokenPayloadSchema = z
  .object({
    sub: z.string().min(1),
    role: z.enum(USER_ROLES),
    jti: z.string().uuid(),
    typ: z.literal('refresh').optional(),
  })
  .passthrough();

export type RegisterBody = z.infer<typeof RegisterBodySchema>;
export type LoginBody = z.infer<typeof LoginBodySchema>;
export type RefreshBody = z.infer<typeof RefreshBodySchema>;
export type RefreshTokenPayload = z.infer<typeof RefreshTokenPayloadSchema>;
