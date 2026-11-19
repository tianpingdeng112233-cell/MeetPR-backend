import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import type { Config } from '../config';
import type { Logger } from '../logger';

type SmsConfig = Pick<
  Config,
  | 'SMS_PROVIDER'
  | 'ALIYUN_SMS_ACCESS_KEY_ID'
  | 'ALIYUN_SMS_ACCESS_KEY_SECRET'
  | 'ALIYUN_SMS_SIGN_NAME'
  | 'ALIYUN_SMS_TEMPLATE_CODE'
>;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const percentEncode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export async function sendOtp(
  phone: string,
  config: SmsConfig = {},
  logger?: Pick<Logger, 'warn'>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if ((config.SMS_PROVIDER ?? 'stub') === 'stub') {
    const parts = /^(?:\+86)?(\d{3})\d{4}(\d{4})$/u.exec(phone);
    const maskedPhone = parts ? `${parts[1] ?? ''}****${parts[2] ?? ''}` : '****';
    logger?.warn({ phone: maskedPhone }, 'sms_stub_called');
    return '000000';
  }

  const {
    ALIYUN_SMS_ACCESS_KEY_ID: accessKeyId,
    ALIYUN_SMS_ACCESS_KEY_SECRET: accessKeySecret,
    ALIYUN_SMS_SIGN_NAME: signName,
    ALIYUN_SMS_TEMPLATE_CODE: templateCode,
  } = config;
  if (!accessKeyId || !accessKeySecret || !signName || !templateCode) {
    throw new Error('Aliyun SMS configuration incomplete');
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const parameters: Record<string, string> = {
    PhoneNumbers: phone,
    SignName: signName,
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify({ code }),
  };
  const query = Object.entries(parameters)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
    .join('&');
  const headers: Record<string, string> = {
    host: 'dysmsapi.aliyuncs.com',
    'x-acs-action': 'SendSms',
    'x-acs-content-sha256': sha256(''),
    'x-acs-date': new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
    'x-acs-signature-nonce': randomUUID(),
    'x-acs-version': '2017-05-25',
  };
  // ACS3: https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
  const headerNames = Object.keys(headers).sort();
  const signedHeaders = headerNames.join(';');
  const canonicalHeaders = headerNames.map((name) => `${name}:${headers[name] ?? ''}\n`).join('');
  const canonicalRequest = ['POST', '/', query, canonicalHeaders, signedHeaders, sha256('')].join(
    '\n',
  );
  const signature = createHmac('sha256', accessKeySecret)
    .update(`ACS3-HMAC-SHA256\n${sha256(canonicalRequest)}`)
    .digest('hex');
  headers.Authorization = `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;

  let response: Response;
  let payload: unknown;
  try {
    response = await fetchImpl(`https://dysmsapi.aliyuncs.com/?${query}`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    payload = await response.json();
  } catch {
    // Network and JSON errors can contain the request URL or response body.
    throw new Error('Aliyun SMS failed');
  }
  const providerCode =
    payload && typeof payload === 'object' && 'Code' in payload ? payload.Code : undefined;
  if (!response.ok || providerCode !== 'OK') {
    // Only expose a machine code, never the provider's free-form Message/body.
    const safeCode =
      typeof providerCode === 'string' && /^[A-Za-z][A-Za-z_.]{0,127}$/u.test(providerCode)
        ? providerCode
        : undefined;
    throw new Error(safeCode ? `Aliyun SMS failed: ${safeCode}` : 'Aliyun SMS failed');
  }
  return code;
}
