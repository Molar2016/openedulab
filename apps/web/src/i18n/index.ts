/**
 * Tiny i18n layer. UI dictionaries are bundled; experiment dictionaries are loaded with
 * the experiment module. Missing keys fall back to the key itself and are reported once,
 * so a broken translation is visible instead of silently blank.
 */
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';
import { SUPPORTED_LOCALES, type Locale } from '../experiment/contract';

export const dictionaries = {
  en,
  'zh-CN': zhCN,
} as const;

export type Dictionary = Record<string, string>;
export const uiKeys = Object.keys(dictionaries.en);

const LOCALE_STORAGE_KEY = 'openedulab.locale';

export interface I18nOptions {
  onMissingKey?: (key: string, locale: Locale) => void;
  dictionaries?: Record<Locale, Dictionary>;
}

export interface I18n {
  locale: Locale;
  t(key: string, params?: Record<string, string | number>): string;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

export function createI18n(locale: Locale, options: I18nOptions = {}): I18n {
  const dict: Dictionary = (options.dictionaries ?? dictionaries)[locale] ?? dictionaries.en;
  const reported = new Set<string>();

  return {
    locale,
    t(key, params) {
      let resolved = key;
      if (params && typeof params.count === 'number') {
        const pluralKey = `${key}.${params.count === 1 ? 'one' : 'many'}`;
        if (Object.prototype.hasOwnProperty.call(dict, pluralKey)) resolved = pluralKey;
      }
      const template = Object.prototype.hasOwnProperty.call(dict, resolved)
        ? dict[resolved]
        : undefined;

      if (template === undefined) {
        if (!reported.has(key)) {
          reported.add(key);
          options.onMissingKey?.(key, locale);
        }
        return key;
      }
      return interpolate(template, params);
    },
  };
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Locale from `?lang=`, then localStorage, then browser language, then zh-CN. */
export function resolveInitialLocale(
  search: string = typeof window === 'undefined' ? '' : window.location.search,
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
  navigatorLanguage: string = typeof navigator === 'undefined' ? '' : navigator.language,
): Locale {
  const fromQuery = new URLSearchParams(search).get('lang');
  if (isLocale(fromQuery)) return fromQuery;

  try {
    const stored = storage?.getItem(LOCALE_STORAGE_KEY) ?? null;
    if (isLocale(stored)) return stored;
  } catch {
    // Storage can be blocked; fall through to browser language.
  }

  return navigatorLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/** Persists only the UI language: not a person, not a session, not a device id. */
export function persistLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Non-fatal: the URL still carries ?lang= for sharing.
  }
}

export { LOCALE_STORAGE_KEY };
