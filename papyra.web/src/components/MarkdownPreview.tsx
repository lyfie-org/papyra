import { memo, useMemo, type ReactNode } from 'react';
import { parseBlocks, parseInline, type Block, type Inline, type ListBlock } from '../lib/markdownPreview';
import './MarkdownPreview.css';

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text': return n.v;
      case 'strong': return <strong key={i}>{renderInline(n.c)}</strong>;
      case 'em': return <em key={i}>{renderInline(n.c)}</em>;
      case 'del': return <del key={i}>{renderInline(n.c)}</del>;
      case 'mark': return <mark key={i}>{renderInline(n.c)}</mark>;
      case 'code': return <code key={i} className="md-preview__code">{n.v}</code>;
      case 'link': return <span key={i} className="md-preview__link">{renderInline(n.c)}</span>;
      case 'embed': return <span key={i} className="md-preview__embed">{n.v}</span>;
    }
  });
}

/** Inline markdown (bold, links, code…) for a single line, e.g. a to-do item. */
export function InlineMarkdown({ text }: { text: string }) {
  return <>{renderInline(parseInline(text))}</>;
}

function List({ list }: { list: ListBlock }) {
  const Tag = list.ordered ? 'ol' : 'ul';
  return (
    <Tag
      className={`md-preview__list md-preview__list--d${Math.min(list.depth, 2)}`}
      start={list.ordered && list.start !== 1 ? list.start : undefined}
    >
      {list.items.map((item, i) => (
        <li
          key={i}
          className={item.task === null ? undefined : `md-preview__task${item.task ? ' is-done' : ''}`}
        >
          {item.task !== null && <span className="md-preview__box" aria-hidden="true">{item.task ? '✓' : ''}</span>}
          <span className="md-preview__item-text">{renderInline(item.content)}</span>
          {item.children && <List list={item.children} />}
        </li>
      ))}
    </Tag>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.t) {
    case 'p':
      return <p className="md-preview__p">{block.lines.map((l, i) => <span key={i} className="md-preview__line">{renderInline(l)}</span>)}</p>;
    case 'h':
      return <p className={`md-preview__h md-preview__h--${Math.min(block.level, 3)}`}>{renderInline(block.c)}</p>;
    case 'quote':
      return <blockquote className="md-preview__quote">{block.lines.map((l, i) => <span key={i} className="md-preview__line">{renderInline(l)}</span>)}</blockquote>;
    case 'code':
      return <pre className="md-preview__pre">{block.v}</pre>;
    case 'hr':
      return <hr className="md-preview__hr" />;
    case 'embed':
      return <p className="md-preview__p"><span className="md-preview__embed">{block.v}</span></p>;
    case 'list':
      return <List list={block} />;
  }
}

/**
 * A card-sized rendering of a note body — the same shapes the open editor shows
 * (nested lists numbered 1 / a / i, tasks, headings, emphasis) instead of the
 * flattened text cards used to show. Memoised on the body so re-rendering the
 * grid (theme flips, a sibling card's save) never re-parses a note.
 */
const MarkdownPreview = memo(function MarkdownPreview({ body, className }: { body: string; className?: string }) {
  const blocks = useMemo(() => parseBlocks(body).blocks, [body]);
  return (
    <div className={`md-preview${className ? ` ${className}` : ''}`}>
      {blocks.map((b, i) => <BlockView key={i} block={b} />)}
    </div>
  );
});

export default MarkdownPreview;
