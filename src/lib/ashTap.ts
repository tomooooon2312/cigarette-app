import type { Point2 } from './penGeometry'
import { handScale2d, type HandSample } from './snapDetector'

/**
 * STEP 10：人差し指でタバコを「トントン」と叩く動き（灰落とし）の判定。
 *
 * カメラの映像だけでは指がタバコに触れたかを確定できないため、
 * 「人差し指の先端がタバコの軸に素早く近づき、短時間で離れる」動き（タップ）を、近さと動きの組み合わせで推定する。
 * タップが一定時間内に決められた回数（既定 2 回）続いたら、灰落としを 1 回だけ判定する。
 *
 * - 位置はタバコの向きに合わせた相対座標（軸方向 t：全長に対する比率、軸からの距離 r：手の大きさに対する比率）で測る。
 *   手のひら側・手の甲側・斜めのどれでも、人差し指の先端の位置だけを使うので同じ判定になる。
 * - タバコ（ペン）ごと手を動かしただけでは、指とタバコの相対位置が変わらないので判定しない。
 *   また、近づく間に指がタバコより大きく動いていること（指の動きでタップしたこと）を条件にする。
 * - 近づけただけ（ゆっくり近づいた・近くに置いたまま）では判定しない。
 */
export type AshSettings = {
  /** 灰落とし（タップの判定と灰の表示）を使う */
  enabled: boolean
  /** タバコの表面からの距離がこれ以下で「叩いた」（手の大きさに対する比率） */
  tapNear: number
  /** 叩いた後、これ以上離れたら 1 回のタップ（手の大きさに対する比率。tapNear より大きくしてヒステリシスにする） */
  tapFar: number
  /** 近づく速さの下限（手の大きさ / 秒） */
  tapMinSpeed: number
  /** 灰を落とすのに必要なタップの回数 */
  taps: number
  /** 1 回目のタップから、必要な回数のタップを終えるまでの制限時間 ms */
  tapWindowMs: number
  /** 灰を落とした後、そのタバコで次の灰落としを受け付けない時間 ms */
  cooldownMs: number
  /** 灰が伸びる速さ（タバコの全長に対する比率 / 秒） */
  growthRate: number
}

export const DEFAULT_ASH: AshSettings = {
  enabled: true,
  tapNear: 0.12,
  tapFar: 0.3,
  tapMinSpeed: 1.0,
  taps: 2,
  tapWindowMs: 1000,
  cooldownMs: 1200,
  growthRate: 0.006,
}

export const TAP_TIMING = {
  /** 最後に離れていた推論結果から、叩いた位置に届くまでの制限時間 ms（これより遅い＝ゆっくり近づけた） */
  maxApproachMs: 400,
  /** 叩いた位置にとどまってよい時間 ms（これより長い＝近くに置いたまま） */
  maxContactMs: 400,
  /** 軸方向で、叩いたとみなす範囲（全長に対する比率。中心が 0、吸い口 −0.5、火側 +0.5。火側の先の灰も含める） */
  alongMin: -0.55,
  alongMax: 0.7,
  /** 近づく間の、指の動き ÷ タバコの動き の下限（タバコを動かして指に当てただけの動きを除く） */
  minFingerToPenMove: 1.2,
  /** 着火ジェスチャーに成功した手は、この時間タップを判定しない ms */
  snapBlockMs: 500,
  /** この時間サンプルが来なければ手を見失ったとみなし、途中経過を捨てる ms */
  lostMs: 300,
} as const

/** 叩く対象のタバコ（着火済み・シケモクでないものだけを渡す） */
export type TapTarget = {
  key: string
  center: Point2
  /** 吸い口 → 火 の単位ベクトル */
  dir: Point2
  length: number
  thickness: number
}

export type TapHandOptions = {
  /** この手が叩いてよいタバコのキー（複数人：持ち主の人物のタバコだけ）。null なら制限なし */
  allowedKeys: Set<string> | null
  /** 着火ジェスチャーの途中・直後：タップの候補を取り消す */
  blocked: boolean
}

export type AshTapEvent = { cigaretteKey: string; handKey: string; time: number }

export type TapPhase = 'far' | 'between' | 'near'

export type TapDebug = {
  targetKey: string | null
  /** タバコの表面からの距離（手の大きさに対する比率） */
  distance: number
  /** 軸方向の位置（全長に対する比率） */
  along: number
  phase: TapPhase
  /** 数えたタップの回数（制限時間内） */
  taps: number
  /** 直前に数えなかった理由（数えたら空） */
  lastReason: string
}

type Snapshot = { time: number; r: number; finger: Point2; penCenter: Point2 }
type TapState = {
  targetKey: string | null
  phase: TapPhase
  /** 最後に「離れている」だった推論結果 */
  lastFar: Snapshot | null
  /** 叩いた位置に入った時刻と、その近づき方が有効だったか */
  nearAt: number
  nearValid: boolean
  taps: number[]
  lastTime: number
  debug: TapDebug
}

const dot = (a: Point2, b: Point2) => a.x * b.x + a.y * b.y
const dist = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y)

/** 指先の、タバコに対する相対位置（r：表面からの距離 / 手の大きさ、t：軸方向 / 全長） */
export function tapCoordinates(finger: Point2, target: TapTarget, handScale: number): { r: number; t: number } {
  const v = { x: finger.x - target.center.x, y: finger.y - target.center.y }
  const n = { x: -target.dir.y, y: target.dir.x }
  const t = dot(v, target.dir) / Math.max(target.length, 1)
  const r = Math.max(0, Math.abs(dot(v, n)) - target.thickness / 2) / Math.max(handScale, 1)
  return { r, t }
}

export class AshTapDetector {
  private hands = new Map<string, TapState>()
  private lastDropAt = new Map<string, number>()

  reset(): void {
    this.hands.clear()
    this.lastDropAt.clear()
  }

  /** タバコの灰落としのクールダウンを消す（タバコが新品に戻ったとき） */
  forgetTarget(key: string): void {
    this.lastDropAt.delete(key)
  }

  debug(handKey: string): TapDebug | null {
    return this.hands.get(handKey)?.debug ?? null
  }

  /** 手の新しい推論結果ごとに呼ぶ。灰を落とすと判定したらイベントを返す */
  update(handKey: string, s: HandSample, targets: TapTarget[], settings: AshSettings, options: TapHandOptions): AshTapEvent | null {
    let h = this.hands.get(handKey)
    if (!h || s.time - h.lastTime > TAP_TIMING.lostMs) {
      h = {
        targetKey: null,
        phase: 'far',
        lastFar: null,
        nearAt: 0,
        nearValid: false,
        taps: [],
        lastTime: s.time,
        debug: { targetKey: null, distance: Infinity, along: 0, phase: 'far', taps: 0, lastReason: '' },
      }
      this.hands.set(handKey, h)
    }
    h.lastTime = s.time
    const finger = s.indexTip
    const scale = handScale2d(s)
    if (!settings.enabled || !finger) return this.idle(h, '')
    if (options.blocked) {
      // 着火ジェスチャー（親指と人差し指）の途中・直後：同じ動きで灰を落とさないよう、候補を取り消す
      return this.idle(h, h.taps.length > 0 || h.phase !== 'far' ? '着火ジェスチャーのため取り消し' : '')
    }

    // 叩く対象：軸方向の範囲内で、表面に最も近いタバコ
    let target: TapTarget | null = null
    let best = { r: Infinity, t: 0 }
    for (const c of targets) {
      if (options.allowedKeys && !options.allowedKeys.has(c.key)) continue
      const q = tapCoordinates(finger, c, scale)
      if (q.t < TAP_TIMING.alongMin || q.t > TAP_TIMING.alongMax) continue
      if (q.r < best.r) {
        best = q
        target = c
      }
    }
    if (!target) return this.idle(h, '')
    if (target.key !== h.targetKey) {
      // 別のタバコに移った：途中経過を捨てる
      h.targetKey = target.key
      h.taps = []
      h.phase = 'far'
      h.lastFar = null
    }
    const now = s.time
    const snap: Snapshot = { time: now, r: best.r, finger, penCenter: target.center }
    let reason = h.debug.lastReason
    let event: AshTapEvent | null = null

    if (best.r >= settings.tapFar) {
      if (h.phase === 'near') {
        // 叩いた位置から離れた：短時間で離れて、近づき方が有効なら 1 回のタップ
        if (!h.nearValid) {
          // 理由は近づいたときに記録済み
        } else if (now - h.nearAt > TAP_TIMING.maxContactMs) {
          reason = '近くに置いたまま（離れるのが遅い）'
        } else {
          h.taps.push(now)
          reason = ''
        }
      }
      h.phase = 'far'
      h.lastFar = snap
    } else if (best.r <= settings.tapNear) {
      if (h.phase !== 'near') {
        h.phase = 'near'
        h.nearAt = now
        h.nearValid = false
        const far = h.lastFar
        if (!far) {
          reason = '離れた位置から近づいていない'
        } else {
          const sec = Math.max(now - far.time, 1) / 1000
          const speed = (far.r - best.r) / sec
          const fingerMove = dist(finger, far.finger)
          const penMove = dist(target.center, far.penCenter)
          if (now - far.time > TAP_TIMING.maxApproachMs || speed < settings.tapMinSpeed) {
            reason = `ゆっくり近づけた（${speed.toFixed(1)} < ${settings.tapMinSpeed}）`
          } else if (fingerMove < penMove * TAP_TIMING.minFingerToPenMove) {
            reason = 'タバコの方が動いた（指で叩いていない）'
          } else {
            h.nearValid = true
          }
        }
      }
    } else if (h.phase === 'far') {
      h.phase = 'between'
    }

    // 制限時間を過ぎたタップは数えない
    h.taps = h.taps.filter((t) => now - t <= settings.tapWindowMs)
    if (h.taps.length >= Math.max(1, Math.round(settings.taps))) {
      const last = this.lastDropAt.get(target.key) ?? -Infinity
      if (now - last >= settings.cooldownMs) {
        event = { cigaretteKey: target.key, handKey, time: now }
        this.lastDropAt.set(target.key, now)
        reason = ''
      } else {
        reason = 'クールダウン中'
      }
      h.taps = []
    }
    h.debug = { targetKey: target.key, distance: best.r, along: best.t, phase: h.phase, taps: h.taps.length, lastReason: reason }
    return event
  }

  private idle(h: TapState, reason: string): null {
    h.targetKey = null
    h.phase = 'far'
    h.lastFar = null
    h.taps = []
    h.debug = { targetKey: null, distance: Infinity, along: 0, phase: 'far', taps: 0, lastReason: reason || h.debug.lastReason }
    return null
  }
}
