import type { HandLandmarker } from '@mediapipe/tasks-vision'
import { loadVision, modelUrl } from './mediapipeVision'
import type { Point2 } from './penGeometry'
import type { HandSample } from './snapDetector'

const MODEL_URL = modelUrl('hand_landmarker.task')

/** 手のランドマーク番号 */
const WRIST = 0
const THUMB_TIP = 4
const INDEX_MCP = 5
const MIDDLE_MCP = 9
const MIDDLE_TIP = 12
const PINKY_MCP = 17

/** 前回の手の手首からこの距離（手の大きさ × この値）以内なら同じ手とみなす */
const HAND_MATCH_DISTANCE = 1.5

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
    const taken = new Set<string>()
    const next = result.landmarks.map((lm, i) => {
      const label = result.handedness[i]?.[0]?.categoryName
      // MediaPipe の左右は「ミラーされた自撮り画像」を前提にしている。入力は非ミラーの video なので入れ替える
      const side: TrackedHand['side'] = label === 'Left' ? 'right' : label === 'Right' ? 'left' : 'unknown'
      const landmarks = lm.map((p) => ({ x: (mirror ? 1 - p.x : p.x) * width, y: p.y * height }))
      const sample: HandSample = {
        time: now,
        thumbTip: landmarks[THUMB_TIP],
        middleTip: landmarks[MIDDLE_TIP],
        wrist: landmarks[WRIST],
        indexMcp: landmarks[INDEX_MCP],
        pinkyMcp: landmarks[PINKY_MCP],
        scale: Math.hypot(
          landmarks[WRIST].x - landmarks[MIDDLE_MCP].x,
          landmarks[WRIST].y - landmarks[MIDDLE_MCP].y,
        ),
      }
      return { side, landmarks, sample }
    })
    // STEP 5：手が 3 本以上になると結果の順番が入れ替わるため、前回の同じ側の手のうち手首が最も近いもののキーを引き継ぐ
    // （指パッチンの途中経過を手ごとに正しく追跡するため）。1 人分（左右 1 本ずつ）なら従来どおり 'left' / 'right'
    const keys: (string | null)[] = next.map(() => null)
    const pairs = next
      .flatMap(({ side, sample }, i) =>
        previous
          .filter((h) => h.side === side)
          .map((h) => ({ i, key: h.key, d: Math.hypot(h.sample.wrist.x - sample.wrist.x, h.sample.wrist.y - sample.wrist.y) }))
          .filter((m) => m.d <= Math.max(sample.scale, 20) * HAND_MATCH_DISTANCE),
      )
      .sort((a, b) => a.d - b.d)
    for (const { i, key } of pairs) {
      if (keys[i] !== null || taken.has(key)) continue
      keys[i] = key
      taken.add(key)
    }
    this.hands = next.map(({ side, landmarks, sample }, i) => {
      let key = keys[i]
      for (let n = 0; key === null; n++) {
        const candidate = n === 0 ? side : `${side}-${n}`
        if (!taken.has(candidate)) key = candidate
      }
      taken.add(key)
      return { key, side, landmarks, sampleId, sample }
    })
    return { hands: this.hands, fresh: true }
  }

  reset(): void {
    this.hands = []
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
