import type { Point2 } from './penGeometry'

/**
 * タバコの着火状態（UNLIT / LIT）。煙の状態機械（smokeStateMachine）とは独立して管理し、
 * LIT のときだけ煙の状態機械を動かす。
 */
export type IgnitionState = 'UNLIT' | 'LIT'

export type IgnitionSettings = {
  /** 火側の端と炎の距離（タバコ CG の全長で正規化）がこれ以下で「炎に当たっている」とみなす */
  igniteDistance: number
}

/** STEP 10 までの着火距離（変更前の値。仕様書・テストの比較用） */
export const PREVIOUS_IGNITE_DISTANCE = 0.25

/** STEP 11：着火距離を 1.5 倍（0.25 → 0.375）にした */
export const DEFAULT_IGNITION: IgnitionSettings = {
  igniteDistance: PREVIOUS_IGNITE_DISTANCE * 1.5,
}

/**
 * STEP 11：着火の確認（括弧内は STEP 10 までの値）。
 * - 炎に当たっている推論結果が confirmFrames 回以上、かつ confirmMs 以上続いたら着火する（3 回・150ms）。
 * - 当たっていないフレームが gapMs 以内なら途中経過を捨てない（一瞬離れても数え直さない。以前は 1 フレームで捨てていた）。
 * - 着火距離 × instantRatio 以内まで近づいたら、その 1 フレームで着火する（一瞬だけ十分に近づいた場合）。
 */
export const IGNITION_TIMING = {
  confirmFrames: 2,
  confirmMs: 80,
  gapMs: 200,
  instantRatio: 0.5,
} as const

/**
 * STEP 11：着火判定に使う炎の形。表示している炎の根元（指先）から先端までの線分で、
 * 火側の端からこの線分までの距離で判定する（描いた炎のどこに当てても着火する）。
 */
export type FlameShape = { base: Point2; tip: Point2 }

export type IgnitionInput = {
  now: number
  /** 火側の端・吸い口側の端（タバコ CG が無ければ null） */
  emberEnd: Point2 | null
  mouthEnd: Point2 | null
  /** タバコ CG の全長 px（距離の正規化に使う） */
  cigaretteLength: number
  /** 現在出ている炎（点、または STEP 11 から根元〜先端の線分） */
  flames: (Point2 | FlameShape)[]
}

export type IgnitionOutput = {
  state: IgnitionState
  /** 最も近い炎と火側の端の距離（正規化）。炎かタバコが無ければ null */
  flameDistance: number | null
  /** このフレームで炎に当たっているか */
  touching: boolean
  /** このフレームで着火したか（演出用） */
  ignitedNow: boolean
  /** STEP 11：最も近い炎の上で、火側の端に最も近い点（デバッグ表示の線） */
  nearestFlamePoint: Point2 | null
  /** STEP 11：着火した・しなかった理由（デバッグ表示） */
  reason: string
}

const dist = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y)

/** 点 p に最も近い、炎（点または線分）の上の点 */
export function nearestOnFlame(p: Point2, f: Point2 | FlameShape): Point2 {
  if (!('base' in f)) return f
  const vx = f.tip.x - f.base.x
  const vy = f.tip.y - f.base.y
  const len2 = vx * vx + vy * vy
  if (len2 === 0) return f.base
  const t = Math.max(0, Math.min(1, ((p.x - f.base.x) * vx + (p.y - f.base.y) * vy) / len2))
  return { x: f.base.x + vx * t, y: f.base.y + vy * t }
}

export class IgnitionStateMachine {
  private state: IgnitionState = 'UNLIT'
  private touchFrames = 0
  private touchSince = 0
  private lastTouchAt = -Infinity

  get current(): IgnitionState {
    return this.state
  }

  /** 手動着火 */
  light(): void {
    this.state = 'LIT'
    this.touchFrames = 0
  }

  /** 消火（着火状態のリセット） */
  extinguish(): void {
    this.state = 'UNLIT'
    this.touchFrames = 0
  }

  update(input: IgnitionInput, s: IgnitionSettings): IgnitionOutput {
    const { emberEnd, mouthEnd, cigaretteLength, flames } = input
    let flameDistance: number | null = null
    let nearestFlamePoint: Point2 | null = null
    let touching = false
    let filterSide = false
    if (emberEnd && mouthEnd && cigaretteLength > 0) {
      for (const f of flames) {
        const q = nearestOnFlame(emberEnd, f)
        const dEmber = dist(q, emberEnd) / cigaretteLength
        const dFilter = dist(nearestOnFlame(mouthEnd, f), mouthEnd) / cigaretteLength
        if (flameDistance === null || dEmber < flameDistance) {
          flameDistance = dEmber
          nearestFlamePoint = q
        }
        // 火側の端が近く、かつ吸い口側より火側の方が炎に近いときだけ（吸い口や胴体を炎に当てても着火しない）
        if (dEmber <= s.igniteDistance) {
          if (dEmber < dFilter) touching = true
          else filterSide = true
        }
      }
    }

    let ignitedNow = false
    let reason: string
    if (this.state === 'LIT') {
      reason = '着火済み'
    } else if (!emberEnd || cigaretteLength <= 0) {
      reason = 'タバコが無い'
    } else if (flames.length === 0) {
      reason = '炎が無い'
    } else if (touching) {
      if (input.now - this.lastTouchAt > IGNITION_TIMING.gapMs) {
        this.touchFrames = 0
      }
      if (this.touchFrames === 0) this.touchSince = input.now
      this.touchFrames++
      this.lastTouchAt = input.now
      const instant = flameDistance !== null && flameDistance <= s.igniteDistance * IGNITION_TIMING.instantRatio
      if (
        instant ||
        (this.touchFrames >= IGNITION_TIMING.confirmFrames && input.now - this.touchSince >= IGNITION_TIMING.confirmMs)
      ) {
        this.state = 'LIT'
        this.touchFrames = 0
        ignitedNow = true
        reason = instant ? '着火（十分に近い）' : '着火'
      } else {
        reason = `炎に当たっている（確認中 ${this.touchFrames}/${IGNITION_TIMING.confirmFrames}）`
      }
    } else {
      if (input.now - this.lastTouchAt > IGNITION_TIMING.gapMs) this.touchFrames = 0
      reason = filterSide
        ? '吸い口側の方が炎に近い'
        : `炎が遠い（×${(flameDistance ?? Infinity).toFixed(2)} > ×${s.igniteDistance.toFixed(2)}）`
    }
    return { state: this.state, flameDistance, touching, ignitedNow, nearestFlamePoint, reason }
  }
}
