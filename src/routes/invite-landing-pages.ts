import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Router } from 'express';
import type { Kysely } from 'kysely';

import type { Database } from '../db/types';
import { findValidInvite } from '../handlers/public-invites';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Share metadata for the invitation SPA using the inviting coach when available. */
export function inviteLandingPagesRouter(webDir: string, db: Kysely<Database>) {
  const router = Router();
  const indexPath = path.join(webDir, 'index.html');
  let template: Promise<string> | undefined;

  router.get('/i/:code', (req, res, next) => {
    if (req.accepts(['json', 'html']) !== 'html') {
      next();
      return;
    }

    template ??= readFile(indexPath, 'utf8');
    void template
      .then(
        async (page) => {
          const code = req.params.code;
          // Same alphabet as handlers/invite-codes.ts and routes/public-invites.ts.
          // Current codes have 10 characters; also support the 8-character share format.
          const validFormat =
            (code.length === 8 || code.length === 10) &&
            /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/.test(code);
          const invite = validFormat ? await findValidInvite(db, code) : undefined;
          const groupedCode = invite ? code.match(/.{1,4}/g)?.join(' ') : undefined;
          const coachName = Array.from(invite?.display_name?.trim() ?? '')
            .slice(0, 30)
            .join('');
          const title = escapeHtml(
            `${coachName ? `${coachName} 教练` : '你的教练'}邀请你在 MeetPR 跟练训练计划`,
          );
          const description = escapeHtml(
            groupedCode
              ? `输入邀请码 ${groupedCode}，我排的计划直接同步到你手机`
              : '我排的计划直接同步到你手机',
          );
          const metadata = [
            `<meta name="description" content="${description}">`,
            `<meta property="og:title" content="${title}">`,
            `<meta property="og:description" content="${description}">`,
          ].join('\n');
          const html = page
            .replace(/<title>.*?<\/title>/is, () => `<title>${title}</title>`)
            .replace(/<\/head>/i, () => `${metadata}\n</head>`);
          res.type('html').send(html);
        },
        () => {
          // Match the generic SPA fallback when the bundle is unavailable; allow retries.
          template = undefined;
          next();
        },
      )
      .catch(next);
  });

  return router;
}
