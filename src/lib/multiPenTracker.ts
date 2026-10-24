import { axisAngleDiff, type PenDetection, type Point2 } from './penGeometry'
import { PenTrackingFilter, type TrackedPen, type TrackingSettings } from './penTracking'

/** STEP 5：追跡 ID 付きのペン */
export type IdentifiedPen = TrackedPen & {
  /** ペンの追跡 ID（1 から振る。検出結果の配列の順番とは無関係。追跡中は再利用せず、reset で 1 に戻る） */
  id: number
  /** 画面上の移動速度 px/ms（中心の移動を平滑化したもの。人物との対応付けに使う） */
  velocity: Point2
  /**
   * STEP 6：検出色（PenColor.id）。追跡 ID とは別に管理し、直近の検出色の多数決で決める
   * （照明で一時的に別の色と判定されても、表示する色がちらつかない）。色の情報が無ければ null
   */
  colorId: string | null
  /** STEP 6：直近の形状スコア（0〜1）。形状判定が OFF なら null */
  score: number | null
}

/** STEP 6：検出 1 本ごとの付加情報（detectColors の結果から渡す） */
export type PenInfo = { colorId: string | null; score: number | null }

/** 検出色が追跡中のペンの色と違うときに加えるコスト（同じ色を優先するが、照明で色が変わっても対応付けられる程度） */
export const COLOR_MISMATCH_COST = 0.15
/** 色の多数決に使う直近の検出数 */
const COLOR_HISTORY = 15

/** 予測位置と検出位置の距離がペンの全長 × この値以下なら同じペンとみなす */
export const PEN_MATCH_MAX_DISTANCE = 0.8
/** 軸の角度差がこれ以下なら同じペンとみなす（度） */
export const PEN_MATCH_MAX_ANGLE = 45
/** 全長が短いペンでも、この距離 px までは同じペンとみなす */
const MATCH_MIN_DISTANCE_PX = 40
/** 速度の平滑化（指数移動平均の新しい値の重み） */
const VELOCITY_ALPHA = 0.4
/** 予測に使う時間の上限 ms（長く見失った後に遠くへ予測しない） */
const MAX_PREDICT_MS = 200

type Track = {
  id: number
  filter: PenTrackingFilter
  pen: TrackedPen | null
  velocity: Point2
  lastMeasuredAt: number
  colors: string[]
  score: number | null
}

/**
 * 複数ペンの追跡。検出結果をフレーム間で対応付けて ID を維持し、ペンごとに PenTrackingFilter
 * （平滑化・短時間の保持・長さ補完）を適用する。
 *
 * - 対応付け：前回位置 + 速度で予測した中心との距離（全長で正規化）と軸の角度差のコストが小さい組から貪欲に決める。
 * - ゲート外の検出は新しいペン（新しい ID）。ただしペンの上限数に達しているときは、見失い中のペンの続きとみなす。
 * - maxPens = 1 のときは、検出された 1 本を常に既存のペンに対応付ける（STEP 5 以前の単独追跡と同じ挙動）。
 * - 保持時間を過ぎて見失ったペンは追跡データを破棄する。
 */
export class MultiPenTracker {
  private tracks: Track[] = []
  private nextId = 1

  /** 追跡データをすべて捨てる。ID は 1 から振り直す */
  reset(): void {
    this.tracks = []
    this.nextId = 1
  }

  update(
    measured: PenDetection[],
    now: number,
    settings: TrackingSettings,
    maxPens: number,
    info?: PenInfo[],
  ): IdentifiedPen[] {
    // 上限を下げたときは古いペン（ID が大きいもの）から捨てる
    if (this.tracks.length > maxPens) this.tracks = this.tracks.slice(0, maxPens)
    const detections = measured.slice(0, maxPens)
    const infoOf = new Map<PenDetection, PenInfo>()
    detections.forEach((d, i) => {
      if (info?.[i]) infoOf.set(d, info[i])
    })
    const assigned = new Map<Track, PenDetection>()
    const used = new Set<PenDetection>()

    if (maxPens === 1) {
      if (detections[0]) {
        assigned.set(this.tracks[0] ?? this.createTrack(now), detections[0])
        used.add(detections[0])
      }
    } else {
      const pairs: { track: Track; det: PenDetection; cost: number }[] = []
      for (const track of this.tracks) {
        if (!track.pen) continue
        for (const det of detections) {
          const cost = matchCost(track, det, now)
          if (cost === null) continue
          const color = infoOf.get(det)?.colorId ?? null
          const trackColor = majorityColor(track.colors)
          const mismatch = color !== null && trackColor !== null && color !== trackColor
          pairs.push({ track, det, cost: cost + (mismatch ? COLOR_MISMATCH_COST : 0) })
        }
      }
      pairs.sort((a, b) => a.cost - b.cost)
      for (const { track, det } of pairs) {
        if (assigned.has(track) || used.has(det)) continue
        assigned.set(track, det)
        used.add(det)
      }
      for (const det of detections) {
        if (used.has(det)) continue
        let track: Track | undefined
        if (this.tracks.length < maxPens) {
          track = this.createTrack(now)
        } else {
          // 上限に達している：最も長く見失っているペンの続きとみなす（持ち替え等の大きな移動）
          track = this.tracks
            .filter((t) => !assigned.has(t))
            .sort((a, b) => a.lastMeasuredAt - b.lastMeasuredAt)[0]
        }
        if (!track) continue
        assigned.set(track, det)
        used.add(det)
      }
    }

    for (const track of this.tracks) {
      const det = assigned.get(track) ?? null
      const prev = track.pen
      track.pen = track.filter.update(det, now, settings)
      if (det && track.pen) {
        if (prev && prev.status === 'measured') {
          const dt = Math.max(now - track.lastMeasuredAt, 1)
          const vx = (track.pen.center.x - prev.center.x) / dt
          const vy = (track.pen.center.y - prev.center.y) / dt
          track.velocity = {
            x: track.velocity.x + (vx - track.velocity.x) * VELOCITY_ALPHA,
            y: track.velocity.y + (vy - track.velocity.y) * VELOCITY_ALPHA,
          }
        } else {
          track.velocity = { x: 0, y: 0 }
        }
        track.lastMeasuredAt = now
        const i = infoOf.get(det)
        if (i?.colorId) track.colors = [...track.colors, i.colorId].slice(-COLOR_HISTORY)
        track.score = i?.score ?? null
      }
    }
    this.tracks = this.tracks.filter((t) => t.pen !== null)
    return this.tracks.map((t) => ({
      ...t.pen!,
      id: t.id,
      velocity: t.velocity,
      colorId: majorityColor(t.colors),
      score: t.score,
    }))
  }

  private createTrack(now: number): Track {
    const track: Track = {
      id: this.nextId++,
      filter: new PenTrackingFilter(),
      pen: null,
      velocity: { x: 0, y: 0 },
      lastMeasuredAt: now,
      colors: [],
      score: null,
    }
    this.tracks.push(track)
    return track
  }
}

/** 対応付けのコスト（小さいほど同じペンらしい）。ゲート外なら null */
function matchCost(track: Track, det: PenDetection, now: number): number | null {
  const pen = track.pen!
  const dt = Math.min(now - track.lastMeasuredAt, MAX_PREDICT_MS)
  const predicted = { x: pen.center.x + track.velocity.x * dt, y: pen.center.y + track.velocity.y * dt }
  const scale = Math.max(pen.length, det.length, MATCH_MIN_DISTANCE_PX)
  const distance = Math.hypot(det.center.x - predicted.x, det.center.y - predicted.y) / scale
  const angle = axisAngleDiff(det.angleDeg, pen.angleDeg)
  if (distance > PEN_MATCH_MAX_DISTANCE || angle > PEN_MATCH_MAX_ANGLE) return null
  return distance + (angle / 90) * 0.5
}

/** 直近の検出色の多数決（同数なら新しい方）。履歴が無ければ null */
export function majorityColor(colors: string[]): string | null {
  const count = new Map<string, number>()
  let best: string | null = null
  let bestN = 0
  colors.forEach((c) => {
    const n = (count.get(c) ?? 0) + 1
    count.set(c, n)
    if (n >= bestN) {
      best = c
      bestN = n
    }
  })
  return best
}
