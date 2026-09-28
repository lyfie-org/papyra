import { memo, useMemo, useState } from 'react';
import { FileText, Film, Music, Paperclip, ImageOff } from 'lucide-react';
import { extractMedia, mediaLabel, type NoteMedia } from '../lib/noteMedia';
import './CardMedia.css';

const ICON = { video: Film, audio: Music, pdf: FileText, file: Paperclip, image: ImageOff } as const;

/**
 * A note card's attachments, shown as what they are: the first image as a
 * cover across the top of the card (like a photo pinned to the page), a few
 * more as a strip of thumbnails, and anything else as a small labelled chip.
 * Replaces the stored filenames the preview used to print.
 */
const CardMedia = memo(function CardMedia({ body, part }: {
  body: string;
  /** 'cover' = the first image, above the title; 'rest' = more thumbnails and file chips, below the text. */
  part: 'cover' | 'rest';
}) {
  const media = useMemo(() => extractMedia(body), [body]);
  if (media.length === 0) return null;

  const images = media.filter((m) => m.kind === 'image');
  const others = media.filter((m) => m.kind !== 'image');
  const [cover, ...more] = images;
  const strip = more.slice(0, 3);
  const extra = more.length - strip.length;

  if (part === 'cover') return cover ? <Cover media={cover} /> : null;
  if (strip.length === 0 && others.length === 0) return null;

  return (
    <div className="card-media">
      {strip.length > 0 && (
        <div className="card-media__strip">
          {strip.map((m, i) => (
            <span key={m.url} className="card-media__thumb">
              <Thumb media={m} />
              {i === strip.length - 1 && extra > 0 && <span className="card-media__more">+{extra}</span>}
            </span>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <ul className="card-media__chips">
          {others.slice(0, 3).map((m) => {
            const Icon = ICON[m.kind];
            return (
              <li key={m.url} className="card-media__chip" title={m.name}>
                <Icon size={13} aria-hidden="true" /> {mediaLabel(m)}
              </li>
            );
          })}
          {others.length > 3 && <li className="card-media__chip">+{others.length - 3}</li>}
        </ul>
      )}
    </div>
  );
});

function Cover({ media }: { media: NoteMedia }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <div className="card-media__cover">
      <img src={media.url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
    </div>
  );
}

function Thumb({ media }: { media: NoteMedia }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? <span className="card-media__thumb-missing"><ImageOff size={14} aria-hidden="true" /></span>
    : <img src={media.url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />;
}

export default CardMedia;
