import { describe, expect, it, vi } from 'vitest';
import { PAPYRA_TOOLBAR_LAYOUT, createToolbarItems } from './editorToolbar';

describe('Papyra toolbar', () => {
  it('keeps the visible row short: text styles in the bar, lists and blocks in groups', () => {
    const sections = PAPYRA_TOOLBAR_LAYOUT.sections;
    // Each group is one button; ungrouped sections contribute their items.
    const visible = sections.reduce((n, s) => n + (s.group ? 1 : s.items.length), 0);
    expect(visible).toBeLessThanOrEqual(11);
    expect(sections.filter((s) => s.group).map((s) => s.group!.id)).toEqual(['lists', 'blocks']);
    // The four text styles are one click each, not behind a pop-out.
    const styles = sections.find((s) => s.items.includes('bold'));
    expect(styles?.group).toBeUndefined();
    expect(styles?.items).toEqual(['bold', 'italic', 'strikethrough', 'code']);
    // Undo/redo stay on the keyboard; luthor's own image menu is replaced by Insert.
    const items = sections.flatMap((s) => s.items);
    expect(items).not.toContain('undo');
    expect(items).not.toContain('image');
  });

  it('places every Papyra item the layout names', () => {
    const ids = createToolbarItems().map((i) => i.id);
    const placed = PAPYRA_TOOLBAR_LAYOUT.sections.flatMap((s) => s.items)
      .filter((i) => i.startsWith('custom:')).map((i) => i.slice('custom:'.length));
    expect(placed.every((id) => ids.includes(id))).toBe(true);
  });

  it('routes inserts to the editor commands', async () => {
    const insert = createToolbarItems().find((i) => i.id === 'papyra.insert')!;
    const byId = (id: string) => insert.items!.find((i) => i.id === id)!;
    const ctx = { insertText: vi.fn(), hasCommand: vi.fn(() => true), runCommand: vi.fn() };

    await byId('papyra.image-link').action!(ctx, 'https://x.test/a.png', { value: 'https://x.test/a.png', alt: 'A' });
    expect(ctx.runCommand).toHaveBeenLastCalledWith('insertImage', { src: 'https://x.test/a.png', alt: 'A' });

    await byId('papyra.embed-youtube').action!(ctx, 'https://youtu.be/x');
    expect(ctx.runCommand).toHaveBeenLastCalledWith('insertYouTubeEmbed', 'https://youtu.be/x');

    await byId('papyra.insert-date').action!(ctx);
    expect(ctx.insertText).toHaveBeenLastCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });
});
