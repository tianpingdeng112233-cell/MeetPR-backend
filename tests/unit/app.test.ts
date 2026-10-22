import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Kysely } from 'kysely';
import pino from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app';
import type { Config } from '../../src/config';
import type { Database } from '../../src/db/types';

function makeDeps() {
  const config: Config = {
    NODE_ENV: 'test',
    PORT: 3000,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '30d',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_MAX: 1000,
    CORS_ORIGIN: '*',
    EVENTS_RATE_LIMIT_WINDOW_MS: 60_000,
    EVENTS_RATE_LIMIT_MAX: 10_000,
    ANALYTICS_ENABLED: true,
    SIGNALS_CRON_ENABLED: true,
    PUSH_ENABLED: false,
    PUSH_DAILY_DIGEST_ENABLED: false,
    ANALYTICS_SAMPLE_RATE: 1,
    TRUST_PROXY: 0,
  };
  return {
    config,
    logger: pino({ level: 'silent' }),
    db: {} as unknown as Kysely<Database>,
  };
}

describe('app', () => {
  it('returns 200 with status ok on /health', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('echoes X-Request-Id header on the response', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).get('/health').set('X-Request-Id', 'test-req-1');
    expect(res.headers['x-request-id']).toBe('test-req-1');
  });

  it('generates a request id when none is provided', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(typeof res.headers['x-request-id']).toBe('string');
  });

  it('returns 404 JSON envelope for unknown routes', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).get('/no-such-path');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', path: '/no-such-path' });
  });

  it('fails closed for direct HTTP once FORCE_HTTPS is on while accepting trusted HTTPS proxy traffic', async () => {
    const deps = makeDeps();
    deps.config = {
      ...deps.config,
      NODE_ENV: 'production',
      FORCE_HTTPS: true,
      CORS_ORIGIN: 'https://plan.example.test',
      PUBLIC_BASE_URL: 'https://api.example.test',
      TRUST_PROXY: 1,
    };
    const app = createApp(deps);

    const directHttp = await request(app).post('/auth/login').send({});
    expect(directHttp.status).toBe(426);
    expect(directHttp.body).toEqual({ error: 'HTTPS_REQUIRED' });

    const proxiedHttps = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .send({});
    expect(proxiedHttps.status).toBe(400);
    expect(proxiedHttps.body.error).toBe('VALIDATION_ERROR');
  });

  it('serves HTTP normally in production while FORCE_HTTPS is off (pre-TLS go-live)', async () => {
    const deps = makeDeps();
    deps.config = { ...deps.config, NODE_ENV: 'production' };
    const app = createApp(deps);

    const directHttp = await request(app).post('/auth/login').send({});
    expect(directHttp.status).not.toBe(426);
    expect(directHttp.status).toBe(400);
    expect(directHttp.body.error).toBe('VALIDATION_ERROR');
  });
});

describe('invite landing HTML', () => {
  const worktreeRoot = process.cwd();
  const title = '教练邀请你加入 MeetPR';
  let fixtureDir: string;
  let originalHtml: string;

  beforeEach(async () => {
    originalHtml = await readFile(path.join(worktreeRoot, 'web/index.html'), 'utf8');
    fixtureDir = await mkdtemp(path.join(worktreeRoot, 'invite-title-fixture-'));
    await mkdir(path.join(fixtureDir, 'web'));
    await writeFile(path.join(fixtureDir, 'web/index.html'), originalHtml);
    vi.spyOn(process, 'cwd').mockReturnValue(fixtureDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  });

  it.each([
    ['ABCD2345', 'ABCD 2345'],
    ['ABCDEFGHJK', 'ABCD EFGH JK'],
  ])('adds share metadata for %s while preserving the SPA', async (code, groupedCode) => {
    const app = createApp(makeDeps());
    const res = await request(app).get(`/i/${code}`).set('Accept', 'text/html');
    const description = `用邀请码 ${groupedCode} 加入教练，在 MeetPR 接收训练计划`;

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain(`<title>${title}</title>`);
    const head = res.text.split('</head>')[0];
    expect(head).toContain(`<meta name="description" content="${description}">`);
    expect(head).toContain(`<meta property="og:title" content="${title}">`);
    expect(head).toContain(`<meta property="og:description" content="${description}">`);
    const withoutMetadata = res.text
      .replace(/\s*<meta (?:name="description"|property="og:(?:title|description)")[^>]*>/g, '')
      .replace(`<title>${title}</title>`, '<title>MeetPR 计划编辑器</title>');
    expect(withoutMetadata.replace(/>\s+</g, '><')).toBe(originalHtml.replace(/>\s+</g, '><'));
  });

  it.each([
    '<script>alert(1)</script>',
    'ABCD" onload="alert(1)',
    'ABCDIO01',
    'ABCD&EFGH',
    'ABCDEFGHJ',
    'ABCDEFGHJKL',
  ])('does not reflect an invalid code: %s', async (code) => {
    const app = createApp(makeDeps());
    const res = await request(app)
      .get(`/i/${encodeURIComponent(code)}`)
      .set('Accept', 'text/html');

    expect(res.status).toBe(200);
    expect(res.text).toContain(`<title>${title}</title>`);
    expect(res.text).not.toContain(code);
    expect(res.text).not.toContain(encodeURIComponent(code));
    expect(res.text).not.toContain('alert(1)');
    expect(res.text).not.toContain('ABCD');
  });

  it.each(['application/json', '*/*', 'application/json, text/html;q=0.5'])(
    'falls through to JSON notFound for Accept: %s',
    async (accept) => {
      const app = createApp(makeDeps());
      const res = await request(app).get('/i/ABCD2345').set('Accept', accept);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body).toEqual({ error: 'not_found', path: '/i/ABCD2345' });
    },
  );

  it('falls through when no Accept header is provided', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).get('/i/ABCD2345');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', path: '/i/ABCD2345' });
  });

  it('matches the existing SPA fallback when web/index.html is absent', async () => {
    await rm(path.join(fixtureDir, 'web/index.html'));
    const app = createApp(makeDeps());
    for (const route of ['/i/ABCD2345', '/unmatched-spa-page']) {
      const res = await request(app).get(route).set('Accept', 'text/html');
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body).toEqual({ error: 'not_found', path: route });
    }
  });

  it('caches the template without caching another invitation code into the response', async () => {
    const app = createApp(makeDeps());
    const first = await request(app).get('/i/ABCD2345').set('Accept', 'text/html');
    expect(first.status).toBe(200);
    expect(first.text).toContain('用邀请码 ABCD 2345 加入教练');
    await rm(path.join(fixtureDir, 'web/index.html'));

    const second = await request(app).get('/i/EFGH6789').set('Accept', 'text/html');
    expect(second.status).toBe(200);
    expect(second.text).toContain('用邀请码 EFGH 6789 加入教练');
    expect(second.text).not.toContain('ABCD');
    expect(second.text).toContain('<div id="root"></div>');
  });

  it('leaves other SPA routes and the template file unchanged', async () => {
    const app = createApp(makeDeps());
    await request(app).get('/i/ABCD2345').set('Accept', 'text/html');
    for (const route of ['/unmatched-spa-page', '/i/ABCD2345/extra']) {
      const res = await request(app).get(route).set('Accept', 'text/html');
      expect(res.status).toBe(200);
      expect(res.text).toBe(originalHtml);
    }
    expect(await readFile(path.join(fixtureDir, 'web/index.html'), 'utf8')).toBe(originalHtml);
  });
});
