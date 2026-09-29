// Block-level three-way merge for markdown bodies.
//
// When the file on disk changes while a room is live (git sync, Syncthing, a
// second editor), the room holds edits the file lacks and the file holds edits
// the room lacks. Neither side may silently win: blocks changed on only one
// side take that side; blocks changed on both sides differently keep BOTH
// (room's first) — duplicated text is recoverable, lost text is not.
//
// Blocks are top-level markdown blocks separated by blank lines, outside
// fenced code (a fence's blank lines don't split it).

export function splitBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let fence: string | null = null

  const push = () => {
    if (current.length > 0) blocks.push(current.join('\n'))
    current = []
  }

  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      current.push(line)
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (marker) {
      fence = marker
      current.push(line)
      continue
    }
    if (line.trim() === '') push()
    else current.push(line)
  }
  push()
  return blocks
}

export function joinBlocks(blocks: string[]): string {
  return blocks.join('\n\n')
}

/** A replaced base range [start, end) and what one side put there. */
interface Hunk {
  start: number
  end: number
  blocks: string[]
  side: 'ours' | 'theirs'
}

/** Longest-common-subsequence alignment → the regions where `side` differs from `base`. */
function hunks(base: string[], side: string[], name: Hunk['side']): Hunk[] {
  const n = base.length
  const m = side.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = base[i] === side[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out: Hunk[] = []
  let i = 0
  let j = 0
  let open: Hunk | null = null
  const flush = () => {
    if (open) out.push(open)
    open = null
  }
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === side[j]) {
      flush()
      i += 1
      j += 1
    } else if (j < m && (i === n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      open ??= { start: i, end: i, blocks: [], side: name }
      open.blocks.push(side[j]!)
      j += 1
    } else {
      open ??= { start: i, end: i, blocks: [], side: name }
      open.end = i + 1
      i += 1
    }
  }
  flush()
  return out
}

function overlaps(a: Hunk, b: Hunk): boolean {
  if (a.start === b.start) return true // incl. two insertions at the same point
  if (a.start < b.end && b.start < a.end) return true
  const inside = (point: Hunk, range: Hunk) =>
    point.start === point.end && range.start < point.start && point.start < range.end
  return inside(a, b) || inside(b, a)
}

/** Rebuild base[lo, hi) with one side's hunks (all within the range) applied. */
function apply(base: string[], lo: number, hi: number, side: Hunk[]): string[] {
  const out: string[] = []
  let at = lo
  for (const hunk of side) {
    out.push(...base.slice(at, hunk.start), ...hunk.blocks)
    at = hunk.end
  }
  out.push(...base.slice(at, hi))
  return out
}

export interface MergeResult {
  markdown: string
  /** True when both sides changed the same region differently (both kept). */
  conflicted: boolean
}

/**
 * diff3 over blocks. `base` is what the room last saved (the common ancestor),
 * `ours` the live room, `theirs` the file now on disk.
 */
export function mergeMarkdown(base: string, ours: string, theirs: string): MergeResult {
  if (ours === theirs) return { markdown: ours, conflicted: false }
  if (base === theirs) return { markdown: ours, conflicted: false }
  if (base === ours) return { markdown: theirs, conflicted: false }

  const b = splitBlocks(base)
  const all = [...hunks(b, splitBlocks(ours), 'ours'), ...hunks(b, splitBlocks(theirs), 'theirs')].sort(
    (x, y) => x.start - y.start || x.end - y.end,
  )

  const out: string[] = []
  let conflicted = false
  let at = 0
  for (let k = 0; k < all.length; ) {
    // Grow a cluster of mutually overlapping hunks.
    const cluster = [all[k]!]
    let lo = all[k]!.start
    let hi = all[k]!.end
    k += 1
    while (k < all.length && cluster.some((hunk) => overlaps(hunk, all[k]!))) {
      lo = Math.min(lo, all[k]!.start)
      hi = Math.max(hi, all[k]!.end)
      cluster.push(all[k]!)
      k += 1
    }
    out.push(...b.slice(at, lo))
    const mine = cluster.filter((hunk) => hunk.side === 'ours')
    const yours = cluster.filter((hunk) => hunk.side === 'theirs')
    const oursText = apply(b, lo, hi, mine)
    const theirsText = apply(b, lo, hi, yours)
    if (mine.length === 0) out.push(...theirsText)
    else if (yours.length === 0) out.push(...oursText)
    else if (joinBlocks(oursText) === joinBlocks(theirsText)) out.push(...oursText)
    else {
      // Same region changed differently on both sides: keep both, room first.
      conflicted = true
      out.push(...oursText, ...theirsText.filter((block) => !oursText.includes(block)))
    }
    at = hi
  }
  out.push(...b.slice(at))
  return { markdown: joinBlocks(out), conflicted }
}
