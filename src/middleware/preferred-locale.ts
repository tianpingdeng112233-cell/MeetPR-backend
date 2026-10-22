import type { RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import type { Config } from '../config';
import type { Logger } from '../logger';
import type { Database } from '../db/types';
import { requestLocale } from '../i18n/locale';
import { verifyBearerToken } from './auth';

export function createPreferredLocale(
  config: Config,
  db: Kysely<Database>,
  logger: Logger,
): RequestHandler {
  return (req, _res, next) => {
    const locale = requestLocale(req.get('X-MeetPR-Locale'));
    if (locale === undefined) {
      next();
      return;
    }
    req.locale = locale;
    const user = verifyBearerToken(req.headers.authorization, config);
    if (user === null) {
      next();
      return;
    }
    next();
    void (async () => {
      await db
        .updateTable('users')
        .set({ preferred_locale: locale })
        .where('id', '=', user.id)
        .where('preferred_locale', 'is distinct from', locale)
        .execute();
    })().catch((err: unknown) => {
      logger.warn({ err }, 'preferred_locale_update_failed');
    });
  };
}
