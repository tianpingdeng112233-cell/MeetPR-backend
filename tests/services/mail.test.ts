import { describe, expect, it, vi } from 'vitest';

import { sendPasswordResetEmail } from '../../src/services/mail';

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
