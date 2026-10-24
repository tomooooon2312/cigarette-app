import type { Point2 } from './penGeometry'

/** 指パッチン判定に使う手のランドマーク（表示座標 px） */
export type HandSample = {
  /** 推論結果の時刻 ms */
  time: number
  thumbTip: Point2
  middleTip: Point2
  wrist: Point2
  indexMcp: Point2
  pinkyMcp: Point2
  /** 手の大きさ px（手首〜中指の付け根）。距離・速度の正規化に使う */
  scale: number
}

export type SnapSettings = {
  /** 親指と中指の先端の距離（手の大きさで正規化）がこれ以下で「接触」 */
  contactDistance: number
  /** 離れた後、同じ距離がこれ以上で「弾いた」 */
  releaseDistance: number
  /** 接触 → 弾いた の間の中指の先端の速さの下限（手の大きさ / 秒） */
  minSpeed: number
}

export const DEFAULT_SNAP: SnapSettings = {
  contactDistance: 0.35,
  releaseDistance: 0.7,
  minSpeed: 3,
}

export const SNAP_TIMING = {
  /** 接触がこの回数以上の推論結果で続いた後でないと判定しない（単一フレームのノイズ対策） */
  contactSamples: 2,
  /** 最後の接触から、弾いたと判定できるまでの猶予 ms */
  releaseWindowMs: 250,
  /** 判定後、次の判定を受け付けない時間 ms（誤検出・二重判定の防止） */
  cooldownMs: 900,
  /** 手首がこれより速く動いていたら手全体の動きとみなして判定しない（手の大きさ / 秒） */
  maxWristSpeed: 3.5,
  /** 中指の先端が手のひら（手首・人差し指と小指の付け根の重心）へこの量以上近づくこと（手の大きさで正規化） */
  minPalmApproach: 0.1,
  /** この時間サンプルが来なければ手を見失ったとみなし、途中経過を捨てる ms */
  lostMs: 300,
} as const

export type SnapEvent = {
  handKey: string
  /** 炎を出す位置（親指の先端） */
  position: Point2
  time: number
}

export type SnapDebug = {
  /** 親指と中指の距離（正規化） */
  distance: number
  /** 接触中または弾く直前の待機中 */
  armed: boolean
}

type Contact = { sample: HandSample; palmDistance: number }
type HandState = { contactCount: number; lastContact: Contact | null; lastTime: number; debug: SnapDebug }

const dist = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y)
const palmCenter = (s: HandSample): Point2 => ({
  x: (s.wrist.x + s.indexMcp.x + s.pinkyMcp.x) / 3,
  y: (s.wrist.y + s.indexMcp.y + s.pinkyMcp.y) / 3,
})

/**
 * 指パッチンの判定。手ごと（handKey）に直前の推論結果を追跡し、次の流れを満たしたときに 1 回だけ判定する。
 * 1. 親指と中指の先端が接触（または接近）した状態が、2 回以上の推論結果で続く。
 * 2. その後 250ms 以内に、両者の距離が「弾いた」距離以上に開く。
 * 3. その間の中指の先端の速さが下限以上で、中指が手のひら側へ近づいている（中指が親指の付け根を打つ動き）。
 * 4. 手首はほとんど動いていない（手を振っただけの動きを除外）。
 * 左右どちらの手でも同じ判定（左右対称な特徴量だけを使う）。判定後は全体で 900ms のクールダウン。
 */
export class SnapDetector {
  private hands = new Map<string, HandState>()
  private lastSnapAt = -Infinity

  reset(): void {
    this.hands.clear()
    this.lastSnapAt = -Infinity
  }

  debug(handKey: string): SnapDebug | null {
    return this.hands.get(handKey)?.debug ?? null
  }

  /** 新しい推論結果ごとに呼ぶ */
  update(handKey: string, s: HandSample, settings: SnapSettings): SnapEvent | null {
    let h = this.hands.get(handKey)
    if (!h || s.time - h.lastTime > SNAP_TIMING.lostMs) {
      h = { contactCount: 0, lastContact: null, lastTime: s.time, debug: { distance: 0, armed: false } }
      this.hands.set(handKey, h)
    }
    h.lastTime = s.time
    const scale = Math.max(s.scale, 1)
    const d = dist(s.thumbTip, s.middleTip) / scale
    let event: SnapEvent | null = null

    if (d <= settings.contactDistance) {
      h.contactCount++
      h.lastContact = { sample: s, palmDistance: dist(s.middleTip, palmCenter(s)) / scale }
    } else if (h.lastContact) {
      const c = h.lastContact
      const elapsedMs = s.time - c.sample.time
      if (elapsedMs > SNAP_TIMING.releaseWindowMs) {
        h.contactCount = 0
        h.lastContact = null
      } else if (d >= settings.releaseDistance && elapsedMs > 0) {
        const sec = elapsedMs / 1000
        const speed = dist(s.middleTip, c.sample.middleTip) / scale / sec
        const wristSpeed = dist(s.wrist, c.sample.wrist) / scale / sec
        const palmApproach = c.palmDistance - dist(s.middleTip, palmCenter(s)) / scale
        const ok =
          h.contactCount >= SNAP_TIMING.contactSamples &&
          speed >= settings.minSpeed &&
          wristSpeed <= SNAP_TIMING.maxWristSpeed &&
          palmApproach >= SNAP_TIMING.minPalmApproach &&
          s.time - this.lastSnapAt >= SNAP_TIMING.cooldownMs
        if (ok) {
          this.lastSnapAt = s.time
          event = { handKey, position: s.thumbTip, time: s.time }
        }
        // 判定の成否にかかわらず、1 回の「接触 → 弾く」は 1 回だけ評価する
        h.contactCount = 0
        h.lastContact = null
      }
    }
    h.debug = { distance: d, armed: h.lastContact !== null }
    return event
  }
}
