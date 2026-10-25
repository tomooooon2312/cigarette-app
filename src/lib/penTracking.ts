import { axisAngleDeg, axisAngleDiff, penFromAxis, unitFromAngle, type PenDetection, type Point2 } from './penGeometry'

export type TrackingSettings = {
  /** 0 = 平滑化なし、0.9 = 強い平滑化（指数移動平均の前回値の重み） */
  smoothing: number
  /** 見失ってから直前の結果を保持する時間 ms（0 で保持しない） */
  holdMs: number
  /** ペンの片側が完全に隠れて短くなったとき、直前の全長で補完する */
  lengthCompletion: boolean
  /**
   * 遠距離認識モード：見失っている間（held）、直前の動きから位置を予測する（最大 PREDICT_MAX_MS 分）。
   * 予測した位置は status = 'held'・predicted = true で、実際に検出した位置（measured）と区別する
   */
  predictHeld?: boolean
}

export const DEFAULT_TRACKING: TrackingSettings = {
  smoothing: 0.5,
  holdMs: 300,
  lengthCompletion: true,
}

export type TrackedPen = PenDetection & {
  /** measured: 今フレームで計測、held: 見失い中で直前の結果を保持 */
  status: 'measured' | 'held'
  /** 長さ補完を適用したか */
  lengthCompleted: boolean
  /** 最後に計測できてからの経過時間 ms（measured なら 0） */
  sinceMeasuredMs: number
  /** 遠距離認識モード：位置を直前の動きから予測した（実際の検出ではない） */
  predicted?: boolean
}

/** 遠距離認識モードで、見失っている間に直前の動きで位置を進める時間の上限 ms（これ以降は止まる） */
export const PREDICT_MAX_MS = 250
/** 遠距離認識モードの、見失ってから CG を保持する時間 ms（STEP 1.1 からの既定は 300ms） */
export const FAR_HOLD_MS = 600

/** 前回結果と連続しているとみなす最大の時間間隔 ms（保持時間が短くても平滑化は効かせる） */
const MIN_CONTINUITY_MS = 200
/** これを超える変化は別の動き（持ち替え等）とみなし、平滑化せず即座に追従する */
const JUMP_ANGLE_DEG = 35
const JUMP_DISTANCE_RATIO = 0.6
const JUMP_DISTANCE_MIN_PX = 30
/** 全長が基準長のこの比率を下回ったら片側が隠れたとみなす */
const COMPLETION_TRIGGER_RATIO = 0.75
/** 全長を最後に確認してから補完を続けられる時間 ms（それ以降は短くなった長さを正とする） */
const COMPLETION_WINDOW_MS = 1000
const COMPLETION_MAX_ANGLE_DEG = 15

type State = {
  center: Point2
  /** フレーム間で向きを揃えた軸ベクトル（endpoints の順序を安定させる） */
  u: Point2
  length: number
  thickness: number
  lastSeenAt: number
  /** 片側が隠れていないときに観測した全長と、その時刻 */
  referenceLength: number
  referenceAt: number
  last: PenDetection
  lengthCompleted: boolean
  /** 中心の移動速度 px/ms（予測用） */
  velocity: Point2
}

const dot = (a: Point2, b: Point2) => a.x * b.x + a.y * b.y
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/**
 * 検出結果のフレーム間処理：平滑化、見失い時の短時間保持、片側遮蔽時の長さ補完。
 */
export class PenTrackingFilter {
  private state: State | null = null

  reset(): void {
    this.state = null
  }

  update(measured: PenDetection | null, now: number, settings: TrackingSettings): TrackedPen | null {
    const prev = this.state
    const continuous =
      prev !== null && now - prev.lastSeenAt <= Math.max(settings.holdMs, MIN_CONTINUITY_MS)

    if (!measured) {
      if (prev && now - prev.lastSeenAt <= settings.holdMs) return this.output('held', now, settings.predictHeld === true)
      this.state = null
      return null
    }

    let u = unitFromAngle(measured.angleDeg)
    let center = measured.center
    let length = measured.length
    let lengthCompleted = false
    let referenceLength = measured.length
    let referenceAt = now

    if (prev && continuous) {
      if (dot(u, prev.u) < 0) u = { x: -u.x, y: -u.y }
      const angleDiff = axisAngleDiff(measured.angleDeg, axisAngleDeg(prev.u))
      const withinWindow = now - prev.referenceAt <= COMPLETION_WINDOW_MS
      const shortened = measured.length < prev.referenceLength * COMPLETION_TRIGGER_RATIO

      if (settings.lengthCompletion && shortened && withinWindow && angleDiff <= COMPLETION_MAX_ANGLE_DEG) {
        const completed = completeLength(prev, measured, u)
        if (completed) {
          center = completed
          length = prev.referenceLength
          lengthCompleted = true
        }
      }
      // 補完中は基準長を更新しない。補完できない短縮は時間窓が切れるまで基準長を保つ
      if (lengthCompleted || (shortened && withinWindow)) {
        referenceLength = prev.referenceLength
        referenceAt = prev.referenceAt
      }

      const jumped =
        angleDiff > JUMP_ANGLE_DEG ||
        Math.hypot(center.x - prev.center.x, center.y - prev.center.y) >
          Math.max(prev.length * JUMP_DISTANCE_RATIO, JUMP_DISTANCE_MIN_PX)
      if (!jumped) {
        const a = 1 - settings.smoothing
        center = { x: lerp(prev.center.x, center.x, a), y: lerp(prev.center.y, center.y, a) }
        const ux = lerp(prev.u.x, u.x, a)
        const uy = lerp(prev.u.y, u.y, a)
        const norm = Math.hypot(ux, uy) || 1
        u = { x: ux / norm, y: uy / norm }
        length = lerp(prev.length, length, a)
        const dt = Math.max(now - prev.lastSeenAt, 1)
        this.state = {
          center,
          u,
          length,
          thickness: lerp(prev.thickness, measured.thickness, a),
          lastSeenAt: now,
          referenceLength,
          referenceAt,
          last: measured,
          lengthCompleted,
          velocity: {
            x: lerp(prev.velocity.x, (center.x - prev.center.x) / dt, 0.5),
            y: lerp(prev.velocity.y, (center.y - prev.center.y) / dt, 0.5),
          },
        }
        return this.output('measured', now)
      }
    }

    this.state = {
      center,
      u,
      length,
      thickness: measured.thickness,
      lastSeenAt: now,
      referenceLength,
      referenceAt,
      last: measured,
      lengthCompleted,
      velocity: { x: 0, y: 0 },
    }
    return this.output('measured', now)
  }

  private output(status: TrackedPen['status'], now: number, predict = false): TrackedPen {
    const s = this.state!
    // 遠距離認識モード：見失っている間は直前の動きで少しだけ位置を進める（最大 PREDICT_MAX_MS 分）
    const ahead = predict && status === 'held' ? Math.min(now - s.lastSeenAt, PREDICT_MAX_MS) : 0
    const pen = penFromAxis(
      {
        center: ahead > 0 ? { x: s.center.x + s.velocity.x * ahead, y: s.center.y + s.velocity.y * ahead } : s.center,
        u: s.u,
        length: s.length,
        thickness: s.thickness,
        area: s.last.area,
        segments: status === 'held' ? [] : s.last.segments,
        frameWidth: s.last.frameWidth,
        frameHeight: s.last.frameHeight,
      },
      false,
    )
    return { ...pen, status, lengthCompleted: s.lengthCompleted, sinceMeasuredMs: now - s.lastSeenAt, predicted: ahead > 0 }
  }
}

/**
 * 片側が隠れて短くなった計測値から、ペン全体の中心を推定する。
 * 計測された 2 端のうち、直前の追跡結果の端点に近い方を「実際の端」とみなし、そこから基準長だけ伸ばす。
 * 位置関係が直前と食い違う場合は null（補完しない）。
 */
function completeLength(prev: State, measured: PenDetection, u: Point2): Point2 | null {
  const L = prev.referenceLength
  const n = { x: -prev.u.y, y: prev.u.x }
  const rel = (p: Point2) => ({ x: p.x - prev.center.x, y: p.y - prev.center.y })
  if (Math.abs(dot(rel(measured.center), n)) > Math.max(prev.thickness, 6)) return null

  const hl = measured.length / 2
  const eMinus = { x: measured.center.x - u.x * hl, y: measured.center.y - u.y * hl }
  const ePlus = { x: measured.center.x + u.x * hl, y: measured.center.y + u.y * hl }
  const dMinus = Math.abs(dot(rel(eMinus), prev.u) + prev.length / 2)
  const dPlus = Math.abs(dot(rel(ePlus), prev.u) - prev.length / 2)
  const tolerance = Math.max(L * 0.25, prev.thickness * 2)
  if (Math.min(dMinus, dPlus) > tolerance) return null

  return dMinus <= dPlus
    ? { x: eMinus.x + u.x * (L / 2), y: eMinus.y + u.y * (L / 2) }
    : { x: ePlus.x - u.x * (L / 2), y: ePlus.y - u.y * (L / 2) }
}
