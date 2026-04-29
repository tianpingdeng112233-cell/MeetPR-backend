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

export const RefreshTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  role: z.enum(USER_ROLES),
  jti: z.string().uuid(),
});

export type RegisterBody = z.infer<typeof RegisterBodySchema>;
export type LoginBody = z.infer<typeof LoginBodySchema>;
export type RefreshBody = z.infer<typeof RefreshBodySchema>;
export type RefreshTokenPayload = z.infer<typeof RefreshTokenPayloadSchema>;
