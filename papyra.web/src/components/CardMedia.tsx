import { memo, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { FileText, Film, Music, Paperclip, ImageOff } from 'lucide-react';
import { extractMedia, mediaLabel, type NoteMedia } from '../lib/noteMedia';
import { mediaMetaStore, mediaUrl } from '../lib/mediaMeta';
import './CardMedia.css';

const ICON = { video: Film, audio: Music, pdf: FileText, file: Paperclip, image: ImageOff } as const;

/**
 * A note card's attachments, shown as what they are: the first image as a
 * cover across the top of the card (like a photo pinned to the page), a few
 * more as a strip of thumbnails, and anything else as a small labelled chip.
 * Replaces the stored filenames the preview used to print.
 *
 * A vault attachment is drawn from its server thumbnail (320/640 px WebP,
 * cached for good), never the original: a grid of photo notes used to pull
 * every full-size camera image. The box is fixed, so nothing shifts while
 * they load.
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

const own = mediaMetaStore('/api/media');

/**
 * What to put in `src`/`srcSet` for a card picture: a thumbnail when the
 * server has one, else the original (SVG, an animated GIF, a web image, or no
 * metadata). `null` while the metadata is still on its way — the box stays
 * empty for that moment rather than starting the original's download.
 */
function useCardSource(media: NoteMedia, widths: [number, number]) {
  const read = useCallback(() => (media.file ? own.get(media.file) : null), [media.file]);
  const meta = useSyncExternalStore(own.subscribe, read, read);
  if (!media.file) return { src: media.url };
  if (meta === undefined) return null;
  if (!meta?.thumb || meta.animated) return { src: media.url };
  const [small, large] = widths;
  const at = (w: number) => mediaUrl('/api/media', media.file!, { variant: 'thumb', width: w }, meta);
  return { src: at(large), srcSet: `${at(small)} ${small}w, ${at(large)} ${large}w` };
}

/** A thumbnail that fails falls back to the original once; then the picture is given up on. */
function useFallback(media: NoteMedia, widths: [number, number]) {
  const [stage, setStage] = useState<'best' | 'original' | 'failed'>('best');
  const best = useCardSource(media, widths);
  const source = stage === 'original' ? { src: media.url } : best;
  const onError = () => setStage(stage === 'best' && best?.srcSet ? 'original' : 'failed');
  return { source, failed: stage === 'failed', onError };
}

function Cover({ media }: { media: NoteMedia }) {
  const { source, failed, onError } = useFallback(media, [320, 640]);
  if (failed) return null;
  return (
    <div className="card-media__cover">
      {source && (
        <img
          {...source}
          sizes={source.srcSet ? '(max-width: 600px) 100vw, 320px' : undefined}
          alt="" loading="lazy" decoding="async" draggable={false}
          onError={onError}
        />
      )}
    </div>
  );
}

function Thumb({ media }: { media: NoteMedia }) {
  const { source, failed, onError } = useFallback(media, [160, 320]);
  if (failed) return <span className="card-media__thumb-missing"><ImageOff size={14} aria-hidden="true" /></span>;
  return source
    ? <img {...source} sizes={source.srcSet ? '120px' : undefined} alt="" loading="lazy" decoding="async" draggable={false} onError={onError} />
    : null;
}

export default CardMedia;
