// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import {
  $createParagraphNode, $createTextNode, $getRoot, createEditor, DecoratorNode, type LexicalEditor,
} from 'lexical';
import MediaDropZone from './MediaDropZone';

// The sheet around the editor as a drop target: the overlay must never stick,
// a drop outside the body must reach it at the right edge, and a note ending
// in an attachment must offer a line to type on only when asked — opening it
// must change nothing.

class TestEmbed extends DecoratorNode<null> {
  static getType() { return 'test-embed'; }
  static clone(node: TestEmbed) { return new TestEmbed(node.__key); }
  createDOM() { return document.createElement('div'); }
  updateDOM() { return false; }
  decorate() { return null; }
}

beforeAll(() => {
  // jsdom has no DragEvent.
  if (typeof globalThis.DragEvent === 'undefined') {
    class DragEventPolyfill extends MouseEvent {
      dataTransfer: DataTransfer | null;
      constructor(type: string, init: MouseEventInit & { dataTransfer?: DataTransfer | null } = {}) {
        super(type, init);
        this.dataTransfer = init.dataTransfer ?? null;
      }
    }
    (globalThis as { DragEvent: unknown }).DragEvent = DragEventPolyfill;
  }
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

function files() {
  return { types: ['Files'], files: [new File(['x'], 'a.png', { type: 'image/png' })], dropEffect: 'none' } as unknown as DataTransfer;
}

function setup(build: () => void) {
  const sheet = document.createElement('section');
  const title = document.createElement('input');
  const root = document.createElement('div');
  root.contentEditable = 'true';
  sheet.append(title, root);
  document.body.append(sheet);
  const editor: LexicalEditor = createEditor({ nodes: [TestEmbed], onError: (e) => { throw e; } });
  editor.setRootElement(root);
  editor.update(build, { discrete: true });
  const sheetRef = createRef<HTMLElement>() as { current: HTMLElement | null };
  sheetRef.current = sheet;
  const view = render(<MediaDropZone editor={editor} sheetRef={sheetRef} />);
  return { sheet, title, root, editor, view };
}

const paragraphs = (...texts: string[]) => () => {
  for (const t of texts) $getRoot().append($createParagraphNode().append($createTextNode(t)));
};

describe('MediaDropZone', () => {
  it('lights up for files and clears itself when the dragovers stop', () => {
    vi.useFakeTimers();
    const { title } = setup(paragraphs('One'));
    act(() => { title.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: files() })); });
    expect(document.querySelector('.media-drop')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(450); });
    expect(document.querySelector('.media-drop')).toBeNull();
  });

  it('clears on luthor\'s media-drop and on dragend', () => {
    const { title, root } = setup(paragraphs('One'));
    const over = () => act(() => { title.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: files() })); });
    over();
    act(() => { root.dispatchEvent(new CustomEvent('luthor:media-drop', { bubbles: true })); });
    expect(document.querySelector('.media-drop')).toBeNull();
    over();
    act(() => { window.dispatchEvent(new Event('dragend')); });
    expect(document.querySelector('.media-drop')).toBeNull();
  });

  it('ignores drags that carry no files (text, a reordered block)', () => {
    const { title } = setup(paragraphs('One'));
    const text = { types: ['text/plain'], files: [] } as unknown as DataTransfer;
    act(() => { title.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: text })); });
    expect(document.querySelector('.media-drop')).toBeNull();
  });

  it('hands a drop on the title to the body, aimed at its first block', () => {
    const { title, root } = setup(paragraphs('First', 'Last'));
    root.getBoundingClientRect = () => ({ top: 100, bottom: 300, left: 50, right: 650, width: 600, height: 200 }) as DOMRect;
    const [first, last] = [root.firstElementChild!, root.lastElementChild!];
    first.getBoundingClientRect = () => ({ top: 120, bottom: 140, left: 60, right: 640, width: 580, height: 20 }) as DOMRect;
    last.getBoundingClientRect = () => ({ top: 260, bottom: 280, left: 60, right: 640, width: 580, height: 20 }) as DOMRect;
    const got: DragEvent[] = [];
    root.addEventListener('drop', (e) => got.push(e as DragEvent));

    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: files(), clientX: 70, clientY: 40 });
    act(() => { title.dispatchEvent(drop); });
    expect(drop.defaultPrevented).toBe(true);
    expect(got).toHaveLength(1);
    expect(got[0].clientY).toBe(121);
    expect(got[0].clientX).toBe(68);

    // Below the body → its last block's bottom edge.
    const below = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: files(), clientX: 70, clientY: 400 });
    act(() => { title.parentElement!.dispatchEvent(below); });
    expect(got.at(-1)!.clientY).toBe(279);
  });

  it('leaves a drop the body already took alone', () => {
    const { root } = setup(paragraphs('One'));
    const got = vi.fn();
    root.addEventListener('drop', got);
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: files() });
    root.addEventListener('drop', (e) => e.preventDefault(), { once: true });
    act(() => { root.dispatchEvent(drop); });
    expect(got).toHaveBeenCalledTimes(1); // only the original, no relay
  });

  it('opens a line below a trailing attachment on click — and not before', async () => {
    const { root, editor } = setup(() => {
      $getRoot().append($createParagraphNode().append($createTextNode('Intro')), new TestEmbed());
    });
    const count = () => editor.getEditorState().read(() => $getRoot().getChildrenSize());
    expect(count()).toBe(2); // opening changed nothing
    root.lastElementChild!.getBoundingClientRect = () => ({ top: 10, bottom: 50 }) as DOMRect;

    await act(async () => { root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 30 })); });
    expect(count()).toBe(2); // on the attachment itself: nothing

    await act(async () => { root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 80 })); });
    expect(count()).toBe(3);
    expect(editor.getEditorState().read(() => $getRoot().getLastChild()?.getType())).toBe('paragraph');
  });

  it('does nothing below a note that already ends in text', async () => {
    const { root, editor } = setup(paragraphs('Only text'));
    root.lastElementChild!.getBoundingClientRect = () => ({ top: 10, bottom: 50 }) as DOMRect;
    await act(async () => { root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 80 })); });
    expect(editor.getEditorState().read(() => $getRoot().getChildrenSize())).toBe(1);
  });
});
