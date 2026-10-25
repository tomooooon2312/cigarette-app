import type { TrackedHand } from './handTracker'
import type { Point2 } from './penGeometry'
import { handScale2d } from './snapDetector'

/**
 * STEP 12：手がタバコ（ペン）を持っているかの推定（FREE / HOLDING / UNKNOWN）。
 *
 * OpenCV.js のペンの軸（線分）と、MediaPipe Hand Landmarker の親指・人差し指・中指の関節と指先の距離から、
 * 「握っている形」のスコア（0〜1）を手とペンの組ごとに求める。距離は手の大きさで、軸方向の位置はペンの長さで正規化する。
 * 手首とペンの中心の距離だけでは判定しない（手首の近くにペンがあっても、指が軸に沿っていなければ持っていない）。
 *
 * - スコアが HOLD_ENTER_SCORE 以上の状態が HOLD_ENTER_MS 続いたら HOLDING。
 * - HOLDING は、スコアが HOLD_EXIT_SCORE 未満の状態が HOLD_EXIT_MS 続くまで解除しない（ヒステリシス。持ち直し・一瞬のロスト）。
 * - ペンを見失っている間（追跡フィルタの保持中・画面から消えた直後）は、PEN_LOST_GRACE_MS までスコアを更新せず状態を保つ。
 * - その間の値や、指のランドマークが足りないときは UNKNOWN（確信がないので、着火ジェスチャーは止めない）。
 */
export type HoldState = 'FREE' | 'HOLDING' | 'UNKNOWN'

/** 持っているとみなすスコア / 持っていないとみなすスコア */
export const HOLD_ENTER_SCORE = 0.6
export const HOLD_EXIT_SCORE = 0.3
/** HOLDING になるまでに、スコアが HOLD_ENTER_SCORE 以上の状態が続く時間 ms */
export const HOLD_ENTER_MS = 150
/** HOLDING を解除するまでに、スコアが HOLD_EXIT_SCORE 未満の状態が続く時間 ms（持ち直し・指の一時的な離れを許す） */
export const HOLD_EXIT_MS = 400
/** ペンを見失ってから、状態を保つ時間 ms（追跡フィルタの保持 300ms より長い） */
export const PEN_LOST_GRACE_MS = 800
/** 手の推論結果がこの時間来なければ、その手の状態を捨てる ms */
export const HAND_LOST_MS = 500

/** 指が軸に「触れている」とみなす距離（手の大きさに対する比率。これ以下で 1、HOLD_NEAR_FAR で 0） */
export const HOLD_NEAR_FULL = 0.15
export const HOLD_NEAR_FAR = 0.45
/** 軸方向の範囲（吸い口 0 → 火側 1）。火側が分かるペンは火側の端のそばを除く（もう一方の手で火を付ける動きと区別） */
export const HOLD_ALONG_MIN = -0.1
export const HOLD_ALONG_MAX_EMBER = 0.85
export const HOLD_ALONG_MAX = 1.1
/** 別の人のペン（手の持ち主と違う人物のペン）は、スコアがこれ以上のときだけ持っているとみなす */
export const OTHER_OWNER_MIN_SCORE = 0.85

/** 持っているかを調べるペン */
export type HoldPen = {
  /** ペン（タバコ）のキー（デバッグ表示の対応 ID） */
  key: string
  /** そのペンを持つ人物（タバコのキー）。分からなければ null */
  owner: string | null
  /** 吸い口側の端 a・火側の端 b（火側が分からなければ emberKnown = false で、a・b の順番に意味はない） */
  a: Point2
  b: Point2
  emberKnown: boolean
  /** このフレームで実際に検出された（追跡フィルタの保持中ではない） */
  measured: boolean
}

export type HoldView = {
  state: HoldState
  /** 持っている（または候補の）ペンのキー */
  penKey: string | null
  /** そのペンに対する握りのスコア 0〜1（見失っている間は最後の値） */
  score: number
  /** 状態の理由（デバッグ表示） */
  reason: string
}

type HandHold = {
  state: HoldState
  penKey: string | null
  score: number
  /** スコアが HOLD_ENTER_SCORE 以上になった時刻（HOLDING の候補） */
  enterSince: number | null
  /** HOLDING 中に、スコアが HOLD_EXIT_SCORE 未満になった時刻 */
  exitSince: number | null
  /** ペンが見えていた最後の時刻 */
  penSeenAt: number
  lastTime: number
  reason: string
}

/** 指ごとの、軸に沿う点（ランドマーク番号）。ランドマークが無い（テスト用の手）ときは HandSample の点を使う */
const FINGERS = {
  thumb: [4, 3],
  index: [8, 7, 6],
  middle: [12, 11, 10],
} as const

type FingerPoints = { thumb: Point2[]; index: Point2[]; middle: Point2[] }

function fingerPoints(hand: TrackedHand): FingerPoints | null {
  const lm = hand.landmarks
  if (lm.length >= 21) {
    return {
      thumb: FINGERS.thumb.map((i) => lm[i]),
      index: FINGERS.index.map((i) => lm[i]),
      middle: FINGERS.middle.map((i) => lm[i]),
    }
  }
  const s = hand.sample
  if (!s.indexTip) return null
  return {
    thumb: [s.thumbTip],
    index: [s.indexTip, ...(s.indexPip ? [s.indexPip] : [])],
    middle: s.middleTip ? [s.middleTip] : [],
  }
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1)

/** 点の、ペンの軸に対する位置（t：吸い口 0 → 火側 1、d：軸からの距離 px） */
function axisPosition(p: Point2, a: Point2, b: Point2): { t: number; d: number } {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const len2 = vx * vx + vy * vy || 1
  const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2
  const c = Math.max(0, Math.min(1, t))
  return { t, d: Math.hypot(p.x - (a.x + vx * c), p.y - (a.y + vy * c)) }
}

/**
 * 手とペン 1 本の握りのスコア 0〜1。
 * 指ごとに「軸に最も近い点」の近さ（1 = 手の大きさ × HOLD_NEAR_FULL 以内、0 = HOLD_NEAR_FAR 以上）を求め、
 * 親指 × 0.45 + 人差し指と中指の近い方 × 0.45 + 遠い方 × 0.1。
 * 親指だけ・人差し指だけが近い（ペンのそばで指を動かしただけ）では 0.45 までで、持っているとはみなさない。
 */
export function holdScore(hand: TrackedHand, pen: HoldPen): number {
  const f = fingerPoints(hand)
  if (!f) return 0
  const scale = handScale2d(hand.sample)
  const maxT = pen.emberKnown ? HOLD_ALONG_MAX_EMBER : HOLD_ALONG_MAX
  const near = (points: Point2[]) => {
    let best = 0
    for (const p of points) {
      const { t, d } = axisPosition(p, pen.a, pen.b)
      if (t < HOLD_ALONG_MIN || t > maxT) continue
      best = Math.max(best, clamp01((HOLD_NEAR_FAR - d / scale) / (HOLD_NEAR_FAR - HOLD_NEAR_FULL)))
    }
    return best
  }
  const thumb = near(f.thumb)
  const index = near(f.index)
  const middle = near(f.middle)
  return thumb * 0.45 + Math.max(index, middle) * 0.45 + Math.min(index, middle) * 0.1
}

export class HandHoldEstimator {
  private hands = new Map<string, HandHold>()

  reset(): void {
    this.hands.clear()
  }

  view(handKey: string): HoldView {
    const h = this.hands.get(handKey)
    if (!h) return { state: 'FREE', penKey: null, score: 0, reason: '' }
    return { state: h.state, penKey: h.penKey, score: h.score, reason: h.reason }
  }

  /**
   * 手の新しい推論結果ごとに呼ぶ。owners は手の持ち主（手のキー → 人物のキー、複数人モードのみ）。
   * 戻り値は今回の手の状態。
   */
  update(now: number, hands: TrackedHand[], pens: HoldPen[], owners?: Map<string, string | null>): Map<string, HoldView> {
    for (const [key, h] of this.hands) if (now - h.lastTime > HAND_LOST_MS) this.hands.delete(key)
    const out = new Map<string, HoldView>()
    for (const hand of hands) {
      let h = this.hands.get(hand.key)
      if (!h) {
        h = { state: 'FREE', penKey: null, score: 0, enterSince: null, exitSince: null, penSeenAt: -Infinity, lastTime: now, reason: '' }
        this.hands.set(hand.key, h)
      }
      h.lastTime = now
      this.step(h, hand, pens, owners?.get(hand.key) ?? null, now)
      out.set(hand.key, { state: h.state, penKey: h.penKey, score: h.score, reason: h.reason })
    }
    return out
  }

  private step(h: HandHold, hand: TrackedHand, pens: HoldPen[], owner: string | null, now: number): void {
    if (!fingerPoints(hand)) {
      h.reason = '指のランドマークが無い'
      if (h.state !== 'HOLDING') h.state = 'UNKNOWN'
      return
    }
    // 最もスコアの高いペン（今のペンは少し優先して、2 本の間で行き来しない）。別の人のペンは強く握っているときだけ
    let best: { pen: HoldPen; score: number; rank: number } | null = null
    for (const pen of pens) {
      let score = holdScore(hand, pen)
      if (owner !== null && pen.owner !== null && pen.owner !== owner && score < OTHER_OWNER_MIN_SCORE) score = 0
      const rank = score + (pen.key === h.penKey ? 0.05 : 0)
      if (!best || rank > best.rank) best = { pen, score, rank }
    }
    // 持っているペンを見失っている（画面から消えた、または追跡フィルタの保持中で位置が予測）：PEN_LOST_GRACE_MS まで状態を保つ
    const current = h.penKey !== null ? pens.find((p) => p.key === h.penKey) : undefined
    if (h.state === 'HOLDING' && !current?.measured && now - h.penSeenAt <= PEN_LOST_GRACE_MS) {
      h.reason = 'ペンを見失っている（状態を保持）'
      return
    }
    h.score = best?.score ?? 0
    // HOLDING 中に指が離れている間は、対応するペンを変えない
    if (best && best.score > 0 && !(h.state === 'HOLDING' && best.score < HOLD_EXIT_SCORE)) h.penKey = best.pen.key
    if (h.penKey !== null && pens.find((p) => p.key === h.penKey)?.measured) h.penSeenAt = now

    if (h.state === 'HOLDING') {
      if (h.score < HOLD_EXIT_SCORE) {
        h.exitSince ??= now
        if (now - h.exitSince >= HOLD_EXIT_MS) {
          h.state = 'FREE'
          h.enterSince = null
          h.exitSince = null
          h.reason = '指がペンから離れた'
        } else {
          h.reason = `指が離れている（${Math.round(now - h.exitSince)}ms、持ち直しの間は保持）`
        }
      } else {
        h.exitSince = null
        h.reason = 'ペンを握っている'
      }
      return
    }
    if (h.score >= HOLD_ENTER_SCORE) {
      h.enterSince ??= now
      if (now - h.enterSince >= HOLD_ENTER_MS) {
        h.state = 'HOLDING'
        h.exitSince = null
        h.reason = 'ペンを握っている'
      } else {
        h.state = 'UNKNOWN'
        h.reason = '握っている形（確認中）'
      }
      return
    }
    h.enterSince = null
    if (h.score >= HOLD_EXIT_SCORE) {
      h.state = 'UNKNOWN'
      h.reason = '指がペンの近く（判断できない）'
    } else {
      h.state = 'FREE'
      h.penKey = null
      h.reason = ''
    }
  }
}
