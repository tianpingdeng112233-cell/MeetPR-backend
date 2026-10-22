import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Router } from 'express';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Share metadata for the invitation SPA, without looking up the invitation. */
export function inviteLandingPagesRouter(webDir: string) {
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
        (page) => {
          const code = req.params.code;
          // Same alphabet as handlers/invite-codes.ts and routes/public-invites.ts.
          // Current codes have 10 characters; also support the 8-character share format.
          const validCode =
            (code.length === 8 || code.length === 10) &&
            /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/.test(code);
          const groupedCode = validCode ? code.match(/.{1,4}/g)?.join(' ') : undefined;
          const title = escapeHtml('教练邀请你加入 MeetPR');
          const description = escapeHtml(
            groupedCode
              ? `用邀请码 ${groupedCode} 加入教练，在 MeetPR 接收训练计划`
              : '加入教练，在 MeetPR 接收训练计划',
          );
          const metadata = [
            `<meta name="description" content="${description}">`,
            `<meta property="og:title" content="${title}">`,
            `<meta property="og:description" content="${description}">`,
          ].join('\n');
          const html = page
            .replace(/<title>.*?<\/title>/is, `<title>${title}</title>`)
            .replace(/<\/head>/i, `${metadata}\n</head>`);
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
