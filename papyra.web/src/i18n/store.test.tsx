// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { availableLocales, DEFAULT_LOCALE, getLocale, initLocale, message, PSEUDO_LOCALE, registerLocale, setLocale, t, useT } from './store';
import T from './T';

// A pretend German, registered for these tests only. It leaves most keys out on purpose.
registerLocale('de', async () => ({
  'meta.name': 'Deutsch',
  'update.dialog.title': 'Neue Version verfügbar',
  'update.dialog.serverVersion': 'Serverversion: {version}',
  'update.dialog.lede': 'Lies die <link>Versionshinweise</link> vor dem Update.',
}));
registerLocale('ar', async () => ({ 'meta.name': 'العربية' }));
registerLocale('broken', async () => { throw new Error('network'); });

beforeEach(async () => { localStorage.clear(); window.history.replaceState(null, '', '/'); await setLocale(DEFAULT_LOCALE, false); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('t', () => {
  it('speaks English by default and fills values', () => {
    expect(t('update.dialog.title')).toBe('New version available');
    expect(t('update.dialog.serverVersion', { version: 'v1.3.0' })).toBe('Server version: v1.3.0');
  });

  it('answers with the language that was chosen, and English for what it lacks', async () => {
    await setLocale('de', false);
    expect(t('update.dialog.title')).toBe('Neue Version verfügbar');
    expect(t('update.dialog.serverVersion', { version: 'v1.3.0' })).toBe('Serverversion: v1.3.0');
    expect(t('update.dialog.acknowledge')).toBe('Acknowledge');      // not translated yet: English, never blank
  });

  it('shows the key itself for a message that does not exist anywhere, so a typo is visible', () => {
    // @ts-expect-error a key that is not in en.json is a compile error
    expect(t('no.such.message')).toBe('no.such.message');
  });

  it('warns in development about a value nobody passed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    t('update.dialog.serverVersion');
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('setLocale', () => {
  it('refuses a language that does not exist or cannot load, and changes nothing', async () => {
    expect(await setLocale('xx')).toBe(false);
    expect(await setLocale('broken')).toBe(false);
    expect(getLocale()).toBe(DEFAULT_LOCALE);
    expect(document.documentElement.lang).not.toBe('xx');
  });

  it('keeps the page’s lang and direction in step', async () => {
    await setLocale('ar', false);
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    await setLocale('de', false);
    expect(document.documentElement.dir).toBe('ltr');
    await setLocale(PSEUDO_LOCALE, false);
    expect(document.documentElement.lang).toBe('en');
  });

  it('remembers the choice unless told not to', async () => {
    await setLocale('de');
    expect(localStorage.getItem('papyra.lang')).toBe('de');
    await setLocale('ar', false);
    expect(localStorage.getItem('papyra.lang')).toBe('de');
  });

  it('survives storage that throws', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(await setLocale('de')).toBe(true);
    expect(getLocale()).toBe('de');
  });

  it('lists English plus every registered language', () => {
    expect(availableLocales()).toEqual(expect.arrayContaining(['en', 'de', 'ar']));
    expect(availableLocales()[0]).toBe('en');
  });
});

describe('the pseudo language', () => {
  it('turns every message into accented text so what is still plain English is easy to see', async () => {
    await setLocale(PSEUDO_LOCALE, false);
    expect(t('update.dialog.acknowledge')).toMatch(/^⟦.*⟧$/);
    expect(t('update.dialog.acknowledge')).not.toContain('Acknowledge');
    expect(t('update.dialog.serverVersion', { version: 'v1' })).toContain('v1');
  });
});

describe('initLocale', () => {
  it('prefers ?lang= over the saved choice', async () => {
    localStorage.setItem('papyra.lang', 'ar');
    window.history.replaceState(null, '', '/?lang=de');
    await initLocale();
    expect(getLocale()).toBe('de');
  });

  it('uses the saved choice, then the browser’s language', async () => {
    localStorage.setItem('papyra.lang', 'ar');
    await initLocale();
    expect(getLocale()).toBe('ar');

    localStorage.clear();
    await setLocale(DEFAULT_LOCALE, false);
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-AT', 'en']);
    await initLocale();
    expect(getLocale()).toBe('de');
    expect(localStorage.getItem('papyra.lang')).toBeNull();      // a guess from the browser is not a choice
  });

  it('stays English when nothing matches', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr']);
    window.history.replaceState(null, '', '/?lang=zz');
    await initLocale();
    expect(getLocale()).toBe(DEFAULT_LOCALE);
  });
});

describe('message', () => {
  it('returns the raw sentence with its markup and values untouched', () => {
    expect(message('update.dialog.lede')).toContain('<link>release notes</link>');
    expect(message('update.dialog.serverVersion')).toContain('{version}');
  });
});

function Probe() {
  const tr = useT();
  return <p>{tr('update.dialog.title')}</p>;
}

describe('components', () => {
  it('re-render when the language changes, with no provider', async () => {
    render(<Probe />);
    expect(screen.getByText('New version available')).toBeTruthy();
    await act(async () => { await setLocale('de', false); });
    expect(screen.getByText('Neue Version verfügbar')).toBeTruthy();
  });

  it('<T> turns tags into the elements given, in either language', async () => {
    const view = <T k="update.dialog.lede" components={{ link: <a href="https://example.test/notes" /> }} />;
    const { rerender } = render(<p>{view}</p>);
    expect(screen.getByRole('link', { name: 'release notes' }).getAttribute('href')).toBe('https://example.test/notes');
    await act(async () => { await setLocale('de', false); });
    rerender(<p>{view}</p>);
    expect(screen.getByRole('link', { name: 'Versionshinweise' }).getAttribute('href')).toBe('https://example.test/notes');
  });

  it('<T> shows just the text of a tag nobody gave an element for', () => {
    render(<p data-testid="p"><T k="update.dialog.lede" /></p>);
    expect(screen.getByTestId('p').textContent).toContain('read the release notes before you update');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('<T> never turns a value into markup', () => {
    // A person named "<link>x</link>" must be shown as typed, not become a link.
    render(<p data-testid="p"><T k="update.dialog.serverVersion" values={{ version: '<link>x</link>' }} components={{ link: <a href="https://evil.test" /> }} /></p>);
    expect(screen.getByTestId('p').textContent).toBe('Server version: <link>x</link>');
    expect(screen.queryByRole('link')).toBeNull();
  });
});
