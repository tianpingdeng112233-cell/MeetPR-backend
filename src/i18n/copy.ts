import generated from './zh-Hant.generated.json';
import type { CopyLocale, PreferredLocale } from './locale';

const translations: Readonly<Record<string, string>> = generated;

/** Translate only the source template; interpolated user content stays byte-identical. */
export function copy(
  locale: CopyLocale | PreferredLocale | undefined,
  source: string,
  values: readonly (string | number)[] = [],
): string {
  const template = locale === 'zh-Hant' ? (translations[source] ?? source) : source;
  return template.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const value = values[Number(index)];
    return value === undefined ? placeholder : String(value);
  });
}

export function catalogName(
  name: string,
  owner: string | null,
  locale: PreferredLocale | CopyLocale | undefined,
): string {
  return owner === null ? copy(locale, name) : name;
}
