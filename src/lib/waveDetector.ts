import type { Point2 } from './penGeometry'
import { handScale2d, type HandSample } from './snapDetector'

/**
 * STEP 13：手を振る動き（マッチの火を振って消す動き）の判定。
 *
 * 手のひらの中心（手首・人差し指の付け根・小指の付け根の平均）の動きを、画面の横（x）と縦（y）で別々に見る。
 * 一方向に手の大きさ × WAVE_MIN_SWING 以上動いてから、逆向きに同じだけ戻ることを「折り返し」とし、
 * WAVE_WINDOW_MS 以内に WAVE_MIN_REVERSALS 回折り返し、その間の速さの最大が WAVE_MIN_SPEED 以上なら「振った」。
 * - 炎をタバコへ運ぶ動き（一方向に動かすだけ）は折り返しが無いので振ったことにならない。
 * - ゆっくり揺らす・小さく震える・指だけ動かす（指パッチン・灰落とし）も振ったことにならない。
 * 距離は手の大きさ、速さは手の大きさ / 秒で正規化し、時間は推論結果の時刻で測る（フレームレートに依存しない）。
 */
/** 折り返しとみなす振れ幅（手の大きさに対する比率） */
export const WAVE_MIN_SWING = 0.4
/** 振ったとみなす折り返しの回数（2 回 = 往復 1 回と半分。例：右 → 左 → 右） */
export const WAVE_MIN_REVERSALS = 2
/** 折り返しを数える時間 ms */
export const WAVE_WINDOW_MS = 900
/** その間の手の速さの最大の下限（手の大きさ / 秒） */
export const WAVE_MIN_SPEED = 2.5
/** この時間推論結果が来なければ途中経過を捨てる ms */
export const WAVE_LOST_MS = 300

export type WaveDebug = {
  /** 直近 WAVE_WINDOW_MS の折り返しの回数（横・縦の多い方） */
  reversals: number
  /** 直近 WAVE_WINDOW_MS の速さの最大（手の大きさ / 秒） */
  peakSpeed: number
}

type Axis = {
  /** 動いている向き（0 = まだ決まっていない） */
  dir: number
  /** 今の向きでの最も遠い位置 */
  extreme: number
  reversals: number[]
}

type WaveState = {
  x: Axis
  y: Axis
  last: { p: Point2; time: number }
  speeds: { v: number; time: number }[]
}

function palmCenter(s: HandSample): Point2 {
  return { x: (s.wrist.x + s.indexMcp.x + s.pinkyMcp.x) / 3, y: (s.wrist.y + s.indexMcp.y + s.pinkyMcp.y) / 3 }
}

const newAxis = (v: number): Axis => ({ dir: 0, extreme: v, reversals: [] })

/** 1 つの軸の折り返しを数える（swing は振れ幅 px） */
function stepAxis(a: Axis, v: number, swing: number, time: number): void {
  if (a.dir === 0) {
    if (Math.abs(v - a.extreme) >= swing) {
      a.dir = Math.sign(v - a.extreme)
      a.extreme = v
    }
    return
  }
  if ((v - a.extreme) * a.dir > 0) {
    a.extreme = v
  } else if ((a.extreme - v) * a.dir >= swing) {
    a.reversals.push(time)
    a.dir = -a.dir
    a.extreme = v
  }
}

export class WaveDetector {
  private hands = new Map<string, WaveState>()

  reset(): void {
    this.hands.clear()
  }

  debug(handKey: string): WaveDebug | null {
    const h = this.hands.get(handKey)
    if (!h) return null
    return {
      reversals: Math.max(h.x.reversals.length, h.y.reversals.length),
      peakSpeed: h.speeds.reduce((m, s) => Math.max(m, s.v), 0),
    }
  }

  /** 手の新しい推論結果ごとに呼ぶ。振ったと判定したら true（判定した後は数え直す） */
  update(handKey: string, s: HandSample): boolean {
    const p = palmCenter(s)
    let h = this.hands.get(handKey)
    if (!h || s.time - h.last.time > WAVE_LOST_MS) {
      h = { x: newAxis(p.x), y: newAxis(p.y), last: { p, time: s.time }, speeds: [] }
      this.hands.set(handKey, h)
      return false
    }
    if (s.time <= h.last.time) return false
    const scale = handScale2d(s)
    const dt = (s.time - h.last.time) / 1000
    h.speeds.push({ v: Math.hypot(p.x - h.last.p.x, p.y - h.last.p.y) / scale / dt, time: s.time })
    h.last = { p, time: s.time }
    const swing = scale * WAVE_MIN_SWING
    stepAxis(h.x, p.x, swing, s.time)
    stepAxis(h.y, p.y, swing, s.time)
    const recent = (t: number) => s.time - t <= WAVE_WINDOW_MS
    h.x.reversals = h.x.reversals.filter(recent)
    h.y.reversals = h.y.reversals.filter(recent)
    h.speeds = h.speeds.filter((v) => recent(v.time))
    const reversals = Math.max(h.x.reversals.length, h.y.reversals.length)
    const peak = h.speeds.reduce((m, v) => Math.max(m, v.v), 0)
    if (reversals >= WAVE_MIN_REVERSALS && peak >= WAVE_MIN_SPEED) {
      h.x = newAxis(p.x)
      h.y = newAxis(p.y)
      h.speeds = []
      return true
    }
    return false
  }
}
