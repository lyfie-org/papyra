import {
  AtSign, Bold, Brackets, CalendarDays, Globe, ImagePlus, ImageUp, LayoutList, List, Paperclip, Plus, SquarePlay,
} from 'lucide-react';
import type { ToolbarLayout } from '@lyfie/luthor';
import type { ExtensiveToolbarItem } from '@lyfie/luthor/presets/extensive';
import { pickFile } from './pickFile';

// Papyra's formatting toolbar: luthor supplies the controls and the seams
// (layout groups, host items, themed input dialogs); what goes where, the icons
// and what Papyra's own inserts do live here.

const ICON = { size: 16, strokeWidth: 2 } as const;

/**
 * Editor features Papyra turns on over the papyra preset's defaults. The
 * preset ships YouTube and web-page embeds off: the insert menu could still add
 * them, but a selected one got no toolbar — no alignment, caption, link, move
 * or remove. Both round-trip through markdown (`![[youtube:url|WxH]]`).
 */
export const PAPYRA_EDITOR_FEATURES = { youTubeEmbed: true, iframeEmbed: true } as const;

/**
 * Eight controls instead of twenty-odd: the block style picker, then groups
 * that open a small row of their tools (a group lights up while something
 * inside it is on), then Papyra's note-linking and insert menu.
 */
export const PAPYRA_TOOLBAR_LAYOUT: ToolbarLayout = {
  sections: [
    { items: ['blockFormat'] },
    {
      items: ['bold', 'italic', 'strikethrough', 'code'],
      group: { id: 'style', label: 'Text style', icon: <Bold {...ICON} /> },
    },
    { items: ['link'] },
    {
      items: ['unorderedList', 'orderedList', 'checkList', 'indentList', 'outdentList'],
      group: { id: 'lists', label: 'Lists', icon: <List {...ICON} /> },
    },
    {
      items: ['quote', 'codeBlock', 'horizontalRule', 'table'],
      group: { id: 'blocks', label: 'Blocks: quote, code, divider, table', icon: <LayoutList {...ICON} /> },
    },
    { items: ['custom:papyra.link-note', 'custom:papyra.mention', 'custom:papyra.insert'] },
  ],
};

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Papyra's own toolbar items. Uploads go through the same path as a paste or a
 * drop (`uploadAndEmbedFile` → the vault's media folder → `![[file]]`), so a
 * picked image and a dropped one land identically in the markdown.
 */
export function createToolbarItems(): ExtensiveToolbarItem[] {
  const upload = async (run: (name: string, ...args: unknown[]) => unknown, accept?: string) => {
    const file = await pickFile(accept);
    if (!file) return;
    // A failed or refused upload is reported once, through the adapter's
    // onUploadError (a toast), and a cancel is no failure: nothing to add here.
    await Promise.resolve(run('uploadAndEmbedFile', file)).catch(() => {});
  };

  return [
    {
      id: 'papyra.link-note',
      label: 'Link a note',
      icon: <Brackets {...ICON} />,
      action: ({ insertText }) => insertText('[['),
    },
    {
      id: 'papyra.mention',
      label: 'Mention someone',
      icon: <AtSign {...ICON} />,
      action: ({ runCommand }) => { runCommand('startMention'); },
    },
    {
      id: 'papyra.insert',
      label: 'Insert',
      icon: <Plus {...ICON} />,
      items: [
        {
          id: 'papyra.upload-image',
          label: 'Upload image or GIF',
          icon: <ImageUp {...ICON} />,
          action: ({ runCommand }) => upload(runCommand, 'image/*'),
        },
        {
          id: 'papyra.image-link',
          label: 'Image from a link',
          icon: <ImagePlus {...ICON} />,
          input: {
            title: 'Insert an image from a link',
            label: 'Image or GIF link',
            placeholder: 'https://…',
            type: 'url',
            extraFields: [{ name: 'alt', label: 'Description (alt text)' }],
          },
          action: ({ runCommand }, src, values) => {
            if (src) runCommand('insertImage', { src, alt: values?.alt ?? '' });
          },
        },
        {
          id: 'papyra.attach',
          label: 'Attach a file',
          icon: <Paperclip {...ICON} />,
          action: ({ runCommand }) => upload(runCommand),
        },
        {
          id: 'papyra.embed-youtube',
          label: 'YouTube video',
          icon: <SquarePlay {...ICON} />,
          input: {
            title: 'Embed a YouTube video',
            label: 'Video link',
            placeholder: 'https://www.youtube.com/watch?v=…',
            submitLabel: 'Embed',
            type: 'url',
          },
          action: ({ runCommand }, url) => { if (url) runCommand('insertYouTubeEmbed', url); },
        },
        {
          id: 'papyra.embed-web',
          label: 'Web page',
          icon: <Globe {...ICON} />,
          input: { title: 'Embed a web page', label: 'Page link', placeholder: 'https://…', submitLabel: 'Embed', type: 'url' },
          action: ({ runCommand }, url) => { if (url) runCommand('insertIframeEmbed', url); },
        },
        {
          id: 'papyra.insert-date',
          label: 'Today’s date',
          icon: <CalendarDays {...ICON} />,
          action: ({ insertText }) => insertText(today()),
        },
      ],
    },
  ];
}
