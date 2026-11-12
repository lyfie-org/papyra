import { useSyncExternalStore } from 'react';
import en from './locales/en.json';
import { bestMatch, directionOf, fill, pick, pseudo, type Catalog, type PluralCategory, type Values } from './core.ts';

/**
 * Translations, in one small module (no library). See `./README.md` for how to add a language.
 *
 *   const t = useT();
 *   t('update.badge.tip', { version })       // a sentence with a value
 *   t('notes.count', { count: 3 })           // plural: notes.count_one / notes.count_other / …
 *
 * English is bundled and is the source of truth for keys. Every other language is its own JSON file in
 * `./locales`, loaded when chosen. A key a language doesn't have falls back to English, so a half-finished
 * translation never shows a blank or a key name.
 */

type EnglishKey = keyof typeof en;
type StripPlural<K> = K extends `${infer B}_${PluralCategory}` ? B : K;
/** Every message key, with plural forms folded into their base (`notes.count_one` → `notes.count`). */
export type MessageKey = StripPlural<EnglishKey>;

export const DEFAULT_LOCALE = 'en';
/** The made-up language for spotting text that isn't coming from a catalog. */
export const PSEUDO_LOCALE = 'en-XA';

const STORAGE_KEY = 'papyra.lang';

// Everything but English is loaded on demand: one network request when someone picks a language.
const files = import.meta.glob<Catalog>(['./locales/*.json', '!./locales/en.json'], { import: 'default' });
const loaders = new Map<string, () => Promise<Catalog>>(
  Object.entries(files).map(([path, load]) => [path.replace(/^.*\//, '').replace(/\.json$/, ''), load]),
);

/** Add a language without a file (tests do this). Files in `./locales` are found on their own. */
export function registerLocale(code: string, load: () => Promise<Catalog>): void {
  loaders.set(code, load);
}

/** Languages a person can choose: English plus every file in `./locales`. */
export function availableLocales(): string[] {
  return [DEFAULT_LOCALE, ...[...loaders.keys()].sort()];
}

/** A language's own name for itself ("Deutsch"), for a picker. */
export function languageName(code: string): string {
  try { return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code; } catch { return code; }
}

let locale = DEFAULT_LOCALE;
let catalog: Catalog = en;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

function apply(code: string, next: Catalog) {
  locale = code;
  catalog = next;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = code === PSEUDO_LOCALE ? 'en' : code;
    document.documentElement.dir = directionOf(code);
  }
  emit();
}

function loadPseudo(): Catalog {
  return Object.fromEntries(Object.entries(en).map(([k, v]) => [k, k === 'meta.name' ? 'Pseudo' : pseudo(v)]));
}

/** Switch language. Resolves false (and changes nothing) when there is no such language or it can't be loaded. */
export async function setLocale(code: string, remember = true): Promise<boolean> {
  try {
    if (code === DEFAULT_LOCALE) apply(DEFAULT_LOCALE, en);
    else if (code === PSEUDO_LOCALE) apply(PSEUDO_LOCALE, loadPseudo());
    else {
      const load = loaders.get(code);
      if (!load) return false;
      apply(code, await load());
    }
  } catch {
    return false;
  }
  if (remember) {
    try { localStorage.setItem(STORAGE_KEY, code); } catch { /* private window: the choice lasts this visit */ }
  }
  return true;
}

/**
 * Pick the starting language: `?lang=` in the address, then the saved choice, then what the browser asks for.
 * Call once before React mounts. English if nothing matches.
 */
export async function initLocale(): Promise<void> {
  const known = [...availableLocales(), PSEUDO_LOCALE];
  let wanted: string | null = null;
  try { wanted = new URLSearchParams(window.location.search).get('lang'); } catch { /* no window */ }
  if (!wanted) { try { wanted = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ } }
  if (wanted) {
    const hit = bestMatch([wanted], known);
    if (hit) { await setLocale(hit); return; }
  }
  const fromBrowser = bestMatch(typeof navigator === 'undefined' ? [] : [...navigator.languages], availableLocales());
  if (fromBrowser && fromBrowser !== DEFAULT_LOCALE) await setLocale(fromBrowser, false);
}

export function getLocale(): string { return locale; }

/**
 * The raw sentence: this language's, else English's, else the key itself (so a typo is visible, never blank).
 * Values are not filled in here; markup is not split.
 */
export function message(key: MessageKey, count?: number): string {
  const here = pick(catalog, key, locale, count);
  if (here !== null) return here;
  // The fallback uses English's own plural rules, not the chosen language's.
  const fallback = pick(en, key, DEFAULT_LOCALE, count);
  if (fallback !== null) return locale === PSEUDO_LOCALE ? pseudo(fallback) : fallback;
  return key;
}

function warnUnfilled(key: string, text: string) {
  if (import.meta.env?.DEV && /\{\w+\}/.test(text)) console.warn(`[i18n] "${key}" has values nobody passed: ${text}`);
}

/** Translate a plain sentence. Use `<T>` instead when the sentence holds `<tags>`. */
export function t(key: MessageKey, values?: Values): string {
  const count = typeof values?.count === 'number' ? values.count : undefined;
  const text = fill(message(key, count), values);
  warnUnfilled(key, text);
  return text;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The active language code; re-renders the component when it changes. */
export function useLocale(): string {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

/** `t`, bound to re-render on a language change. Needs no provider, so a component tests like any other. */
export function useT(): typeof t {
  useLocale();
  return t;
}
