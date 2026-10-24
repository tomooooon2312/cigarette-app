import type { PenDetection, Point2 } from './penGeometry'

/**
 * STEP 6：色だけでなく形でペンらしさを判定する（赤い服・色付きの壁・似た色の物体の誤認識を減らす）。
 * OpenCV に依存しない純粋関数（マスクは 1 チャンネル 8bit の配列として受け取る）。
 */

export type ShapeSettings = {
  /** 形状スコアで候補を除外する（OFF なら STEP 5 までと同じく面積・縦横比だけで判定） */
  enabled: boolean
  /** この値未満の候補はペンとみなさない（0〜1） */
  minScore: number
  /** 手のランドマークの近くにある候補を優先する（手の推論が動いているときだけ） */
  useHands: boolean
}

export const DEFAULT_SHAPE: ShapeSettings = {
  enabled: true,
  minScore: 0.45,
  useHands: true,
}

/** 各特徴のスコア（0〜1、1 がペンらしい） */
export type ShapeScore = {
  total: number
  /** 長さ / 太さ */
  aspect: number
  /** 輪郭が回転矩形を埋める割合（直線的な棒ほど高い。曲がった物・不定形の塊は低い） */
  straightness: number
  /** 軸に沿った幅の均一性 */
  uniformity: number
  /** 輪郭面積（画面に対して大きすぎない） */
  area: number
  /** 回転矩形の大きさ（太さが画面に対して太すぎない） */
  size: number
  /** 手との位置関係（手の推論が無ければ null） */
  hand: number | null
}

/** 手の情報（表示座標 px） */
export type ShapeHand = { points: Point2[]; scale: number }

/** 線形の 0〜1 のランプ（lo 以下で 0、hi 以上で 1） */
const ramp = (x: number, lo: number, hi: number) => Math.min(Math.max((x - lo) / (hi - lo), 0), 1)

export const SHAPE_THRESHOLDS = {
  /** 縦横比：3.5 以下で 0、7 以上で 1（ペンは 10〜15 程度。ライターや箱は 1.3〜4.5、服の袖は 3〜4） */
  aspect: [3.5, 7],
  /** 充填率：0.55 以下で 0、0.8 以上で 1（長方形の棒は 0.9 以上） */
  straightness: [0.55, 0.8],
  /** 幅の変動係数：0.12 以下で 1、0.35 以上で 0（キャップで 3 割太くなるペンは約 0.1。太い胴と細い首の物は約 0.4） */
  uniformity: [0.12, 0.35],
  /** 輪郭面積 / 画面の面積：3% 以下で 1、8% 以上で 0（服・壁・長い棒状の柱は大きい。手に持ったペンは約 1〜3%） */
  areaRatio: [0.03, 0.08],
  /** 太さ / 画面の短辺：8% 以下で 1、18% 以上で 0（服の袖・腕は太い。カメラに非常に近いペンも減点される） */
  thicknessRatio: [0.08, 0.18],
  /** 手の点とペンの軸の距離 / 手の大きさ：0.5 以下で 1、2 以上で 0 */
  handDistance: [0.5, 2],
} as const

/** 手のスコアの重み：手から離れた候補も最大でこの割合までは減点するだけ（机に置いたペンも認識できる） */
const HAND_WEIGHT = 0.25
const SAMPLES = 11

/** 点 p と線分 ab の距離 */
function segmentDistance(p: Point2, a: Point2, b: Point2): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const len2 = abx * abx + aby * aby
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)) : 0
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t))
}

/**
 * 軸に沿って SAMPLES か所で、軸と垂直方向のマスクの幅を測る。
 * 軸上の画素がマスク外（指で隠れたすき間）の位置は 0 を返す（呼び出し側で除外する）。
 */
export function widthProfile(
  mask: ArrayLike<number>,
  width: number,
  height: number,
  pen: Pick<PenDetection, 'center' | 'endpoints' | 'length' | 'thickness'>,
  samples = SAMPLES,
): number[] {
  const [e0, e1] = pen.endpoints
  const len = Math.hypot(e1.x - e0.x, e1.y - e0.y) || 1
  const u = { x: (e1.x - e0.x) / len, y: (e1.y - e0.y) / len }
  const n = { x: -u.y, y: u.x }
  const maxHalf = Math.ceil(pen.thickness * 1.5 + 3)
  const at = (x: number, y: number) => {
    const xi = Math.round(x)
    const yi = Math.round(y)
    return xi >= 0 && yi >= 0 && xi < width && yi < height && mask[yi * width + xi] > 0
  }
  const out: number[] = []
  for (let i = 0; i < samples; i++) {
    // 端は丸み・ぼけで細くなるので、全長の 10〜90% の範囲で測る
    const t = (i / (samples - 1) - 0.5) * 0.8 * pen.length
    const p = { x: pen.center.x + u.x * t, y: pen.center.y + u.y * t }
    if (!at(p.x, p.y)) {
      out.push(0)
      continue
    }
    let w = 1
    for (const sign of [1, -1]) {
      for (let k = 1; k <= maxHalf && at(p.x + n.x * k * sign, p.y + n.y * k * sign); k++) w++
    }
    out.push(w)
  }
  return out
}

/** 幅の変動係数（標準偏差 / 平均）。測れた位置が 3 か所未満なら null */
export function widthVariation(widths: number[]): number | null {
  const xs = widths.filter((w) => w > 0)
  if (xs.length < 3) return null
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length)
  return sd / Math.max(mean, 1)
}

/**
 * 候補（結合後のペン）の形状スコア。
 * total = 形の 5 特徴の幾何平均（どれか 1 つでも極端に悪ければ低くなる）× 手の係数（0.75〜1）。
 */
export function scorePenShape(
  pen: PenDetection,
  mask: ArrayLike<number>,
  hands: ShapeHand[] | null,
): ShapeScore {
  const { frameWidth: W, frameHeight: H } = pen
  const T = SHAPE_THRESHOLDS
  const aspect = ramp(pen.length / Math.max(pen.thickness, 1), T.aspect[0], T.aspect[1])
  // 各輪郭の面積が、その輪郭の回転矩形の面積をどれだけ埋めているか（面積加重）
  let filled = 0
  let boxes = 0
  for (const s of pen.segments) {
    filled += s.area
    boxes += Math.max(s.length * s.thickness, 1)
  }
  const fill = pen.segments.length ? filled / boxes : 1
  const straightness = ramp(fill, T.straightness[0], T.straightness[1])
  const cv = widthVariation(widthProfile(mask, W, H, pen))
  const uniformity = cv === null ? 0.5 : 1 - ramp(cv, T.uniformity[0], T.uniformity[1])
  const area = 1 - ramp(pen.area / Math.max(W * H, 1), T.areaRatio[0], T.areaRatio[1])
  const size = 1 - ramp(pen.thickness / Math.max(Math.min(W, H), 1), T.thicknessRatio[0], T.thicknessRatio[1])

  let hand: number | null = null
  if (hands && hands.length > 0) {
    hand = 0
    for (const h of hands) {
      let d = Infinity
      for (const p of h.points) d = Math.min(d, segmentDistance(p, pen.endpoints[0], pen.endpoints[1]))
      hand = Math.max(hand, 1 - ramp(d / Math.max(h.scale, 1), T.handDistance[0], T.handDistance[1]))
    }
  }

  const parts = [aspect, straightness, uniformity, area, size]
  const shape = Math.exp(parts.reduce((acc, x) => acc + Math.log(Math.max(x, 0.001)), 0) / parts.length)
  const total = shape * (hand === null ? 1 : 1 - HAND_WEIGHT + HAND_WEIGHT * hand)
  return { total, aspect, straightness, uniformity, area, size, hand }
}
