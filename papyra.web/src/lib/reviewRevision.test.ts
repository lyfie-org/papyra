import { describe, expect, it, vi } from 'vitest';
import { reviewRevision, type Revision } from './reviewRevision';

// The banner's Review used to adopt the outside revision straight over the
// person's unsaved typing — gone from the editor, the disk and History. The
// draft is now kept as a History version first, and only then adopted.

const outside: Revision = { title: 'Plan', body: 'mine\nouter' };

function setup(opts: { draft?: Revision; keep?: (d: Revision) => Promise<string | null> } = {}) {
  let draft: Revision = opts.draft ?? { title: 'Plan', body: 'mine Local words' };
  let incoming: Revision | null = outside;
  const order: string[] = [];
  const keep = vi.fn(async (d: Revision) => {
    order.push(`keep:${d.body}`);
    return opts.keep ? opts.keep(d) : 'v1';
  });
  const adopt = vi.fn((next: Revision) => { order.push(`adopt:${next.body}`); });
  return {
    keep, adopt, order,
    type: (body: string) => { draft = { ...draft, body }; },
    resolve: () => { incoming = null; },
    arrive: (next: Revision) => { incoming = next; },
    run: () => reviewRevision({ getDraft: () => draft, getIncoming: () => incoming, keep, adopt }),
  };
}

describe('Review keeps the unsaved draft before adopting the outside revision', () => {
  it('keeps the draft in History, then adopts', async () => {
    const t = setup();
    expect(await t.run()).toEqual({ adopted: true, kept: 'v1' });
    expect(t.order).toEqual(['keep:mine Local words', 'adopt:mine\nouter']);
    expect(t.keep).toHaveBeenCalledWith({ title: 'Plan', body: 'mine Local words' });
  });

  it('adopts nothing when the draft could not be kept', async () => {
    const t = setup({ keep: async () => { throw new Error('offline'); } });
    expect(await t.run()).toEqual({ adopted: false, reason: 'failed' });
    expect(t.adopt).not.toHaveBeenCalled();
  });

  it('keeps nothing when the draft already reads as the outside revision', async () => {
    const t = setup({ draft: { ...outside } });
    expect(await t.run()).toEqual({ adopted: true, kept: null });
    expect(t.keep).not.toHaveBeenCalled();
    expect(t.adopt).toHaveBeenCalledWith(outside);
  });

  it('keeps words typed while the draft was being kept', async () => {
    let typed = false;
    const t = setup({
      keep: async () => {
        if (!typed) { typed = true; t.type('mine Local words and more'); }
        return 'v';
      },
    });
    await t.run();
    expect(t.order).toEqual([
      'keep:mine Local words', 'keep:mine Local words and more', 'adopt:mine\nouter',
    ]);
  });

  it('adopts the newest outside revision if another arrived meanwhile', async () => {
    const t = setup();
    const newer = { title: 'Plan', body: 'mine\nouter\nouter again' };
    t.keep.mockImplementationOnce(async () => { t.arrive(newer); return 'v1'; });
    await t.run();
    expect(t.adopt).toHaveBeenCalledWith(newer);
  });

  it('stands down when a save resolved the conflict meanwhile', async () => {
    const t = setup();
    t.keep.mockImplementationOnce(async () => { t.resolve(); return 'v1'; });
    expect(await t.run()).toEqual({ adopted: false, reason: 'resolved' });
    expect(t.adopt).not.toHaveBeenCalled();
  });
});
