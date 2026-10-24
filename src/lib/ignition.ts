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

export const DEFAULT_IGNITION: IgnitionSettings = {
  igniteDistance: 0.25,
}

export const IGNITION_TIMING = {
  /** 炎に当たっている状態がこの回数以上かつこの時間以上続いたら着火する */
  confirmFrames: 3,
  confirmMs: 150,
} as const

export type IgnitionInput = {
  now: number
  /** 火側の端・吸い口側の端（タバコ CG が無ければ null） */
  emberEnd: Point2 | null
  mouthEnd: Point2 | null
  /** タバコ CG の全長 px（距離の正規化に使う） */
  cigaretteLength: number
  /** 現在出ている炎の位置 */
  flames: Point2[]
}

export type IgnitionOutput = {
  state: IgnitionState
  /** 最も近い炎と火側の端の距離（正規化）。炎かタバコが無ければ null */
  flameDistance: number | null
  /** このフレームで炎に当たっているか */
  touching: boolean
  /** このフレームで着火したか（演出用） */
  ignitedNow: boolean
}

export class IgnitionStateMachine {
  private state: IgnitionState = 'UNLIT'
  private touchFrames = 0
  private touchSince = 0

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
    let touching = false
    if (emberEnd && mouthEnd && cigaretteLength > 0 && flames.length > 0) {
      for (const f of flames) {
        const dEmber = Math.hypot(f.x - emberEnd.x, f.y - emberEnd.y) / cigaretteLength
        const dFilter = Math.hypot(f.x - mouthEnd.x, f.y - mouthEnd.y) / cigaretteLength
        if (flameDistance === null || dEmber < flameDistance) flameDistance = dEmber
        // 火側の端が近く、かつ吸い口側より火側の方が炎に近いときだけ（吸い口や胴体を炎に当てても着火しない）
        if (dEmber <= s.igniteDistance && dEmber < dFilter) touching = true
      }
    }

    let ignitedNow = false
    if (this.state === 'UNLIT') {
      if (touching) {
        if (this.touchFrames === 0) this.touchSince = input.now
        this.touchFrames++
        if (
          this.touchFrames >= IGNITION_TIMING.confirmFrames &&
          input.now - this.touchSince >= IGNITION_TIMING.confirmMs
        ) {
          this.state = 'LIT'
          this.touchFrames = 0
          ignitedNow = true
        }
      } else {
        this.touchFrames = 0
      }
    }
    return { state: this.state, flameDistance, touching, ignitedNow }
  }
}
