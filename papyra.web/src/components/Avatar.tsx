import { useState } from 'react';
import './Avatar.css';

interface Props {
  /** Whose face. Omit for the signed-in user. */
  username?: string;
  /** Display name, used for the initial when there is no picture. */
  name?: string | null;
  size?: number;
  /** Bump to defeat the browser cache after an upload. */
  version?: number;
  className?: string;
}

/**
 * A person, as a circle. Their picture when they have one, the first letter of
 * their name when they don't.
 *
 * One component everywhere so a face looks the same in the header, the roster,
 * the inbox and a shared note — and so "no picture" is a considered fallback
 * rather than a broken image icon. The image is `aria-hidden`: it is decoration
 * beside a name that is already written out, and "photo of Bea" next to the word
 * Bea is noise.
 */
export default function Avatar({ username, name, size = 32, version = 0, className }: Props) {
  // Remember which URL failed, not merely that one did: a new upload or a
  // different person in the same slot then retries by itself, with no effect to
  // reset the flag.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const base = username ? `/api/auth/avatar/${encodeURIComponent(username)}` : '/api/auth/avatar';
  const src = version ? `${base}?v=${version}` : base;
  const failed = failedSrc === src;
  const initial = (name || username || '?').trim().charAt(0).toUpperCase();

  return (
    <span
      className={`avatar${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {failed
        ? <span aria-hidden="true">{initial}</span>
        : (
          <img src={src} alt="" aria-hidden="true" onError={() => setFailedSrc(src)} />
        )}
    </span>
  );
}
