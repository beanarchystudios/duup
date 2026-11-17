/**
 * A packed R-tree over a page's frames (Sort-Tile-Recursive bulk load), so
 * "what is in this rect" and "what is under this point" cost O(log n + k)
 * instead of a walk over every frame. It is rebuilt whole when the page
 * changes: a rebuild of 50,000 boxes is a few milliseconds, which is cheaper
 * and simpler than patching a dynamic tree on every save.
 *
 * Items keep their input order (the page's paint order, back to front), and
 * every query answers indices into it, ascending, so a caller walking the
 * answer backwards meets the topmost first.
 */

export interface IndexBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const NODE_SIZE = 16

export class SceneIndex {
  /** per node: minX, minY, maxX, maxY; leaves first, then each level above */
  private readonly boxes: Float64Array
  /** per node: for a leaf, the item's index; for an inner node, the index of its first child */
  private readonly refs: Int32Array
  /** where each level starts in `boxes` / `refs`, leaves at 0, plus the end */
  private readonly levels: number[]
  readonly size: number

  constructor(items: readonly IndexBox[]) {
    this.size = items.length
    const n = items.length
    /* a tree of n leaves has at most 2n nodes with a node size over 1 */
    const capacity = Math.max(1, n * 2 + NODE_SIZE)
    this.boxes = new Float64Array(capacity * 4)
    this.refs = new Int32Array(capacity)
    this.levels = [0]
    if (n === 0) {
      this.levels.push(0)
      return
    }
    /* leaves in STR order: sorted into vertical slices by x, each slice by y */
    const order = Array.from({ length: n }, (_, i) => i)
    const cx = (i: number) => (items[i]!.minX + items[i]!.maxX) / 2
    const cy = (i: number) => (items[i]!.minY + items[i]!.maxY) / 2
    order.sort((a, b) => cx(a) - cx(b))
    const leafNodes = Math.ceil(n / NODE_SIZE)
    const slices = Math.ceil(Math.sqrt(leafNodes))
    const perSlice = slices * NODE_SIZE
    for (let s = 0; s < n; s += perSlice) {
      const slice = order.slice(s, s + perSlice).sort((a, b) => cy(a) - cy(b))
      for (let k = 0; k < slice.length; k++) order[s + k] = slice[k]!
    }
    let at = 0
    for (const i of order) {
      const it = items[i]!
      this.boxes[at * 4] = it.minX
      this.boxes[at * 4 + 1] = it.minY
      this.boxes[at * 4 + 2] = it.maxX
      this.boxes[at * 4 + 3] = it.maxY
      this.refs[at] = i
      at++
    }
    /* each level groups NODE_SIZE consecutive nodes of the level below */
    let start = 0
    let end = at
    this.levels.push(end)
    while (end - start > 1) {
      for (let child = start; child < end; child += NODE_SIZE) {
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (let c = child; c < Math.min(end, child + NODE_SIZE); c++) {
          minX = Math.min(minX, this.boxes[c * 4]!)
          minY = Math.min(minY, this.boxes[c * 4 + 1]!)
          maxX = Math.max(maxX, this.boxes[c * 4 + 2]!)
          maxY = Math.max(maxY, this.boxes[c * 4 + 3]!)
        }
        this.boxes[at * 4] = minX
        this.boxes[at * 4 + 1] = minY
        this.boxes[at * 4 + 2] = maxX
        this.boxes[at * 4 + 3] = maxY
        this.refs[at] = child
        at++
      }
      start = end
      end = at
      this.levels.push(end)
    }
  }

  /** Indices of the items whose box meets `box` (edges touching count), ascending. */
  search(box: IndexBox): number[] {
    const out: number[] = []
    if (this.size === 0) return out
    const top = this.levels.length - 2
    /* a stack of (node, level) pairs, starting at the root */
    const stack: number[] = [this.levels[top + 1]! - 1, top]
    while (stack.length) {
      const level = stack.pop()!
      const node = stack.pop()!
      if (level === 0) {
        if (this.meets(node, box)) out.push(this.refs[node]!)
        continue
      }
      if (!this.meets(node, box)) continue
      /* the children sit in the level below, which ends where this one starts */
      const first = this.refs[node]!
      const childEnd = Math.min(first + NODE_SIZE, this.levels[level]!)
      for (let c = first; c < childEnd; c++) stack.push(c, level - 1)
    }
    return out.sort((a, b) => a - b)
  }

  /** Indices of the items under a point, ascending (topmost last). */
  at(x: number, y: number): number[] {
    return this.search({ minX: x, minY: y, maxX: x, maxY: y })
  }

  private meets(node: number, b: IndexBox): boolean {
    const o = node * 4
    return (
      this.boxes[o]! <= b.maxX &&
      this.boxes[o + 2]! >= b.minX &&
      this.boxes[o + 1]! <= b.maxY &&
      this.boxes[o + 3]! >= b.minY
    )
  }
}
