import { describe, expect, it } from 'vitest';
import { createI18n, dictionaries, uiKeys } from '../apps/web/src/i18n';

describe('UI i18n', () => {
  it('has identical key sets in zh-CN and en', () => {
    const zh = Object.keys(dictionaries['zh-CN']).sort();
    const en = Object.keys(dictionaries.en).sort();
    expect(zh).toEqual(en);
    expect(zh).toEqual([...uiKeys].sort());
  });

  it('has no empty strings', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      for (const [key, value] of Object.entries(dictionaries[locale])) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  it('translates and interpolates named parameters', () => {
    const i18n = createI18n('en');
    expect(i18n.t('catalog.resultCount', { count: 1 })).toBe('1 experiment');
    expect(i18n.t('catalog.resultCount', { count: 3 })).toBe('3 experiments');
    const zh = createI18n('zh-CN');
    expect(zh.t('catalog.resultCount', { count: 3 })).toContain('3');
  });

  it('falls back to the key and reports the missing key once', () => {
    const missing: string[] = [];
    const i18n = createI18n('en', { onMissingKey: (key) => missing.push(key) });
    expect(i18n.t('catalog.doesNotExist')).toBe('catalog.doesNotExist');
    expect(i18n.t('catalog.doesNotExist')).toBe('catalog.doesNotExist');
    expect(missing).toEqual(['catalog.doesNotExist']);
  });

  it('returns the locale and supports switching dictionaries', () => {
    expect(createI18n('zh-CN').t('nav.catalog')).toBe('实验目录');
    expect(createI18n('en').t('nav.catalog')).toBe('Experiment catalog');
  });
});
