// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  $createParagraphNode, $createTextNode, $getRoot, $isElementNode, $isTextNode, createEditor, DecoratorNode,
  type LexicalEditor, type SerializedLexicalNode, type Spread,
} from 'lexical';
import { insertTranscript } from './journalEditorOps';

type SerializedPlayer = Spread<{ src: string }, SerializedLexicalNode>;

/** Stands in for luthor's file embed: a block that carries the name of its file. */
class PlayerNode extends DecoratorNode<null> {
  __src: string;
  static getType() { return 'test-player'; }
  static clone(node: PlayerNode) { return new PlayerNode(node.__src, node.__key); }
  constructor(src: string, key?: string) { super(key); this.__src = src; }
  createDOM() { return document.createElement("div"); }
  updateDOM() { return false; }
  decorate() { return null; }
  isInline() { return false; }
  exportJSON(): SerializedPlayer { return { type: 'test-player', version: 1, src: this.__src }; }
  static importJSON(json: SerializedPlayer) { return new PlayerNode(json.src); }
}

function page(build: () => void): LexicalEditor {
  const editor = createEditor({ nodes: [PlayerNode], onError: (e) => { throw e; } });
  editor.setRootElement(document.createElement('div'));
  editor.update(build, { discrete: true });
  return editor;
}

const texts = (editor: LexicalEditor) => editor.read(() => $getRoot().getChildren().map((n) => n.getType() === 'test-player' ? '[player]' : n.getTextContent()));

describe('insertTranscript', () => {
  const para = (text: string) => { const p = $createParagraphNode(); p.append($createTextNode(text)); return p; };

  it('puts the words on a line of their own under the player that made them', () => {
    const editor = page(() => $getRoot().append(para('before'), new PlayerNode('/api/media/voice-1.wav'), para('after')));
    expect(insertTranscript(editor, 'voice-1.wav', '  hello there  ')).toBe(true);
    expect(texts(editor)).toEqual(['before', '[player]', 'Transcript: hello there', 'after']);
  });

  it('finds the right player when there are several, whatever the case of its name', () => {
    const editor = page(() => $getRoot().append(new PlayerNode('a.wav'), new PlayerNode('B.WAV'), para('end')));
    insertTranscript(editor, 'b.wav', 'second');
    expect(texts(editor)).toEqual(['[player]', '[player]', 'Transcript: second', 'end']);
  });

  it('is italic, so it reads as what was said and not as what was written', () => {
    const editor = page(() => $getRoot().append(new PlayerNode('v.wav')));
    insertTranscript(editor, 'v.wav', 'words');
    const italic = editor.read(() => {
      const last = $getRoot().getLastChild();
      const first = $isElementNode(last) ? last.getFirstChild() : null;
      return $isTextNode(first) && first.hasFormat('italic');
    });
    expect(italic).toBe(true);
  });

  it('leaves the page alone when the recording is no longer on it', () => {
    const editor = page(() => $getRoot().append(para('only words')));
    expect(insertTranscript(editor, 'gone.wav', 'lost')).toBe(false);
    expect(texts(editor)).toEqual(['only words']);
  });
});
