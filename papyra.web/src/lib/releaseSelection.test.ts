// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, createEditor } from 'lexical';
import { releaseSelectionOnLeave } from './releaseSelection';

afterEach(() => { document.body.innerHTML = ''; });

function setup() {
  document.body.innerHTML = `
    <section class="sheet">
      <input class="title" />
      <div class="canvas"><div class="root" contenteditable="true"></div><input class="link-url" /></div>
    </section>
    <input class="outside" />`;
  const scope = document.querySelector<HTMLElement>('.sheet')!;
  const editor = createEditor({ onError: (e) => { throw e; } });
  editor.setRootElement(document.querySelector<HTMLElement>('.root'));
  editor.update(() => {
    const text = $createTextNode('Pasted body');
    $getRoot().clear().append($createParagraphNode().append(text));
    text.select(11, 11);
  }, { discrete: true });
  const dispose = releaseSelectionOnLeave(editor, scope, '.canvas');
  const hasSelection = () => editor.getEditorState().read(() => $getSelection() !== null);
  const focus = (selector: string) => document.querySelector<HTMLElement>(selector)!.focus();
  return { editor, dispose, hasSelection, focus };
}

describe('releaseSelectionOnLeave', () => {
  it('lets go of the body selection when the title takes focus', () => {
    const { hasSelection, focus } = setup();
    expect(hasSelection()).toBe(true);
    focus('.title');
    expect(hasSelection()).toBe(false);
  });

  it('keeps it for the editor’s own controls and for fields outside the sheet', () => {
    const { hasSelection, focus } = setup();
    focus('.link-url');
    expect(hasSelection()).toBe(true);
    focus('.outside');
    expect(hasSelection()).toBe(true);
  });

  it('a later update no longer pulls focus back into the body', () => {
    const { editor, focus } = setup();
    focus('.title');
    editor.update(() => { $getRoot().markDirty(); }, { discrete: true });
    expect(document.activeElement?.className).toBe('title');
  });

  it('stops listening once disposed', () => {
    const { dispose, hasSelection, focus } = setup();
    dispose();
    focus('.title');
    expect(hasSelection()).toBe(true);
  });
});
