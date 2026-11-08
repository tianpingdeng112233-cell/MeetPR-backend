import type { Config } from '../config';

export type PreferredLocale = 'zh-Hans' | 'zh-Hant' | 'en';
export type CopyLocale = 'zh' | 'zh-Hant' | 'en';

/** Only explicit canonical tags opt a client into localized responses. */
export function requestLocale(header: string | undefined): PreferredLocale | undefined {
  return header === 'zh-Hans' || header === 'zh-Hant' || header === 'en' ? header : undefined;
}

export function recipientLocale(
  recipient: { phone: string | null; preferred_locale: PreferredLocale | null } | undefined,
  config: Pick<Config, 'JWT_AUDIENCE'>,
): CopyLocale {
  if (recipient?.preferred_locale)
    return recipient.preferred_locale === 'zh-Hans' ? 'zh' : recipient.preferred_locale;
  // The existing Global deployment pins this audience in render-global-app-spec.py.
  return config.JWT_AUDIENCE === 'meetpr-global-client' && recipient?.phone === null ? 'en' : 'zh';
}

export function mailLocale(header: string | undefined, fallback: 'zh' | 'en' = 'en'): CopyLocale {
  const locale = requestLocale(header);
  return locale === 'zh-Hans' ? 'zh' : (locale ?? fallback);
}
