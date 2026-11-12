import { Children, cloneElement, Fragment, type ReactElement, type ReactNode } from 'react';
import { fill, parseRich, type Piece, type Values } from './core.ts';
import { message, useLocale, type MessageKey } from './store.ts';

/**
 * A sentence with markup inside it:
 *
 *   "Read the <link>release notes</link> first."
 *   <T k="update.dialog.lede" components={{ link: <a href={url} target="_blank" rel="noreferrer" /> }} />
 *
 * Each `<tag>` in the message becomes the element given for it (its children are the tag's text). A tag
 * nobody gave an element for shows just its text. Values are filled into the text *after* the message is
 * split, so a person's name containing `<b>` is shown as typed and never becomes markup.
 */
export default function T({ k, values, components }: {
  k: MessageKey;
  values?: Values;
  components?: Readonly<Record<string, ReactElement>>;
}) {
  useLocale();
  const count = typeof values?.count === 'number' ? values.count : undefined;
  return <>{render(parseRich(message(k, count)), values, components)}</>;
}

function render(pieces: Piece[], values: Values | undefined, components: Readonly<Record<string, ReactElement>> | undefined): ReactNode {
  return pieces.map((piece, i) => {
    if (typeof piece === 'string') return <Fragment key={i}>{fill(piece, values)}</Fragment>;
    const inner = render(piece.children, values, components);
    const el = components?.[piece.tag];
    if (!el) return <Fragment key={i}>{inner}</Fragment>;
    return cloneElement(el, { key: i }, ...Children.toArray(inner));
  });
}
