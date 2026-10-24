import type { Mouth } from './mouthTracker'
import type { Point2 } from './penGeometry'

/** STEP 5：追跡 ID 付きの顔（口元） */
export type TrackedFace = Mouth & {
  /** 人物の追跡 ID（1 から振る。検出結果の配列の順番とは無関係。追跡中は再利用せず、reset で 1 に戻る） */
  id: number
  /** measured: 直近の推論結果で検出、held: 見失い中（validMs までは直前の値を有効として使う） */
  status: 'measured' | 'held'
  /** 唇の中心の移動速度 px/ms（平滑化） */
  velocity: Point2
}

export const FACE_TIMING = {
  /** 最後に検出してから、口元の情報を有効とみなす時間 ms（STEP 3 の MOUTH_VALID_MS と同じ） */
  validMs: 500,
  /** 最後に検出してから、追跡データ（ID）を保持する時間 ms。これを過ぎた顔は画面外に出たとみなして破棄する */
  forgetMs: 3000,
} as const

/** 予測位置と検出位置の距離が顔の大きさ × この値以下なら同じ顔とみなす */
export const FACE_MATCH_MAX_DISTANCE = 1.2
/** 見失い中の顔に再び対応付けるときの距離の上限（顔の大きさ × この値） */
export const FACE_REACQUIRE_DISTANCE = 1.8
/** 顔の大きさの比がこれを超えたら別人とみなす */
const MAX_SCALE_RATIO = 1.6
/** 予測に使う時間の上限 ms（長く見失った後に遠くへ予測しない） */
const MAX_PREDICT_MS = 250
const VELOCITY_ALPHA = 0.5
/**
 * 複数顔のときの平滑化（指数移動平均の前回値の重み）。MediaPipe Face Landmarker の標準の平滑化は
 * numFaces = 1 のときだけ効くため、複数人モードでは独自に平滑化する。
 */
export const MULTI_FACE_SMOOTHING = { position: 0.45, shape: 0.35 } as const
/** 顔の大きさ × この値を超える移動は平滑化せずに追従する（素早い動きで遅れないように） */
const SMOOTHING_JUMP = 0.5
/** 保持する追跡データの上限（人数の上限 + 見失い中） */
const EXTRA_REMEMBERED = 2

type Track = {
  face: TrackedFace
  lastSeenAt: number
  samples: number
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const dist = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y)

/**
 * 顔の追跡 ID の管理。推論結果（口元の配列）を前回の顔の位置（速度で予測）と対応付けて ID を維持する。
 * - 対応付けは「予測位置との距離（顔の大きさで正規化）＋顔の大きさの差」のコストが小さい組から貪欲に決める。
 * - 見失った顔は validMs まで直前の値を使い（従来と同じ）、forgetMs まで ID を覚えておき、近くに戻れば同じ ID を使う。
 * - maxFaces = 1 のときは、検出した顔を常に既存の顔に対応付け、平滑化もしない（STEP 5 以前と同じ挙動）。
 * - maxFaces ≥ 2 のときは位置・口の形を独自に平滑化する。
 */
export class FaceTrackManager {
  private tracks: Track[] = []
  private nextId = 1

  /** 追跡データをすべて捨てる。ID は 1 から振り直す（ID に紐づく人物の状態も同時に捨てるため、取り違えは起きない） */
  reset(): void {
    this.tracks = []
    this.nextId = 1
  }

  /** 覚えている顔の ID（見失い中を含む） */
  get rememberedIds(): number[] {
    return this.tracks.map((t) => t.face.id)
  }

  /**
   * fresh = true のとき mouths は今回の推論結果（0 人でもよい）。fresh = false なら推論が無かったフレーム。
   * 戻り値は口元の情報が有効な顔（ID 昇順）。
   */
  update(mouths: Mouth[], fresh: boolean, now: number, maxFaces: number): TrackedFace[] {
    if (fresh) this.applyInference(mouths.slice(0, maxFaces), now, maxFaces)
    this.tracks = this.tracks.filter((t) => now - t.lastSeenAt <= FACE_TIMING.forgetMs)
    return this.tracks
      .filter((t) => now - t.lastSeenAt <= FACE_TIMING.validMs)
      .map((t) => t.face)
      .sort((a, b) => a.id - b.id)
  }

  private applyInference(mouths: Mouth[], now: number, maxFaces: number): void {
    const assigned = new Map<Track, Mouth>()
    const used = new Set<Mouth>()

    if (maxFaces === 1) {
      // 1 人モード：常に同じ人物とみなす（従来どおり、別人に入れ替わっても同じ状態を引き継ぐ）
      const latest = [...this.tracks].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0]
      this.tracks = latest ? [latest] : []
      if (mouths[0]) {
        assigned.set(latest ?? this.createTrack(mouths[0], now), mouths[0])
        used.add(mouths[0])
      }
    } else {
      const pairs: { track: Track; mouth: Mouth; cost: number }[] = []
      for (const track of this.tracks) {
        for (const mouth of mouths) {
          const cost = matchCost(track, mouth, now)
          if (cost !== null) pairs.push({ track, mouth, cost })
        }
      }
      pairs.sort((a, b) => a.cost - b.cost)
      for (const { track, mouth } of pairs) {
        if (assigned.has(track) || used.has(mouth)) continue
        assigned.set(track, mouth)
        used.add(mouth)
      }
      for (const mouth of mouths) {
        if (!used.has(mouth)) assigned.set(this.createTrack(mouth, now), mouth)
      }
    }

    const smoothing = maxFaces === 1 ? null : MULTI_FACE_SMOOTHING
    for (const track of this.tracks) {
      const mouth = assigned.get(track)
      if (mouth) {
        updateTrack(track, mouth, now, smoothing)
      } else {
        track.face = { ...track.face, status: 'held' }
      }
    }
    // 覚えておく顔の数を制限する（見失ってから長いものから捨てる）
    const limit = maxFaces + (maxFaces === 1 ? 0 : EXTRA_REMEMBERED)
    if (this.tracks.length > limit) {
      this.tracks = [...this.tracks].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, limit)
    }
  }

  private createTrack(mouth: Mouth, now: number): Track {
    const track: Track = {
      face: { ...mouth, id: this.nextId++, status: 'measured', velocity: { x: 0, y: 0 }, sampleId: 0 },
      lastSeenAt: now,
      samples: 0,
    }
    this.tracks.push(track)
    return track
  }
}

/** 対応付けのコスト（小さいほど同じ顔らしい）。ゲート外なら null */
function matchCost(track: Track, mouth: Mouth, now: number): number | null {
  const prev = track.face
  const elapsed = now - track.lastSeenAt
  const dt = Math.min(elapsed, MAX_PREDICT_MS)
  const predicted = { x: prev.center.x + prev.velocity.x * dt, y: prev.center.y + prev.velocity.y * dt }
  const scale = Math.max(prev.faceScale, mouth.faceScale, 1)
  const d = dist(predicted, mouth.center) / scale
  const ratio = Math.max(prev.faceScale, mouth.faceScale) / Math.max(Math.min(prev.faceScale, mouth.faceScale), 1)
  const gate = elapsed > FACE_TIMING.validMs ? FACE_REACQUIRE_DISTANCE : FACE_MATCH_MAX_DISTANCE
  if (d > gate || ratio > MAX_SCALE_RATIO) return null
  // 見失い中の顔より、直前まで見えていた顔を優先する
  return d + (ratio - 1) + (prev.status === 'held' ? 0.3 : 0)
}

function updateTrack(
  track: Track,
  mouth: Mouth,
  now: number,
  smoothing: { position: number; shape: number } | null,
): void {
  const prev = track.face
  const dt = Math.max(now - track.lastSeenAt, 1)
  let center = mouth.center
  let width = mouth.width
  let height = mouth.height
  let faceScale = mouth.faceScale
  let facing = mouth.facing
  let pucker = mouth.pucker
  let funnel = mouth.funnel
  const jumped = dist(prev.center, mouth.center) > prev.faceScale * SMOOTHING_JUMP
  if (smoothing && track.samples > 0 && prev.status === 'measured' && !jumped) {
    const a = 1 - smoothing.position
    const b = 1 - smoothing.shape
    center = { x: lerp(prev.center.x, center.x, a), y: lerp(prev.center.y, center.y, a) }
    width = lerp(prev.width, width, a)
    height = lerp(prev.height, height, b)
    faceScale = lerp(prev.faceScale, faceScale, a)
    facing = lerp(prev.facing, facing, b)
    pucker = lerp(prev.pucker, pucker, b)
    funnel = lerp(prev.funnel, funnel, b)
  }
  const velocity =
    track.samples > 0 && prev.status === 'measured'
      ? {
          x: lerp(prev.velocity.x, (center.x - prev.center.x) / dt, VELOCITY_ALPHA),
          y: lerp(prev.velocity.y, (center.y - prev.center.y) / dt, VELOCITY_ALPHA),
        }
      : prev.velocity
  track.samples++
  track.lastSeenAt = now
  track.face = {
    ...mouth,
    center,
    width,
    height,
    faceScale,
    facing,
    pucker,
    funnel,
    id: prev.id,
    status: 'measured',
    velocity,
    // 煙の状態機械は「新しい推論結果」を顔ごとの番号で数える
    sampleId: track.samples,
    detectedAt: now,
  }
}
