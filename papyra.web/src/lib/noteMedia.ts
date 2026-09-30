// The attachments a note body embeds — `![[file.ext]]` (Obsidian style, what the
// editor writes) and `![alt](url)` — so a card can show them as pictures and
// icons instead of printing the stored filename ("1858b168a2c-be42….jpg").
// Target parsing is shared with the editor and the server (see mediaRefs.ts).

import { attachmentFromUrl, embedTarget, isUrlEmbed } from './mediaRefs';
import { mediaUrl } from './mediaMeta';

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'file';

export interface NoteMedia {
  /** The name as written (file name, or the URL for a markdown image). */
  name: string;
  kind: MediaKind;
  /** Where the browser can load the original. */
  url: string;
  /** The vault attachment's filename (thumbnails and metadata exist for these); absent for a web image. */
  file?: string;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v|ogv|mkv)$/i;
const AUDIO = /\.(mp3|m4a|wav|ogg|oga|flac|aac|opus)$/i;
const PDF = /\.pdf$/i;

export function mediaKind(name: string): MediaKind {
  const bare = name.split(/[?#]/)[0];
  if (IMAGE.test(bare)) return 'image';
  if (VIDEO.test(bare)) return 'video';
  if (AUDIO.test(bare)) return 'audio';
  if (PDF.test(bare)) return 'pdf';
  return 'file';
}

const OWN_MEDIA = '/api/media';
const WIKI_EMBED = /!\[\[([^\]]+)\]\]/g;
const MD_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Every embedded attachment, in order, without duplicates. Code blocks are skipped. */
export function extractMedia(body: string): NoteMedia[] {
  if (!body || !body.includes('![')) return [];
  const out: NoteMedia[] = [];
  const seen = new Set<string>();
  // Drop fenced code first: an embed written as an example isn't an attachment.
  const text = body.replace(/(^|\n)\s{0,3}(```|~~~)[\s\S]*?\n\s{0,3}\2[^\n]*/g, '\n');

  const attach = (target: string) => {
    const file = target.replace(/\\/g, '/').split('/').pop()!.trim();
    const key = file.toLowerCase();
    if (!file || seen.has(key)) return;
    seen.add(key);
    out.push({ name: file, kind: mediaKind(file), url: mediaUrl(OWN_MEDIA, file), file });
  };

  for (const m of text.matchAll(WIKI_EMBED)) {
    const target = embedTarget(m[1]);
    // youtube:/iframe:/card: embeds aren't attachments; a note transclusion
    // (![[Other note#^id]]) has no extension.
    if (!target || isUrlEmbed(target) || !/\.[a-z0-9]{2,5}$/i.test(target)) continue;
    attach(target);
  }
  for (const m of text.matchAll(MD_IMAGE)) {
    const url = m[2].replace(/^<|>$/g, '');
    const file = attachmentFromUrl(url);
    if (file) { attach(file); continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ name: m[1].split('|')[0] || url.split('/').pop() || 'image', kind: mediaKind(url) === 'file' ? 'image' : mediaKind(url), url });
  }
  return out;
}

/** A readable label for a stored file: its extension-less tail, never the long random prefix. */
export function mediaLabel(m: NoteMedia): string {
  const ext = m.name.includes('.') ? m.name.split('.').pop()!.toUpperCase() : '';
  switch (m.kind) {
    case 'image': return 'Image';
    case 'video': return ext ? `${ext} video` : 'Video';
    case 'audio': return ext ? `${ext} audio` : 'Audio';
    case 'pdf': return 'PDF';
    default: return ext ? `${ext} file` : 'File';
  }
}
