import { describe, expect, it } from 'vitest'
import { mergeMarkdown, splitBlocks } from './merge'

describe('splitBlocks', () => {
  it('splits on blank lines but keeps fenced code whole', () => {
    expect(splitBlocks('a\n\nb\n\n```js\nx\n\ny\n```\n\nc')).toEqual(['a', 'b', '```js\nx\n\ny\n```', 'c'])
  })
})

describe('mergeMarkdown (base, room, file)', () => {
  const base = 'Intro\n\nMiddle\n\nOutro'

  it('takes the side that changed when only one did', () => {
    expect(mergeMarkdown(base, base, 'Intro\n\nMiddle (file)\n\nOutro').markdown).toBe('Intro\n\nMiddle (file)\n\nOutro')
    expect(mergeMarkdown(base, 'Intro (room)\n\nMiddle\n\nOutro', base).markdown).toBe('Intro (room)\n\nMiddle\n\nOutro')
  })

  it('combines edits to different blocks from both sides', () => {
    const result = mergeMarkdown(base, 'Intro (room)\n\nMiddle\n\nOutro', 'Intro\n\nMiddle\n\nOutro (file)')
    expect(result).toEqual({ markdown: 'Intro (room)\n\nMiddle\n\nOutro (file)', conflicted: false })
  })

  it('keeps both versions when the same block changed differently — never loses text', () => {
    const result = mergeMarkdown(base, 'Intro\n\nMiddle A\n\nOutro', 'Intro\n\nMiddle B\n\nOutro')
    expect(result.conflicted).toBe(true)
    expect(result.markdown).toBe('Intro\n\nMiddle A\n\nMiddle B\n\nOutro')
  })

  it('keeps blocks added on both sides', () => {
    const result = mergeMarkdown(base, `${base}\n\nRoom tail`, `File head\n\n${base}`)
    expect(result.markdown).toBe(`File head\n\n${base}\n\nRoom tail`)
  })

  it('honours a deletion made on one side', () => {
    expect(mergeMarkdown(base, 'Intro\n\nOutro', base).markdown).toBe('Intro\n\nOutro')
    expect(mergeMarkdown(base, base, 'Intro\n\nOutro').markdown).toBe('Intro\n\nOutro')
  })

  it('is a no-op when both sides agree', () => {
    expect(mergeMarkdown(base, 'Same', 'Same')).toEqual({ markdown: 'Same', conflicted: false })
  })
})

describe('mergeMarkdown never loses a block either side wrote', () => {
  it.each([1, 2, 3, 5, 8, 13, 21, 34])('randomized edits (seed %i)', (initial) => {
    let seed = initial
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const baseBlocks = Array.from({ length: 8 }, (_, i) => `base ${i}`)
    const mutate = (tag: string) => {
      const blocks = [...baseBlocks]
      for (let k = 0; k < 4; k += 1) {
        const at = Math.floor(random() * (blocks.length + 1))
        const roll = random()
        if (roll < 0.4) blocks.splice(at, 0, `${tag} new ${k}`)
        else if (roll < 0.7 && blocks.length > 1) blocks.splice(Math.min(at, blocks.length - 1), 1, `${tag} edit ${k}`)
        else if (blocks.length > 1) blocks.splice(Math.min(at, blocks.length - 1), 1)
      }
      return blocks
    }
    const ours = mutate('ours')
    const theirs = mutate('theirs')
    const result = splitBlocks(
      mergeMarkdown(baseBlocks.join('\n\n'), ours.join('\n\n'), theirs.join('\n\n')).markdown,
    )
    for (const block of [...ours, ...theirs]) {
      if (!baseBlocks.includes(block)) expect(result, block).toContain(block)
    }
  })
})
