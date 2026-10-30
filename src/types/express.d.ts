import type { PreferredLocale } from '../i18n/locale';
import type { UserRole } from '../db/types';

declare global {
  namespace Express {
    interface Request {
      locale?: PreferredLocale;
      id?: string;
      user?: {
        id: string;
        role: UserRole;
      };
    }
  }
}

export {};
