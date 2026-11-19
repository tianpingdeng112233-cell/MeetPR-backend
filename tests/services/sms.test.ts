import { randomInt } from 'node:crypto';
import type * as Crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendOtp } from '../../src/services/sms';

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof Crypto>()),
  randomInt: vi.fn(() => 42),
  randomUUID: vi.fn(() => '00000000-0000-4000-8000-000000000000'),
}));

const phone = '13800000000'; // Synthetic test number.
const config = {
  SMS_PROVIDER: 'aliyun' as const,
  ALIYUN_SMS_ACCESS_KEY_ID: 'placeholder-access-key-id',
  ALIYUN_SMS_ACCESS_KEY_SECRET: 'placeholder-access-key-secret',
  ALIYUN_SMS_SIGN_NAME: "测试占位 !'()*~",
  ALIYUN_SMS_TEMPLATE_CODE: 'SMS_PLACEHOLDER',
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SMS provider', () => {
  it('sends a signed Aliyun request and returns the same six-digit code, preserving leading zeros', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ Code: 'OK' }));
    const logger = { warn: vi.fn() };
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const code = await sendOtp(phone, config, logger, fetchMock);
    expect(code).toBe('000042');
    expect(randomInt).toHaveBeenCalledWith(0, 1_000_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    if (typeof url !== 'string') throw new Error('expected SMS URL');
    const requestUrl = new URL(url);
    expect(requestUrl.origin).toBe('https://dysmsapi.aliyuncs.com');
    expect(requestUrl.pathname).toBe('/');
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
      PhoneNumbers: phone,
      SignName: config.ALIYUN_SMS_SIGN_NAME,
      TemplateCode: config.ALIYUN_SMS_TEMPLATE_CODE,
      TemplateParam: JSON.stringify({ code }),
    });
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-acs-action')).toBe('SendSms');
    expect(headers.get('x-acs-version')).toBe('2017-05-25');
    expect(headers.get('x-acs-date')).toBe('2026-11-19T00:00:00Z');
    expect(headers.get('x-acs-signature-nonce')).toBe('00000000-0000-4000-8000-000000000000');
    // Fixed ACS3 vector, independently calculated from a literal canonical request
    // with Python hashlib/hmac per the official V3 signing document.
    expect(headers.get('authorization')).toBe(
      'ACS3-HMAC-SHA256 Credential=placeholder-access-key-id,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=592ca5eef0b43d67d788a9575c5aaebd029cb3692252dbfb56e0ead3c4178db7',
    );
    expect(timeout).toHaveBeenCalledWith(5_000);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([{}, { SMS_PROVIDER: 'stub' as const }])(
    'keeps stub behavior without network access for %j',
    async (stubConfig) => {
      const fetchMock = vi.fn<typeof fetch>();
      const logger = { warn: vi.fn() };
      await expect(sendOtp(phone, stubConfig, logger, fetchMock)).resolves.toBe('000000');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logger.warn.mock.calls).toEqual([[{ phone: '138****0000' }, 'sms_stub_called']]);
    },
  );

  it.each([
    ['+8613800000000', '138****0000'],
    ['bad*13800000000', '****'],
    ['12', '****'],
  ])('never exposes an unmasked number for %s', async (input, masked) => {
    const logger = { warn: vi.fn() };
    await sendOtp(input, {}, logger);
    expect(logger.warn.mock.calls).toEqual([[{ phone: masked }, 'sms_stub_called']]);
  });

  it.each([200, 500])(
    'rejects Aliyun failures at HTTP %s with only the provider Code',
    async (status) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            Code: 'isv.BUSINESS_LIMIT_CONTROL',
            Message: `${phone} 000042 ${config.ALIYUN_SMS_ACCESS_KEY_ID} ${config.ALIYUN_SMS_ACCESS_KEY_SECRET}`,
          },
          { status },
        ),
      );
      await expect(sendOtp(phone, config, undefined, fetchMock)).rejects.toThrow(
        /^Aliyun SMS failed: isv.BUSINESS_LIMIT_CONTROL$/u,
      );
    },
  );

  it('rejects HTTP failures even when the response Code is OK', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ Code: 'OK' }, { status: 500 }));
    await expect(sendOtp(phone, config, undefined, fetchMock)).rejects.toThrow();
  });

  it.each([new Response('not JSON', { status: 500 }), Response.json({}), Response.json(null)])(
    'sanitizes invalid responses',
    async (response) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(sendOtp(phone, config, undefined, fetchMock)).rejects.toThrow(
        /^Aliyun SMS failed$/u,
      );
    },
  );

  it('does not propagate secrets from network or timeout errors', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`${phone} 000042 ${config.ALIYUN_SMS_ACCESS_KEY_SECRET}`));
    await expect(sendOtp(phone, config, undefined, fetchMock)).rejects.toThrow(
      /^Aliyun SMS failed$/u,
    );
  });
});
