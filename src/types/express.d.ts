import type { UserRole } from '../db/types';

declare global {
  namespace Express {
    interface Request {
      id?: string;
      user?: {
        id: string;
        role: UserRole;
      };
    }
  }
}

export {};
