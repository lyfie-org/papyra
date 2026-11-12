# Translations

Every sentence a person reads lives in `locales/en.json`, not in the component. A language is one more file.

## Add a language

1. Copy `locales/en.json` to `locales/<code>.json` (`de.json`, `pt-BR.json`, `ja.json`: a [BCP-47](https://www.w3.org/International/articles/language-tags/) code).
2. Set `"meta.name"` to the language's own name ("Deutsch"). Translate the values. **Leave out anything you haven't translated yet**: it shows in English until you do.
3. Run `pnpm test`. `catalog.test.ts` fails if a key doesn't exist in English, if a `{value}` or `<tag>` was renamed or dropped, or if a sentence is empty.
4. Nothing to register. The file is found on its own and loaded only when someone picks that language.

To see it: add `?lang=de` to the address (it is remembered), or set the browser's language. `?lang=en-XA` is a made-up
language that accents every catalog string: any sentence that still reads as plain English on screen is not in the catalog yet.

## What a translator may and may not change

| In the text | Rule |
| --- | --- |
| `{name}`, `{count}`, `{version}` | A value filled in by the app. Move it where the sentence needs it. Never rename or remove it. |
| `<link>…</link>`, `<b>…</b>` | Markup the app turns into a link or bold text. Keep the tags, translate what is between them. |
| `key_one`, `key_other` (also `_zero`, `_two`, `_few`, `_many`) | Plural forms. Give the forms your language needs (see the [CLDR plural rules](https://cldr.unicode.org/index/cldr-spec/plural-rules)); `key_other` is always required. |

## For developers

```tsx
import { useT } from '../i18n/store';
import T from '../i18n/T';

const t = useT();                                    // re-renders when the language changes; no provider needed
t('update.badge.tip', { version: 'v1.3.0' });        // "Papyra v1.3.0 is available"
t('notes.count', { count: 3 });                      // picks notes.count_one / notes.count_other / … for the language

<T k="update.dialog.lede"                            // a sentence with a link inside it
   components={{ link: <a href={url} target="_blank" rel="noreferrer" /> }} />
```

- **Keys are typed.** `t('no.such.key')` does not compile. Keys are `area.thing.detail`, camelCase after the first dot.
- **A whole sentence per key.** Never build a sentence from pieces (`t('a') + name + t('b')`): other languages order words differently. Pass the name as a `{value}`.
- **Plurals are never `n === 1 ? '' : 's'`.** Use `_one` / `_other` keys and pass `count`.
- **Dates and numbers** go through `Intl` with `getLocale()`, not hand-built strings.
- Text that comes from the **server** (emails, bot replies, API error messages) is not translated yet.
- `catalog.test.ts` also fails for a key in `en.json` that no code uses, and for code that asks for a key that isn't there.
