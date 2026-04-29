import type { Logger } from '../logger';

export async function sendOtp(phone: string, logger?: Pick<Logger, 'warn'>): Promise<string> {
  logger?.warn({ phone }, 'sms_stub_called');
  await Promise.resolve();
  return '000000';
}
