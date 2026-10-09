// What a document attachment is, by its extension: the family its icon is
// drawn in, the short label on the icon, a readable name for the toolbar, and
// whether Papyra can show it in place (the browser's PDF viewer, or plain text).

export type FileFamily = 'pdf' | 'doc' | 'sheet' | 'slides' | 'archive' | 'text' | 'code' | 'book' | 'file';

export interface FileType {
  family: FileFamily;
  /** On the icon: `PDF`, `DOCX`, `XLSX`… (the extension, at most 4 letters). */
  label: string;
  /** For people: "PDF document", "Spreadsheet". */
  name: string;
  /** How it previews in place, if it does. */
  preview: 'pdf' | 'text' | null;
}

const FAMILIES: [FileFamily, string, string[]][] = [
  ['pdf', 'PDF document', ['pdf']],
  ['doc', 'Document', ['doc', 'docx', 'odt', 'rtf', 'pages', 'wpd']],
  ['sheet', 'Spreadsheet', ['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv', 'numbers']],
  ['slides', 'Presentation', ['ppt', 'pptx', 'odp', 'key']],
  ['archive', 'Archive', ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']],
  ['book', 'E-book', ['epub', 'mobi', 'azw3']],
  ['text', 'Text', ['txt', 'md', 'markdown', 'log', 'rst', 'org']],
  ['code', 'Code', [
    'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'html', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'rb',
    'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'ps1', 'sql', 'swift',
  ]],
];

const BY_EXTENSION = new Map<string, { family: FileFamily; name: string }>(
  FAMILIES.flatMap(([family, name, extensions]) => extensions.map((ext) => [ext, { family, name }] as const)),
);

/** Plain text a browser can show as-is (and that is cheap to fetch). */
const TEXT_PREVIEW = new Set(['txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'rst', 'org',
  'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'ps1', 'sql', 'swift']);

export function extensionOf(name: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(name.trim());
  return match ? match[1].toLowerCase() : '';
}

export function fileTypeOf(name: string): FileType {
  const ext = extensionOf(name);
  const known = BY_EXTENSION.get(ext);
  return {
    family: known?.family ?? 'file',
    label: (ext || 'file').slice(0, 4).toUpperCase(),
    name: known?.name ?? (ext ? `${ext.toUpperCase()} file` : 'File'),
    preview: ext === 'pdf' ? 'pdf' : TEXT_PREVIEW.has(ext) ? 'text' : null,
  };
}

/** A stored file name without its extension (`q3-report.pdf` → `q3-report`). */
export function baseName(name: string): string {
  return name.replace(/\.[a-z0-9]{1,8}$/i, '');
}
