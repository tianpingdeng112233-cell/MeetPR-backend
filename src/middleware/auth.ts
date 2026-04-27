import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import type { Config } from '../config';

const AccessTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  role: z.enum(['coach', 'coached_student', 'self_train_student']),
});

export function createRequireAuth(config: Pick<Config, 'JWT_ACCESS_SECRET'>): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const token = header.slice('Bearer '.length).trim();
    if (token.length === 0) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    let payload: unknown;
    try {
      payload = jwt.verify(token, config.JWT_ACCESS_SECRET);
    } catch {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const parsed = AccessTokenPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    req.user = { id: parsed.data.sub, role: parsed.data.role };
    next();
  };
}
