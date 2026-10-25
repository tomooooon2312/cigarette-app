import type { HandLandmarker } from '@mediapipe/tasks-vision'
import { loadVision, modelUrl } from './mediapipeVision'
import type { Point2 } from './penGeometry'
import { assignHandKeys, toDisplayPoint } from './handKeys'
import type { HandSample } from './snapDetector'

const MODEL_URL = modelUrl('hand_landmarker.task')

/** 手のランドマーク番号 */
const WRIST = 0
const THUMB_TIP = 4
const INDEX_MCP = 5
/** STEP 10：人差し指の第 2 関節（灰落としのタップの判定） */
const INDEX_PIP = 6
/** STEP 9：人差し指の先端（炎を出す位置。STEP 10 から着火ジェスチャー・灰落としにも使う） */
const INDEX_TIP = 8
const MIDDLE_MCP = 9
const MIDDLE_TIP = 12
const PINKY_MCP = 17


/** STEP 11：手を見失ってから、この時間以内に映った手には前のキーを引き継ぐ ms（着火ジェスチャーの SNAP_TIMING.lostMs と同じ） */
export const KEY_MEMORY_MS = 300

/** 指パッチンは一瞬なので、既定ではカメラのフレームごとに推論する */
export const DEFAULT_HAND_INTERVAL_MS = 0

export type TrackedHand = {
  /** 手の識別子（左右の推定と番号）。同じ手をフレーム間で対応づけるのに使う */
  key: string
  /** 本人から見た左右の推定（MediaPipe の結果を、入力が非ミラーであることを考慮して入れ替えたもの） */
  side: 'left' | 'right' | 'unknown'
  /** 21 点のランドマーク（表示座標 px、ミラー適用後） */
  landmarks: Point2[]
  sample: HandSample
  sampleId: number
}

/**
 * MediaPipe Hand Landmarker（VIDEO モード、最大 2 本の手。STEP 5 から人数 × 2 本まで）。
 * 入力は加工前の video。結果は OpenCV・Face Landmarker と同じ表示座標（処理解像度・ミラー適用後）に変換する。
 */
export class HandTracker {
  private landmarker: HandLandmarker | null = null
  private closed = false
  private lastDetectAt = -Infinity
  private lastTimestamp = 0
  private sampleCount = 0
  private hands: TrackedHand[] = []
  private numHands = 2
  /** STEP 11：最後に手が映っていた推論結果（一瞬見失った後のキーの引き継ぎに使う） */
  private recent: { hands: TrackedHand[]; time: number } | null = null
  private lastSampleAt = -Infinity

  static async create(numHands = 2): Promise<HandTracker> {
    const { vision, fileset } = await loadVision()
    const options = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO' as const,
      numHands,
    })
    const tracker = new HandTracker()
    tracker.numHands = numHands
    try {
      tracker.landmarker = await vision.HandLandmarker.createFromOptions(fileset, options('GPU'))
    } catch {
      tracker.landmarker = await vision.HandLandmarker.createFromOptions(fileset, options('CPU'))
    }
    return tracker
  }

  /** STEP 5：検出する手の最大数（人数 × 2）。推論を作り直さずに反映できる */
  async setNumHands(numHands: number): Promise<void> {
    if (numHands === this.numHands || !this.landmarker) return
    this.numHands = numHands
    await this.landmarker.setOptions({ numHands })
  }

  /**
   * 推論間隔に達していれば推論し、現在の手を返す。fresh は今回新しい推論結果が出たか。
   */
  update(
    video: HTMLVideoElement,
    now: number,
    width: number,
    height: number,
    mirror: boolean,
    intervalMs = DEFAULT_HAND_INTERVAL_MS,
  ): { hands: TrackedHand[]; fresh: boolean } {
    if (this.closed || !this.landmarker) return { hands: [], fresh: false }
    if (now - this.lastDetectAt < intervalMs) return { hands: this.hands, fresh: false }
    this.lastDetectAt = now
    const timestamp = Math.max(Math.round(now), this.lastTimestamp + 1)
    this.lastTimestamp = timestamp
    const result = this.landmarker.detectForVideo(video, timestamp)
    const sampleId = ++this.sampleCount
    const previous = this.hands
    const next = result.landmarks.map((lm, i) => {
      const label = result.handedness[i]?.[0]?.categoryName
      // MediaPipe の左右は「ミラーされた自撮り画像」を前提にしている。入力は非ミラーの video なので入れ替える
      const side: TrackedHand['side'] = label === 'Left' ? 'right' : label === 'Right' ? 'left' : 'unknown'
      const landmarks = lm.map((p) => toDisplayPoint(p, width, height, mirror))
      // STEP 9：3D のワールドランドマーク（メートル）。距離は左右反転・カメラに対する手の回転に依存しないので、反転は適用しない
      const w = result.worldLandmarks?.[i]
      const p3 = (k: number) => ({ x: w![k].x, y: w![k].y, z: w![k].z })
      const sample: HandSample = {
        time: now,
        thumbTip: landmarks[THUMB_TIP],
        middleTip: landmarks[MIDDLE_TIP],
        wrist: landmarks[WRIST],
        indexMcp: landmarks[INDEX_MCP],
        pinkyMcp: landmarks[PINKY_MCP],
        indexTip: landmarks[INDEX_TIP],
        indexPip: landmarks[INDEX_PIP],
        scale: Math.hypot(
          landmarks[WRIST].x - landmarks[MIDDLE_MCP].x,
          landmarks[WRIST].y - landmarks[MIDDLE_MCP].y,
        ),
        world:
          w && w.length >= 21
            ? {
                thumbTip: p3(THUMB_TIP),
                middleTip: p3(MIDDLE_TIP),
                wrist: p3(WRIST),
                indexMcp: p3(INDEX_MCP),
                pinkyMcp: p3(PINKY_MCP),
                middleMcp: p3(MIDDLE_MCP),
                indexTip: p3(INDEX_TIP),
              }
            : undefined,
        confidence: result.handedness[i]?.[0]?.score,
      }
      return { side, landmarks, sample }
    })
    // STEP 5：手が 3 本以上になると結果の順番が入れ替わるため、前回の手のうち手首が最も近いもののキーを引き継ぐ
    // （着火ジェスチャーの途中経過を手ごとに正しく追跡するため）。1 人分（左右 1 本ずつ）なら従来どおり 'left' / 'right'
    // STEP 11：一瞬見失った手（KEY_MEMORY_MS 以内）と、左右の推定が入れ替わった手（手の甲側・横向きで起きやすい）にも同じキーを引き継ぐ
    if (previous.length > 0) this.recent = { hands: previous, time: this.lastSampleAt }
    const memory = this.recent && now - this.recent.time <= KEY_MEMORY_MS ? this.recent.hands : []
    const keys = assignHandKeys(
      next.map(({ side, sample }) => ({ side, wrist: sample.wrist, scale: sample.scale })),
      memory.map((h) => ({ key: h.key, side: h.side, wrist: h.sample.wrist })),
    )
    this.lastSampleAt = now
    this.hands = next.map(({ side, landmarks, sample }, i) => ({ key: keys[i], side, landmarks, sampleId, sample }))
    return { hands: this.hands, fresh: true }
  }

  reset(): void {
    this.hands = []
    this.recent = null
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.landmarker?.close()
    this.landmarker = null
    this.hands = []
  }
}

/** デバッグ表示用：手の骨格の接続（MediaPipe の HAND_CONNECTIONS と同じ） */
export const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
]
