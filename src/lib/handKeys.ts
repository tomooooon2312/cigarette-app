import type { Point2 } from './penGeometry'

/** STEP 11：手のキーの割り当てと座標変換（MediaPipe を読み込まずにテストできるよう handTracker から分けた純粋関数） */
export type HandSide = 'left' | 'right' | 'unknown'

/** 前回の手の手首からこの距離（手の大きさ × この値）以内なら同じ手とみなす */
const HAND_MATCH_DISTANCE = 1.5

/** 正規化座標（0〜1）のランドマークを表示座標 px にする。mirror なら左右反転（映像の描画 videoTransform と同じ変換） */
export function toDisplayPoint(p: { x: number; y: number }, width: number, height: number, mirror: boolean): Point2 {
  return { x: (mirror ? 1 - p.x : p.x) * width, y: p.y * height }
}

/**
 * STEP 11：今回の手に、前回の手のキーを割り当てる（手首が近い順）。
 * 1. 同じ側（左右の推定が同じ）の手から、手首が手の大きさ × HAND_MATCH_DISTANCE 以内のもの
 * 2. 残った手は、反対側の手からも同じ距離以内のもの（左右の推定が一瞬入れ替わっても、着火ジェスチャーの途中経過を失わない）
 * 3. それでも無ければ新しいキー（'left'・'right'、使用中なら 'left-1' など）
 */
export function assignHandKeys(
  next: { side: HandSide; wrist: Point2; scale: number }[],
  previous: { key: string; side: HandSide; wrist: Point2 }[],
): string[] {
  const keys: (string | null)[] = next.map(() => null)
  const taken = new Set<string>()
  for (const sameSide of [true, false]) {
    const pairs = next
      .flatMap((n, i) =>
        previous
          .filter((h) => (h.side === n.side) === sameSide)
          .map((h) => ({ i, key: h.key, d: Math.hypot(h.wrist.x - n.wrist.x, h.wrist.y - n.wrist.y) }))
          .filter((m) => m.d <= Math.max(next[m.i].scale, 20) * HAND_MATCH_DISTANCE),
      )
      .sort((a, b) => a.d - b.d)
    for (const { i, key } of pairs) {
      if (keys[i] !== null || taken.has(key)) continue
      keys[i] = key
      taken.add(key)
    }
  }
  return next.map((n, i) => {
    let key = keys[i]
    for (let k = 0; key === null; k++) {
      const candidate = k === 0 ? n.side : `${n.side}-${k}`
      if (!taken.has(candidate)) key = candidate
    }
    taken.add(key)
    return key
  })
}

