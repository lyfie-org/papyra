import { dayImages, stripThumb } from '../../lib/journalMedia';
import './PhotoStrip.css';

interface Props {
  /** The day's text, as the editor last wrote it. */
  markdown: string;
  /** The editor's page, to find a picture in when its thumbnail is chosen. */
  root: () => HTMLElement | null;
}

/** Where in the page the picture called `name` is drawn (its `src` carries the name, escaped or not). */
function find(root: HTMLElement | null, name: string): HTMLElement | null {
  if (!root) return null;
  const lower = name.toLowerCase();
  const wanted = [lower, encodeURIComponent(lower)];
  for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
    const src = (img.getAttribute('src') ?? '').toLowerCase();
    if (wanted.some((w) => src.includes(`/${w}`) || src.includes(`=${w}`))) return img;
  }
  return null;
}

/**
 * A day's photos at a glance, under the page: small cached thumbnails (the server
 * resizes; no original is fetched), each a button that scrolls the page to its picture.
 * A single photo is already in plain sight, so the strip waits for a second.
 */
export default function PhotoStrip({ markdown, root }: Props) {
  const names = dayImages(markdown);
  if (names.length < 2) return null;
  return (
    <nav className="photo-strip" aria-label={`Photos from this day, ${names.length}`}>
      <ul className="photo-strip__list">
        {names.map((name, i) => (
          <li key={name.toLowerCase()}>
            <button
              type="button"
              className="photo-strip__item"
              aria-label={`Photo ${i + 1} of ${names.length}: ${name}`}
              onClick={() => find(root(), name)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
            >
              <img src={stripThumb(name)} alt="" width={64} height={64} loading="lazy" decoding="async" />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
