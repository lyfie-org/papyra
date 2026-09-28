import { memo, useMemo } from 'react';
import { ExternalLink, Globe } from 'lucide-react';
import { extractLinks, hostOf, useLinkPreview } from '../lib/noteLinks';
import './LinkCards.css';

/**
 * The links in a note, as cards under it — the page's picture, title, summary
 * and site — so a saved link is recognisable and one click from open. `compact`
 * is the single-line version a desk card shows for its first link.
 */
const LinkCards = memo(function LinkCards({ body, compact = false }: { body: string; compact?: boolean }) {
  const links = useMemo(() => extractLinks(body, compact ? 1 : 3), [body, compact]);
  if (links.length === 0) return null;
  return (
    <div className={`link-cards${compact ? ' link-cards--compact' : ''}`}>
      {links.map((url) => <LinkCard key={url} url={url} compact={compact} />)}
    </div>
  );
});

export function LinkCard({ url, compact = false }: { url: string; compact?: boolean }) {
  const { data: preview, isLoading } = useLinkPreview(url);
  const host = hostOf(url);
  const title = preview?.title ?? host;

  const className = `link-card${compact ? ' link-card--compact' : ''}${isLoading ? ' is-loading' : ''}`;
  const inner = (
    <>
      {!compact && preview?.image && (
        <span className="link-card__image"><img src={preview.image} alt="" loading="lazy" decoding="async" /></span>
      )}
      <span className="link-card__body">
        <span className="link-card__site">
          {preview?.icon
            ? <img className="link-card__icon" src={preview.icon} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
            : <Globe size={12} aria-hidden="true" />}
          {preview?.siteName ?? host}
        </span>
        <span className="link-card__title">{isLoading ? host : title}</span>
        {!compact && preview?.description && <span className="link-card__desc">{preview.description}</span>}
      </span>
      <ExternalLink className="link-card__out" size={14} aria-hidden="true" />
    </>
  );

  // On a desk card the whole card is already a link into the note, and links
  // can't nest: this one opens the page itself.
  if (compact) {
    const open = (e: React.SyntheticEvent) => {
      e.preventDefault();
      e.stopPropagation();
      window.open(url, '_blank', 'noopener,noreferrer');
    };
    return (
      <span className={className} role="link" tabIndex={0} title={url} onClick={open}
        onKeyDown={(e) => { if (e.key === 'Enter') open(e); }}>
        {inner}
      </span>
    );
  }
  return (
    <a className={className} href={url} target="_blank" rel="noopener noreferrer" title={url}>
      {inner}
    </a>
  );
}

export default LinkCards;
