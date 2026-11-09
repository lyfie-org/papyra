import { describe, expect, it } from 'vitest';
import { baseKey, compareCatalogs, placeholders } from './core';

// Guards the files translators work in, and the link between the catalog and the code that uses it.
// Reads files through Vite's glob (not node:fs) so this file type-checks under the app's own tsconfig.

type Catalog = Record<string, string>;
const locales = import.meta.glob<Catalog>('./locales/*.json', { eager: true, import: 'default' });
const files = Object.keys(locales).map(path => path.replace('./locales/', '')).sort();
const read = (file: string): Catalog => locales[`./locales/${file}`];
const en = read('en.json');

const sources = import.meta.glob<string>(
  ['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../i18n/**', '!../demo/**'],
  { eager: true, query: '?raw', import: 'default' },
);

describe('English catalog', () => {
  it('is flat text, named like a language, with sound plural groups', () => {
    expect(en['meta.name']).toBe('English');
    for (const [key, text] of Object.entries(en)) {
      expect(typeof text, key).toBe('string');
      expect(text.trim(), key).not.toBe('');
      expect(key, key).toMatch(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*(_(zero|one|two|few|many|other))?$/);
    }
    for (const base of new Set(Object.keys(en).map(baseKey))) {
      const forms = Object.keys(en).filter(k => baseKey(k) === base && k !== base);
      if (forms.length) expect(en, `${base} needs ${base}_other`).toHaveProperty(`${base}_other`);
      if (forms.length) expect(en, `${base} must not also be a plain key`).not.toHaveProperty(base);
    }
  });

  it('gives every plural message a {count}', () => {
    for (const [key, text] of Object.entries(en)) {
      if (baseKey(key) !== key && !key.endsWith('_one')) expect(placeholders(text), key).toContain('count');
    }
  });
});

describe.each(files.filter(f => f !== 'en.json'))('language file %s', file => {
  it('matches English: no invented keys, same {values} and <tags>, nothing empty', () => {
    expect(compareCatalogs(en, read(file))).toEqual([]);
  });
  it('is named for the language and sits under its code', () => {
    expect(file).toMatch(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*\.json$/);
    expect(read(file)['meta.name']?.trim()).toBeTruthy();
  });
});

describe('the code and the catalog agree', () => {
  const used = new Map<string, string>();         // key -> first file
  for (const [file, text] of Object.entries(sources)) {
    for (const m of text.matchAll(/\bt\(\s*'([a-z][A-Za-z0-9.]*)'/g)) used.set(m[1], file);
    for (const m of text.matchAll(/\bk="([a-z][A-Za-z0-9.]*)"/g)) used.set(m[1], file);
  }
  const bases = new Set(Object.keys(en).map(baseKey));

  it('every message the code asks for is in en.json', () => {
    const missing = [...used].filter(([key]) => !bases.has(key)).map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });

  it('every message in en.json is used, so dead text does not pile up for translators', () => {
    const unused = [...bases].filter(key => key !== 'meta.name' && !used.has(key));
    expect(unused).toEqual([]);
  });
});
