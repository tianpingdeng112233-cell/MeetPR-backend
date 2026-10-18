import fs from 'node:fs';
import pg from 'pg';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../src/db/types';
import jwt from 'jsonwebtoken';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db/kysely';
import { makeMigrationDb, runMigration } from './helpers/migrations';
import { request } from './helpers/inMemoryRequest';

const applicant = {
  name: '示例教练',
  email: 'coach@example.com',
  student_count: 12,
  device: 'both',
};
const databases: Kysely<Database>[] = [];
async function context(enabled = true) {
  const migrations = [
    '0001-init-users.sql',
    '0003.5-init-profile-tables.sql',
    '0008-init-invite-codes.sql',
    '0039-multi-device-sessions.sql',
    '0044-add-admin-role.sql',
    '0064-global-identity.sql',
    '0065-email-channel.sql',
    '0066-add-user-timezone.sql',
    '0075-coach-applications.sql',
  ];
  let db: Kysely<Database>;
  if (process.env.SPEC093_TEST_DATABASE_URL) {
    const url = new URL(process.env.SPEC093_TEST_DATABASE_URL);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/meetpr_spec093')
      throw new Error('Only the dedicated local spec093 database may be reset');
    const pool = new pg.Pool({ connectionString: url.toString() });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    for (const file of migrations)
      await pool.query(fs.readFileSync(`db/migrations/${file}`, 'utf8'));
    // The migration must be safely repeatable on real PostgreSQL too.
    await pool.query(fs.readFileSync('db/migrations/0075-coach-applications.sql', 'utf8'));
    db = createDb(pool);
  } else {
    const mem = makeMigrationDb();
    for (const file of migrations) runMigration(mem, `db/migrations/${file}`);
    const { Pool } = mem.adapters.createPg();
    db = createDb(new Pool());
  }
  databases.push(db);
  const config = loadConfig({
    NODE_ENV: 'test',
    REGISTRATION_ENABLED: 'true',
    SELF_SIGNUP_ROLES: 'coached_student',
    DATABASE_URL: 'postgres://localhost/test',
    JWT_ACCESS_SECRET: 'test-access-secret-long-enough-for-config',
    JWT_REFRESH_SECRET: 'test-refresh-secret-long-enough-for-config',
    RESEND_API_KEY: 'test-key',
    EMAIL_FROM: 'noreply@example.com',
    COACH_ONBOARDING_ENABLED: String(enabled),
    COACH_ONBOARDING_URL: 'http://localhost:3000',
    RATE_LIMIT_MAX: '10000',
  });
  const app = createApp({ config, db, logger: pino({ level: 'silent' }) });
  const mail = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 202 })));
  vi.stubGlobal('fetch', mail);
  const adminId = '11111111-1111-4111-8111-111111111111';
  const auth = {
    Authorization: `Bearer ${jwt.sign({ sub: adminId, role: 'admin' }, config.JWT_ACCESS_SECRET, { expiresIn: '15m' })}`,
  };
  return { app, db, mail, adminId, auth };
}
function mailContent(
  mail: Awaited<ReturnType<typeof context>>['mail'],
  index: number,
): { text: string; html: string } {
  const body = mail.mock.calls[index]?.[1]?.body;
  if (typeof body !== 'string') throw new Error('expected mail body');
  return JSON.parse(body) as { text: string; html: string };
}
function firstLink(text: string): URL {
  const url = /http:\/\/localhost:3000\/\S+/.exec(text)?.[0];
  if (!url) throw new Error('expected setup link');
  return new URL(url);
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

describe('coach applications', () => {
  it('accepts an application and sends the Chinese receipt without duplicate pending rows', async () => {
    const { app, mail } = await context();
    const response = await request(app).post('/coach-applications').send(applicant);
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'pending' });
    expect(mailContent(mail, 0).text).toContain('1 个工作日');
    const duplicate = await request(app)
      .post('/coach-applications')
      .send({ ...applicant, email: 'COACH@example.com' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe('COACH_APPLICATION_EXISTS');
  });
  it('lets only a live admin approve once and delivers a seven-day setup link', async () => {
    const { app, db, mail, adminId, auth } = await context();
    await db
      .insertInto('users')
      .values({ id: adminId, role: 'admin', phone: null, password_hash: 'disabled-test-password' })
      .execute();
    const submitted = await request(app).post('/coach-applications').send(applicant);
    const id = submitted.body.id as string;
    expect(
      (await request(app).get('/admin/coach-applications').set(auth)).body.applications,
    ).toHaveLength(1);
    expect((await request(app).post(`/admin/coach-applications/${id}/approve`)).status).toBe(401);
    const approved = await request(app).post(`/admin/coach-applications/${id}/approve`).set(auth);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', welcome_email_sent: true });
    const welcome = mailContent(mail, 1);
    expect(welcome.text).toContain('7 天');
    expect(welcome.html).toContain('安装 App');
    expect(welcome.html).toContain('邀请学员');
    expect(welcome.text).toContain('不要选「注册」');
    expect(welcome.text).toContain('/coach/set-password#');
    expect(
      (await request(app).post(`/admin/coach-applications/${id}/approve`).set(auth)).body.error,
    ).toBe('COACH_APPLICATION_REVIEWED');
  });

  it('rejects email login for an approved coach until the welcome-link password is set', async () => {
    const { app, db, mail, adminId, auth } = await context();
    await db
      .insertInto('users')
      .values({ id: adminId, role: 'admin', phone: null, password_hash: 'disabled-test-password' })
      .execute();
    const submitted = await request(app).post('/coach-applications').send(applicant);
    expect(submitted.status).toBe(201);
    const approved = await request(app)
      .post(`/admin/coach-applications/${submitted.body.id as string}/approve`)
      .set(auth);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');

    const credentials = { email: applicant.email, password: 'synthetic-coach-password' };
    const rejected = await request(app).post('/auth/email/login').send(credentials);
    expect(rejected.status).toBe(401);
    expect(rejected.body).toEqual({ error: 'AUTH_INVALID_CREDENTIALS' });

    const link = firstLink(mailContent(mail, 1).text);
    const reset = await request(app)
      .post('/auth/email/reset')
      .send({
        email: applicant.email,
        token: new URLSearchParams(link.hash.slice(1)).get('token'),
        newPassword: credentials.password,
      });
    expect(reset.status).toBe(204);
    const accepted = await request(app).post('/auth/email/login').send(credentials);
    expect(accepted.status).toBe(200);
    expect(accepted.body.user.id).toBe(approved.body.user_id);
  });

  it('sets the password from the welcome link, verifies email, logs in, and rejects replay', async () => {
    const { app, db, mail, adminId, auth } = await context();
    await db
      .insertInto('users')
      .values({ id: adminId, role: 'admin', phone: null, password_hash: 'disabled-test-password' })
      .execute();
    const submitted = await request(app).post('/coach-applications').send(applicant);
    const approved = await request(app)
      .post(`/admin/coach-applications/${submitted.body.id as string}/approve`)
      .set(auth);
    expect(approved.status).toBe(200);
    const welcome = mailContent(mail, 1);
    const link = firstLink(welcome.text);
    const reset = {
      email: applicant.email,
      token: new URLSearchParams(link.hash.slice(1)).get('token'),
      newPassword: 'a-new-password',
    };
    expect((await request(app).post('/auth/email/reset').send(reset)).status).toBe(204);
    const login = await request(app)
      .post('/auth/email/login')
      .send({ email: applicant.email, password: reset.newPassword });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(approved.body.user_id);
    expect((await request(app).post('/auth/email/reset').send(reset)).status).toBe(401);
  });

  it('resends an approved incomplete setup and invalidates the previous link', async () => {
    const { app, db, mail, adminId, auth } = await context();
    await db
      .insertInto('users')
      .values({ id: adminId, role: 'admin', phone: null, password_hash: 'disabled-test-password' })
      .execute();
    const submitted = await request(app).post('/coach-applications').send(applicant);
    await request(app)
      .post(`/admin/coach-applications/${submitted.body.id as string}/approve`)
      .set(auth);
    const oldText = mailContent(mail, 1).text;
    const oldToken = new URLSearchParams(firstLink(oldText).hash.slice(1)).get('token');
    expect(
      (await request(app).post('/coach-applications/resend').send({ email: applicant.email }))
        .status,
    ).toBe(204);
    expect(mail.mock.calls).toHaveLength(3);
    expect(
      (
        await request(app)
          .post('/auth/email/reset')
          .send({ email: applicant.email, token: oldToken, newPassword: 'new-password' })
      ).status,
    ).toBe(401);
    expect(
      (await request(app).post('/coach-applications/resend').send({ email: 'unknown@example.com' }))
        .status,
    ).toBe(204);
    expect(mail.mock.calls).toHaveLength(3);
  });

  it('exposes only invite validity and coach name without consuming a use', async () => {
    const { app, db } = await context();
    const user = await db
      .insertInto('users')
      .values({ phone: null, role: 'coach', password_hash: 'disabled' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('coach_profiles')
      .values({ user_id: user.id, display_name: '示例教练' })
      .execute();
    await db
      .insertInto('invite_codes')
      .values({ coach_id: user.id, code: 'ABCDEFGHJK', type: 'single_use', max_uses: 1 })
      .execute();
    for (let i = 0; i < 2; i++)
      expect((await request(app).get('/public/invites/abcdefghjk')).body).toEqual({
        valid: true,
        coach_display_name: '示例教练',
      });
    await db.updateTable('invite_codes').set({ revoked_at: new Date() }).execute();
    expect((await request(app).get('/public/invites/ABCDEFGHJK')).body).toEqual({
      valid: false,
      coach_display_name: null,
    });
    expect((await request(app).get('/public/invites/invalid')).body).toEqual({
      valid: false,
      coach_display_name: null,
    });
  });

  it('keeps disabled deployments unchanged and validates before persisting', async () => {
    const { app } = await context(false);
    expect((await request(app).post('/coach-applications').send(applicant)).status).toBe(404);
    expect((await request(app).get('/public/invites/ABCDEFGHJK')).status).toBe(404);
  });

  it('rejects invalid applications and limits repeated normalized emails', async () => {
    const { app, mail } = await context();
    expect(
      (
        await request(app)
          .post('/coach-applications')
          .send({ ...applicant, student_count: -1 })
      ).status,
    ).toBe(400);
    for (let i = 0; i < 4; i++) await request(app).post('/coach-applications').send(applicant);
    expect(
      (
        await request(app)
          .post('/coach-applications')
          .send({ ...applicant, email: 'COACH@example.com' })
      ).status,
    ).toBe(429);
    expect(mail.mock.calls).toHaveLength(1);
  });

  it('receives existing student applications but refuses conversion, and allows rejection', async () => {
    const { app, db, adminId, auth } = await context();
    await db
      .insertInto('users')
      .values({ id: adminId, role: 'admin', phone: null, password_hash: 'disabled-test-password' })
      .execute();
    const student = await request(app)
      .post('/auth/email/register')
      .send({ email: applicant.email, password: 'student-password', role: 'coached_student' });
    expect(student.status).toBe(201);
    const submitted = await request(app).post('/coach-applications').send(applicant);
    expect(submitted.status).toBe(201);
    const id = submitted.body.id as string;
    expect(
      (await request(app).post(`/admin/coach-applications/${id}/approve`).set(auth)).body.error,
    ).toBe('COACH_APPLICATION_EMAIL_IS_STUDENT');
    expect(
      (await request(app).post(`/admin/coach-applications/${id}/reject`).set(auth)).body.status,
    ).toBe('rejected');
    expect(
      (await request(app).post(`/admin/coach-applications/${id}/approve`).set(auth)).body.error,
    ).toBe('COACH_APPLICATION_REVIEWED');
    expect(
      (
        await request(app)
          .post('/auth/email/login')
          .send({ email: applicant.email, password: 'student-password' })
      ).body.user.role,
    ).toBe('coached_student');
  });

  it('does not create a second application after rejection', async () => {
    const { app, db, mail, adminId, auth } = await context();
    await db
      .insertInto('users')
      .values({ id: adminId, role: 'admin', phone: null, password_hash: 'disabled-test-password' })
      .execute();
    const submitted = await request(app).post('/coach-applications').send(applicant);
    await request(app)
      .post(`/admin/coach-applications/${submitted.body.id as string}/reject`)
      .set(auth);
    expect(mailContent(mail, 1).text).toContain('未通过');
    const duplicate = await request(app).post('/coach-applications').send(applicant);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe('COACH_APPLICATION_EXISTS');
  });

  it('reports welcome mail failure and lets admin retry without creating another account', async () => {
    const { app, db, mail, adminId, auth } = await context();
    await db
      .insertInto('users')
      .values({ id: adminId, role: 'admin', phone: null, password_hash: 'disabled-test-password' })
      .execute();
    const submitted = await request(app).post('/coach-applications').send(applicant);
    const id = submitted.body.id as string;
    mail.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const approved = await request(app).post(`/admin/coach-applications/${id}/approve`).set(auth);
    expect(approved.body).toMatchObject({ status: 'approved', welcome_email_sent: false });
    expect(
      (await request(app).post(`/admin/coach-applications/${id}/resend`).set(auth)).body
        .welcome_email_sent,
    ).toBe(true);
    const applications = (await request(app).get('/admin/coach-applications').set(auth)).body
      .applications;
    expect(applications).toHaveLength(1);
    expect(applications[0].user_id).toBe(approved.body.user_id);
  });

  it('rejects expired setup links, short passwords, and demoted admin tokens', async () => {
    const { app, db, mail, adminId, auth } = await context();
    await db
      .insertInto('users')
      .values({ id: adminId, role: 'admin', phone: null, password_hash: 'disabled-test-password' })
      .execute();
    const submitted = await request(app).post('/coach-applications').send(applicant);
    await request(app)
      .post(`/admin/coach-applications/${submitted.body.id as string}/approve`)
      .set(auth);
    const text = mailContent(mail, 1).text;
    const token = new URLSearchParams(firstLink(text).hash.slice(1)).get('token');
    const body = { email: applicant.email, token, newPassword: 'short' };
    expect((await request(app).post('/auth/email/reset').send(body)).status).toBe(400);
    await db
      .updateTable('password_reset_codes')
      .set({ expires_at: new Date('2020-01-01') })
      .execute();
    expect(
      (
        await request(app)
          .post('/auth/email/reset')
          .send({ ...body, newPassword: 'new-password' })
      ).status,
    ).toBe(401);
    await db.updateTable('users').set({ role: 'coach' }).where('id', '=', adminId).execute();
    expect((await request(app).get('/admin/coach-applications').set(auth)).status).toBe(403);
  });
  it('keeps setup links usable when a legacy six-digit attempt is wrong', async () => {
    const { app, db, mail, adminId, auth } = await context();
    await db
      .insertInto('users')
      .values({ id: adminId, role: 'admin', phone: null, password_hash: 'disabled-test-password' })
      .execute();
    const submitted = await request(app).post('/coach-applications').send(applicant);
    await request(app)
      .post(`/admin/coach-applications/${submitted.body.id as string}/approve`)
      .set(auth);
    const text = mailContent(mail, 1).text;
    const token = new URLSearchParams(firstLink(text).hash.slice(1)).get('token');
    for (let i = 0; i < 5; i++)
      expect(
        (
          await request(app)
            .post('/auth/email/reset')
            .send({ email: applicant.email, code: '000000', newPassword: 'new-password' })
        ).status,
      ).toBe(401);
    expect(
      (
        await request(app)
          .post('/auth/email/reset')
          .send({ email: applicant.email, token, newPassword: 'new-password' })
      ).status,
    ).toBe(204);
  });

  it('rejects expired, exhausted and absent invites and applies its public limit', async () => {
    const { app, db } = await context();
    const user = await db
      .insertInto('users')
      .values({ phone: null, role: 'coach', password_hash: 'disabled' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('invite_codes')
      .values([
        { coach_id: user.id, code: 'ABCDEFGHJK', type: 'single_use', max_uses: 1, used_count: 1 },
        {
          coach_id: user.id,
          code: 'ABCDEFGHJL',
          type: 'time_limited',
          used_count: 0,
          expires_at: new Date('2020-01-01'),
        },
      ])
      .execute();
    for (const code of ['ABCDEFGHJK', 'ABCDEFGHJL', 'ABCDEFGHJM'])
      expect((await request(app).get(`/public/invites/${code}`)).body).toEqual({
        valid: false,
        coach_display_name: null,
      });
    for (let i = 3; i < 60; i++) await request(app).get('/public/invites/ABCDEFGHJK');
    expect((await request(app).get('/public/invites/ABCDEFGHJK')).status).toBe(429);
  });

  it.skipIf(!process.env.SPEC093_TEST_DATABASE_URL)(
    'serializes competing approvals and rolls back all account rows on a DB failure',
    async () => {
      const { app, db, mail, adminId, auth } = await context();
      await db
        .insertInto('users')
        .values({
          id: adminId,
          role: 'admin',
          phone: null,
          password_hash: 'disabled-test-password',
        })
        .execute();
      const submitted = await request(app).post('/coach-applications').send(applicant);
      const id = submitted.body.id as string;
      const results = await Promise.all([
        request(app).post(`/admin/coach-applications/${id}/approve`).set(auth),
        request(app).post(`/admin/coach-applications/${id}/approve`).set(auth),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      expect(mail.mock.calls).toHaveLength(2);
      const next = await request(app)
        .post('/coach-applications')
        .send({ ...applicant, email: 'rollback@example.com' });
      // Inject a DB failure after account creation in the disposable local database.
      await sql`CREATE FUNCTION fail_setup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`.execute(
        db,
      );
      await sql`CREATE TRIGGER fail_setup BEFORE INSERT ON password_reset_codes FOR EACH ROW EXECUTE FUNCTION fail_setup()`.execute(
        db,
      );
      expect(
        (
          await request(app)
            .post(`/admin/coach-applications/${next.body.id as string}/approve`)
            .set(auth)
        ).status,
      ).toBe(500);
      await sql`DROP TRIGGER fail_setup ON password_reset_codes`.execute(db);
      const retry = await request(app)
        .post(`/admin/coach-applications/${next.body.id as string}/approve`)
        .set(auth);
      expect(retry.status).toBe(200);
    },
  );

  it('reports receipt failure and can resend the receipt without another application', async () => {
    const { app, mail } = await context();
    mail.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(
      (await request(app).post('/coach-applications').send(applicant)).body.receipt_email_sent,
    ).toBe(false);
    expect(
      (await request(app).post('/coach-applications/resend').send({ email: applicant.email }))
        .status,
    ).toBe(204);
    expect(mail.mock.calls).toHaveLength(2);
    expect(mailContent(mail, 1).text).toContain('1 个工作日');
  });
  it('serves public coach page navigations while keeping coach APIs authenticated', async () => {
    const { app } = await context();
    for (const path of ['/coach', '/coach/set-password', '/coach/welcome', '/coach/login']) {
      const response = await request(app).get(path).set('Accept', 'text/html');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
    }
    expect((await request(app).get('/coach/invite-codes').set('Accept', 'text/html')).status).toBe(
      401,
    );
    expect((await request(app).get('/coach').set('Accept', 'application/json')).status).toBe(401);
    expect((await request(app).get('/coach/login').set('Accept', 'application/json')).status).toBe(
      401,
    );
    expect((await request(app).get('/coach/login')).status).toBe(401);
  });
});
