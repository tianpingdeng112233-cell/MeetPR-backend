import type { RequestHandler } from 'express';

import { route, validationEnvelope } from '../routes/http';
import { ensureUser } from './upload-common';
import type { HandlerDeps } from './upload-common';
import { PrivacyConsentBodySchema } from './upload-schemas';

function ipAddressForInet(ip: string | undefined): string | null {
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

export function privacyConsentHandler(deps: Pick<HandlerDeps, 'db'>): RequestHandler {
  return route(async (req, res) => {
    const user = ensureUser(req);
    const body = PrivacyConsentBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json(validationEnvelope(body.error));
      return;
    }

    await deps.db
      .insertInto('privacy_consents')
      .values({
        user_id: user.id,
        consent_kind: body.data.kind,
        agreed_at: new Date(),
        user_agent: req.get('user-agent') ?? null,
        ip_address: ipAddressForInet(req.ip),
      })
      .onConflict((oc) => oc.columns(['user_id', 'consent_kind']).doNothing())
      .execute();

    res.status(204).send();
  });
}
