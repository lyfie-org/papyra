import { formatBytes, type FileCardContext } from '@lyfie/luthor-headless';
import { fileTypeOf, type FileFamily } from '../lib/fileTypes';
import { openDocument } from '../lib/documentPreview';
import './FileCard.css';

// A document in a note looks like it does on a desktop: the file's icon and
// its name, nothing else. One click selects it (the toolbar then shows its
// type and size, Preview, Rename, Download…); a double-click opens it. The name
// is the embed's alias (`![[q3.pdf|Q3 report]]`), set with Rename, else the
// file's own name.

/** The little picture on the page: lines of text, a grid, a slide, a zipper. */
function Glyph({ family }: { family: FileFamily }) {
  switch (family) {
    case 'sheet':
      return <path d="M11 17h20v13H11zM11 21.5h20M11 26h20M18 17v13M25 17v13" />;
    case 'slides':
      return <path d="M11 17h20v12H11zM15 32h12" />;
    case 'archive':
      return <path d="M21 4v3M21 9v3M21 14v3M21 19v3M19 24h4v6h-4z" />;
    case 'code':
      return <path d="M16 19l-4 4 4 4M26 19l4 4-4 4M23 17l-4 12" />;
    default:
      return <path d="M11 17h20M11 21h20M11 25h14M11 29h17" />;
  }
}

export function FileIcon({ name }: { name: string }) {
  const type = fileTypeOf(name);
  return (
    <svg className={`file-icon file-icon--${type.family}`} viewBox="0 0 48 58" aria-hidden="true" focusable="false">
      <path className="file-icon__page" d="M8 1.5h24.5L44 13v39.5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-47a4 4 0 0 1 4-4z" />
      <path className="file-icon__fold" d="M32.5 1.5V9a4 4 0 0 0 4 4H44" />
      <g className="file-icon__glyph"><Glyph family={type.family} /></g>
      <rect className="file-icon__band" x="1" y="36" width="36" height="14" rx="3" />
      <text className="file-icon__label" x="19" y="46.2" textAnchor="middle">{type.label}</text>
    </svg>
  );
}

export default function FileCard({ target, fragment, url, meta, label, interactive, selected }: FileCardContext) {
  const type = fileTypeOf(target);
  const size = formatBytes(meta?.size);
  const title = [label, [type.name, size].filter(Boolean).join(' · ')].join('\n');
  const open = () => openDocument({ url, target, fragment, name: label });
  const className = `file-card file-card--${type.family}${selected ? ' is-selected' : ''}`;
  const body = (
    <>
      <FileIcon name={target} />
      <span className="file-card__name">{label}</span>
    </>
  );

  // In an editable note a click selects it (luthor's job) and a double-click
  // opens it; read-only, it opens on a click like a link.
  if (interactive) {
    return (
      <span className={className} title={title} onDoubleClick={open} data-file-family={type.family}>
        {body}
      </span>
    );
  }
  return (
    <a
      className={className}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      data-file-family={type.family}
      onClick={(e) => {
        if (!type.preview || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        open();
      }}
    >
      {body}
    </a>
  );
}
