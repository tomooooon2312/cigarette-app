import type { FaceLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision'
import { loadVision, modelUrl } from './mediapipeVision'
import type { Point2 } from './penGeometry'
import { posterFaceFromLandmarks, type PosterFace } from './posterRenderer'

/** 公式配布の Face Landmarker モデル（float16 / v1）を public/models に同梱している */
const MODEL_URL = modelUrl('face_landmarker.task')

/** Face Mesh のランドマーク番号 */
const UPPER_INNER_LIP = 13
const LOWER_INNER_LIP = 14
const UPPER_OUTER_LIP = 0
const LOWER_OUTER_LIP = 17
const MOUTH_CORNER_A = 61
const MOUTH_CORNER_B = 291
/** 両目の外側の端。口の形で変わらないため、顔の大きさの基準に使う */
const EYE_OUTER_A = 33
const EYE_OUTER_B = 263
/** 鼻先。目尻の中点からのずれで顔の左右の向きを推定する（STEP 3.2：煙の噴き出す向き） */
const NOSE_TIP = 1
/** デバッグ表示用：唇の外周と目尻 */
const DEBUG_LANDMARKS = [
  61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 13, 14, 33, 263,
]

/** 推論間隔の既定値 ms（約 15Hz）。スマホでは UI から広げて負荷を下げる */
export const DEFAULT_INFERENCE_INTERVAL_MS = 66
/** STEP 5：同時に検出する顔の最大数 */
export const MAX_FACES = 3

export type Mouth = {
  /** 唇の中心（表示座標 px、ミラー適用後） */
  center: Point2
  /** 口角間の距離 px */
  width: number
  /** 上唇〜下唇（外側）の距離 px */
  height: number
  /** 顔の大きさの基準 px（両目の外側の端の距離）。距離しきい値の正規化に使う */
  faceScale: number
  /** 顔の左右の向き（表示座標）。鼻先が目尻の中点より右なら正、左なら負（顔幅の半分で正規化、-1〜1） */
  facing: number
  /** Blendshape スコア 0〜1（口をすぼめる / 口を丸く突き出す） */
  pucker: number
  funnel: number
  /** 推論結果ごとに増える番号（「数フレーム連続」の判定を推論単位で数えるため）。STEP 5 からは FaceTrackManager が顔ごとに振り直す */
  sampleId: number
  /** 最後に検出した時刻（requestAnimationFrame の時刻） */
  detectedAt: number
  /** デバッグ表示用のランドマーク（表示座標） */
  debugPoints: Point2[]
  /** STEP 14：ポスターの顔のパーツ（猫耳・メイク・前髪）の配置に使うランドマーク（表示座標） */
  poster: PosterFace
}

/**
 * MediaPipe Face Landmarker（VIDEO モード、Blendshape 出力あり）で口元の位置と形を求める。
 * 入力は加工前の video 要素。結果は OpenCV 側と同じ表示座標（処理解像度・ミラー適用後）に変換して返す。
 *
 * STEP 5：最大 3 人の顔を検出し、推論結果ごとの口元の配列を返すように変更した（以前は 1 人分を保持して返していた）。
 * 配列の順番は推論ごとに変わりうるため人物 ID には使わない。ID の割り当て・見失い中の保持・平滑化は
 * FaceTrackManager（faceTracks.ts）が行う。
 */
export class MouthTracker {
  private landmarker: FaceLandmarker | null = null
  private closed = false
  private lastDetectAt = -Infinity
  private lastTimestamp = 0
  private sampleCount = 0
  private numFaces = 1

  static async create(numFaces = 1): Promise<MouthTracker> {
    const { vision, fileset } = await loadVision()
    const options = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO' as const,
      numFaces,
      outputFaceBlendshapes: true,
    })
    const tracker = new MouthTracker()
    tracker.numFaces = numFaces
    try {
      tracker.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, options('GPU'))
    } catch {
      // WebGL が使えない環境では CPU にフォールバック
      tracker.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, options('CPU'))
    }
    return tracker
  }

  /** 同時に検出する顔の数を変える（1〜MAX_FACES）。推論を作り直さずに反映できる */
  async setNumFaces(numFaces: number): Promise<void> {
    const n = Math.max(1, Math.min(MAX_FACES, Math.round(numFaces)))
    if (n === this.numFaces || !this.landmarker) return
    this.numFaces = n
    await this.landmarker.setOptions({ numFaces: n })
  }

  /**
   * 推論間隔に達していれば顔検出を実行し、検出した全員の口元を返す。fresh は今回新しい推論結果が出たか
   * （fresh = false のとき mouths は空）。width/height は表示（処理）解像度、mirror は表示が左右反転しているか。
   */
  update(
    video: HTMLVideoElement,
    now: number,
    width: number,
    height: number,
    mirror: boolean,
    intervalMs = DEFAULT_INFERENCE_INTERVAL_MS,
  ): { mouths: Mouth[]; fresh: boolean } {
    if (this.closed || !this.landmarker) return { mouths: [], fresh: false }
    if (now - this.lastDetectAt < intervalMs) return { mouths: [], fresh: false }
    this.lastDetectAt = now
    // detectForVideo のタイムスタンプは単調増加である必要がある
    const timestamp = Math.max(Math.round(now), this.lastTimestamp + 1)
    this.lastTimestamp = timestamp
    const result = this.landmarker.detectForVideo(video, timestamp)
    const sampleId = ++this.sampleCount
    const mouths = result.faceLandmarks.map((face, i) => {
      const scores = result.faceBlendshapes[i]?.categories ?? []
      const score = (name: string) => scores.find((c) => c.categoryName === name)?.score ?? 0
      return toMouth(face, width, height, mirror, {
        pucker: score('mouthPucker'),
        funnel: score('mouthFunnel'),
        sampleId,
        detectedAt: now,
      })
    })
    return { mouths, fresh: true }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.landmarker?.close()
    this.landmarker = null
  }
}

function toMouth(
  face: NormalizedLandmark[],
  width: number,
  height: number,
  mirror: boolean,
  extra: Pick<Mouth, 'pucker' | 'funnel' | 'sampleId' | 'detectedAt'>,
): Mouth {
  // ランドマークは加工前の映像の正規化座標なので、ミラーと処理解像度を適用して表示座標にそろえる
  const at = (i: number): Point2 => ({
    x: (mirror ? 1 - face[i].x : face[i].x) * width,
    y: face[i].y * height,
  })
  const dist = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y)
  const eyeA = at(EYE_OUTER_A)
  const eyeB = at(EYE_OUTER_B)
  const faceScale = Math.max(dist(eyeA, eyeB), 1)
  const eyeMidX = (eyeA.x + eyeB.x) / 2
  const upper = at(UPPER_INNER_LIP)
  const lower = at(LOWER_INNER_LIP)
  return {
    center: { x: (upper.x + lower.x) / 2, y: (upper.y + lower.y) / 2 },
    width: dist(at(MOUTH_CORNER_A), at(MOUTH_CORNER_B)),
    height: dist(at(UPPER_OUTER_LIP), at(LOWER_OUTER_LIP)),
    faceScale,
    facing: Math.max(-1, Math.min(1, (at(NOSE_TIP).x - eyeMidX) / (faceScale / 2))),
    debugPoints: DEBUG_LANDMARKS.map(at),
    poster: posterFaceFromLandmarks(at),
    ...extra,
  }
}
