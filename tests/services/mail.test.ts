import { describe, expect, it, vi } from 'vitest';

import {
  sendPasswordResetEmail,
  sendSignupCodeEmail,
  sendAlreadyRegisteredEmail,
  sendCoachWelcomeEmail,
} from '../../src/services/mail';

describe('Resend mail service', () => {
  it('posts the reset code as text and HTML with bearer authentication', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 202 })),
    );

    await sendPasswordResetEmail(
      {
        apiKey: 'resend-secret',
        from: 'MeetPR <no-reply@example.com>',
        to: 'student@example.com',
        code: '001234',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer resend-secret',
        'Content-Type': 'application/json',
      },
    });
    if (typeof init?.body !== 'string') throw new Error('expected a JSON request body');
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      from: 'MeetPR <no-reply@example.com>',
      to: ['student@example.com'],
      subject: 'Your MeetPR password reset code',
    });
    expect(payload.text).toContain('001234');
    expect(payload.html).toContain('001234');
    expect(payload.text).toContain('10 minutes');
  });

  it('rejects a non-success Resend response', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 503 })),
    );

    await expect(
      sendPasswordResetEmail(
        {
          apiKey: 'resend-secret',
          from: 'MeetPR <no-reply@example.com>',
          to: 'student@example.com',
          code: '123456',
        },
        fetchMock,
      ),
    ).rejects.toThrow('Resend returned 503');
  });
});

describe('localized email content', () => {
  const input = {
    apiKey: 'test-key',
    from: 'test@example.com',
    to: 'student@example.com',
    code: '001234',
  };
  it('preserves every byte of the default English reset message', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 202 })),
    );
    await sendPasswordResetEmail(input, fetchMock);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      subject: 'Your MeetPR password reset code',
      text: 'Your MeetPR password reset code is 001234. It expires in 10 minutes. If you did not request this, you can ignore this email.',
      html: '<p>Your MeetPR password reset code is <strong>001234</strong>.</p><p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>',
    });
  });

  it.each([
    [sendSignupCodeEmail, 'MeetPR 注册验证码', '001234'],
    [sendAlreadyRegisteredEmail, '你已经有 MeetPR 账号了', '登录'],
    [sendPasswordResetEmail, 'MeetPR 重置密码验证码', '001234'],
  ] as const)('sends Chinese text and HTML for %s', async (send, subject, detail) => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 202 })),
    );
    await send({ ...input, locale: 'zh' }, fetchMock);
    const payload = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      string
    >;
    expect(payload.subject).toBe(subject);
    for (const body of [payload.text, payload.html]) {
      expect(body).toContain(detail);
      expect(body).toContain('忽略');
      expect(body).toContain(send === sendAlreadyRegisteredEmail ? '找回' : '10 分钟');
    }
  });

  it.each([
    [sendSignupCodeEmail, 'Your MeetPR signup code', '001234'],
    [sendAlreadyRegisteredEmail, 'You already have a MeetPR account', 'sign in'],
  ] as const)('defaults new email messages to English for %s', async (send, subject, detail) => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 202 })),
    );
    await send(input, fetchMock);
    const payload = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      string
    >;
    expect(payload.subject).toBe(subject);
    for (const body of [payload.text, payload.html]) {
      expect(body).toContain(detail);
      expect(body).toContain('ignore');
      expect(body).toContain(send === sendAlreadyRegisteredEmail ? 'password' : '10 minutes');
    }
  });
});

describe('coach welcome guide', () => {
  it('gives ordered setup steps and a token-free coach login link in both formats', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 202 })),
    );
    await sendCoachWelcomeEmail(
      {
        apiKey: 'test-key',
        from: 'test@example.com',
        to: 'coach@example.com',
        url: 'https://meetpr.example/coach/set-password?token=synthetic&email=coach%40example.com',
      },
      fetchMock,
    );
    const payload = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      text: string;
      html: string;
    };
    for (const body of [payload.text, payload.html]) {
      expect(body.indexOf('1. 设置密码')).toBeLessThan(body.indexOf('2. 安装 App 并登录'));
      expect(body.indexOf('2. 安装 App 并登录')).toBeLessThan(body.indexOf('3. 登录教练网页'));
      expect(body.indexOf('3. 登录教练网页')).toBeLessThan(body.indexOf('4. 邀请学员'));
      expect(body).toContain('coach@example.com');
      expect(body).toContain('App Store');
      expect(body).toContain('TestFlight');
      expect(body).toContain('7 天');
      expect(body).toContain('https://meetpr.example/coach/login');
      expect(body).toContain('复制邀请消息');
      expect(body).toContain('「接收」');
    }
    expect(payload.html).toContain('href="https://meetpr.example/coach/login"');
    expect(payload.html).toContain('token=synthetic&amp;email=');
    expect(payload.html).not.toContain('/coach/login?');
  });
});
