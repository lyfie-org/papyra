import { describe, expect, it } from 'vitest';
import { extractMedia } from './noteMedia';
import { extractLinks } from './noteLinks';

describe('extractMedia', () => {
  it('reads sized, aliased and fragment embeds by their file', () => {
    const media = extractMedia('![[a.png|480]]\n![[b.jpg|Alt|640x360]]\n![[doc.pdf#page=3]]');
    expect(media.map((m) => [m.file, m.kind])).toEqual([['a.png', 'image'], ['b.jpg', 'image'], ['doc.pdf', 'pdf']]);
  });

  it('reads a table-escaped embed', () => {
    expect(extractMedia('| ![[t.png\\|200]] |').map((m) => m.file)).toEqual(['t.png']);
  });

  it('treats an /api/media image link as the attachment it is', () => {
    const [m] = extractMedia('![photo](/api/media/linked.jpg)');
    expect(m).toMatchObject({ file: 'linked.jpg', url: '/api/media/linked.jpg' });
  });

  it('keeps a web image as a web image (no thumbnail)', () => {
    const [m] = extractMedia('![](https://example.com/x.png)');
    expect(m.file).toBeUndefined();
    expect(m.url).toBe('https://example.com/x.png');
  });

  it('skips youtube/iframe/card embeds and note transclusions', () => {
    expect(extractMedia('![[youtube:https://youtu.be/abc|cap]] ![[card:https://a.b/c.html]] ![[Other note#^id]]')).toEqual([]);
  });

  it('lists a file once however it is written', () => {
    expect(extractMedia('![[A.png]] ![[a.PNG|300]] ![](/api/media/a.png)')).toHaveLength(1);
  });
});

describe('extractLinks', () => {
  it('does not turn an embedded video or saved card into a second link card', () => {
    expect(extractLinks('![[youtube:https://www.youtube.com/watch?v=abc]]\n![[card:https://example.com/post]]')).toEqual([]);
  });

  it('still finds ordinary links next to embeds', () => {
    expect(extractLinks('![[youtube:https://youtu.be/abc]] see https://example.com/page')).toEqual(['https://example.com/page']);
  });
});
