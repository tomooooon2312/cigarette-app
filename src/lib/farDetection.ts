import type { ColoredDetection } from './penDetector'
import { sameObject } from './penDetector'
import { penFromAxis, unitFromAngle, type PenDetection, type PenSegment, type Point2 } from './penGeometry'

/**
 * 遠距離認識モード：カメラから離れて小さく写ったペンを、顔・手の近くの探索範囲（ROI）だけ高解像度で解析して見つける。
 *
 * - 全画面の検出（STEP 1〜6 の処理解像度・しきい値）はそのまま行う。ROI 外の判定は変えない。
 * - ROI は MediaPipe の顔（直前のフレーム）と手の位置から作る。顔・手が小さく写っている（＝遠い）ときだけ作る。
 * - ROI の画像はカメラの映像から直接切り出す（処理解像度より細かい画素を使う）。大きさは ROI_IMAGE_SIZE 四方に固定し、
 *   OpenCV の Mat を毎フレーム作り直さない。
 * - ROI 内では小さいペンも候補にするが、形の判定は全画面より厳しくする（色だけではペンと判定しない）。
 * - ROI で見つけたペンは処理解像度の座標に戻し、全画面の検出と重複を統合する（CG の座標は全画面の検出と同じ座標系）。
 */
export type FarSettings = {
  /** 遠距離認識モード（初期値 OFF。OFF なら STEP 9 までと同じ処理） */
  enabled: boolean
}

export const DEFAULT_FAR: FarSettings = { enabled: false }

/** ROI の画像の大きさ px（正方形。カメラの映像から切り出して、この大きさに拡大・縮小する） */
export const ROI_IMAGE_SIZE = 256

export const FAR_ROI = {
  /** 顔の ROI の一辺 = 顔の大きさ（両目の外側の端の距離）× この値 */
  faceScale: 4,
  /** 顔の ROI の中心を、唇の中心から 顔の大きさ × この値 だけ下にずらす（ペンは口元か、その下の手にある） */
  faceOffsetY: 0.5,
  /** 手の ROI の一辺 = 手の大きさ（手首〜中指の付け根）× この値 */
  handScale: 3.2,
  /** ROI の一辺の下限・上限（処理解像度の px、上限は画面の短辺に対する比率）。顔が小さくても範囲が小さくなりすぎない */
  minSize: 120,
  maxSizeRatio: 0.6,
  /** 顔の大きさ / 画面の短辺 がこれより大きい（近い）顔は ROI を作らない（全画面の検出で足りる） */
  farFaceMaxRatio: 0.22,
  /** 手の大きさ / 画面の短辺 がこれより大きい（近い）手は ROI を作らない */
  farHandMaxRatio: 0.3,
  /** 重なりがこの割合（小さい方の面積に対する）以上の ROI はまとめる */
  mergeOverlap: 0.5,
} as const

/** 人数ごとの ROI の上限（処理負荷の上限） */
export const MAX_ROIS: Record<1 | 2 | 3, number> = { 1: 2, 2: 3, 3: 4 }

/**
 * ROI 内の小さい候補の判定（全画面の判定より厳しい複合判定）。長さ・面積は処理解像度の px に換算した値。
 * 全画面：面積 300px² 以上・縦横比 2 以上・形状スコア 0.45 以上・ノイズ除去 5×5 のオープニング
 */
export const FAR_CRITERIA = {
  /** 面積の下限（処理解像度 px²） */
  minArea: 24,
  /** 全長の下限（処理解像度 px） */
  minLength: 14,
  /** 縦横比の下限（全画面は 2。遠くのペンはぼけで太く測れるため、5 ではなく 4。形状スコアと被覆率で別に厳しく判定する） */
  minAspect: 4,
  /** 形状スコアの下限（全画面は 0.45） */
  minScore: 0.6,
  /** 見えている面積 / (全長 × 太さ) の下限（点や短い切れ端が一列に並んだ物を 1 本に結合したものを除く） */
  minCoverage: 0.6,
  /** 結合してよい輪郭の数の上限（小さいペンは指で隠れても 2 つまでに分かれる程度） */
  maxSegments: 2,
  /** ROI の端からこの距離（ROI の画像の px）以内に端点がある候補は、ROI の外に続く物（服の縁など）とみなして除く */
  borderMargin: 3,
  /** ノイズ除去：オープニング（細い物を消してしまう）はせず、この大きさのクロージングだけ行う */
  closeKernel: 3,
} as const

/**
 * 探索範囲（処理解像度の座標。正方形）。kind：face（顔の近く）/ hand（手の近く）/ track（見失った直後のペンの位置）/
 * candidate（ノイズ除去の前のマスクで見つけた小さく細長い色の領域。顔・手が小さすぎて MediaPipe で見つからないときの補助）
 */
export type Roi = { x: number; y: number; size: number; kind: 'face' | 'hand' | 'track' | 'candidate' }

export type RoiFace = { center: Point2; faceScale: number }
export type RoiHand = { landmarks: Point2[]; scale: number }
/** ROI を作る、そのほかの手がかり（見失ったペン・小さい色の候補） */
export type RoiHint = { center: Point2; length: number }

export type RoiSources = {
  faces: RoiFace[]
  hands: RoiHand[]
  /** 見失った直後（held）のペン */
  tracked?: RoiHint[]
  /** 小さく細長い色の候補（細長い・大きい順） */
  candidates?: RoiHint[]
  /** 全画面の検出ですでに見つけたペン（これを含む範囲には ROI を作らない。近距離では ROI の処理をしない） */
  found?: PenDetection[]
}

/** ペンの手がかりの ROI の一辺 = 長さ × この値（下限・上限は FAR_ROI と同じ） */
const HINT_ROI_SCALE = 4

/**
 * ROI を作る。優先順：小さく写った顔 → 小さく写った手 → 見失ったペン → 小さい色の候補。
 * 全画面の検出で見つけたペンの近くには作らない。重なる ROI はまとめ、上限 maxRois 個。
 */
export function buildRois(src: RoiSources, width: number, height: number, maxRois: number): Roi[] {
  const { faces, hands } = src
  const short = Math.min(width, height)
  const maxSize = Math.max(FAR_ROI.minSize, short * FAR_ROI.maxSizeRatio)
  const clampSize = (s: number) => Math.min(Math.max(s, FAR_ROI.minSize), maxSize, short)
  const square = (cx: number, cy: number, size: number, kind: Roi['kind']): Roi => {
    const s = clampSize(size)
    return { x: Math.min(Math.max(cx - s / 2, 0), width - s), y: Math.min(Math.max(cy - s / 2, 0), height - s), size: s, kind }
  }
  const rois: Roi[] = []
  // 小さい（遠い）ものから優先する
  for (const f of [...faces].sort((a, b) => a.faceScale - b.faceScale)) {
    if (f.faceScale / short > FAR_ROI.farFaceMaxRatio) continue
    rois.push(square(f.center.x, f.center.y + f.faceScale * FAR_ROI.faceOffsetY, f.faceScale * FAR_ROI.faceScale, 'face'))
  }
  for (const h of [...hands].sort((a, b) => a.scale - b.scale)) {
    if (h.landmarks.length === 0 || h.scale / short > FAR_ROI.farHandMaxRatio) continue
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const p of h.landmarks) {
      x0 = Math.min(x0, p.x)
      y0 = Math.min(y0, p.y)
      x1 = Math.max(x1, p.x)
      y1 = Math.max(y1, p.y)
    }
    rois.push(square((x0 + x1) / 2, (y0 + y1) / 2, h.scale * FAR_ROI.handScale, 'hand'))
  }
  for (const t of src.tracked ?? []) rois.push(square(t.center.x, t.center.y, t.length * HINT_ROI_SCALE, 'track'))
  for (const c of src.candidates ?? []) rois.push(square(c.center.x, c.center.y, c.length * HINT_ROI_SCALE, 'candidate'))
  // 全画面の検出で見つけたペンの中心を含む ROI は作らない（そのペンは全画面の検出で足りる）
  const found = src.found ?? []
  const needed = rois.filter((r) => !found.some((p) => p.center.x >= r.x && p.center.x <= r.x + r.size && p.center.y >= r.y && p.center.y <= r.y + r.size))
  rois.length = 0
  rois.push(...needed)
  // 重なる ROI をまとめる（両方を含む正方形。上限を超える場合はまとめない）
  const merged: Roi[] = []
  for (const r of rois) {
    const i = merged.findIndex((m) => overlapRatio(m, r) >= FAR_ROI.mergeOverlap)
    if (i < 0) {
      merged.push(r)
      continue
    }
    const m = merged[i]
    const x0 = Math.min(m.x, r.x)
    const y0 = Math.min(m.y, r.y)
    const size = Math.max(m.x + m.size, r.x + r.size) - x0
    const sizeY = Math.max(m.y + m.size, r.y + r.size) - y0
    const s = Math.max(size, sizeY)
    if (s <= maxSize) merged[i] = square(x0 + s / 2, y0 + s / 2, s, m.kind)
    else merged.push(r)
  }
  return merged.slice(0, maxRois)
}

function overlapRatio(a: Roi, b: Roi): number {
  const w = Math.min(a.x + a.size, b.x + b.size) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.size, b.y + b.size) - Math.max(a.y, b.y)
  if (w <= 0 || h <= 0) return 0
  return (w * h) / Math.min(a.size * a.size, b.size * b.size)
}

/**
 * ROI（処理解像度・ミラー後の座標）を切り出す、カメラの映像上の範囲。
 * scale は 処理解像度 / カメラの映像 の倍率。mirror なら映像の左右反転した位置から切り出し、描くときに反転する（表示・CG と同じ向き）。
 */
export function roiSourceRect(roi: Roi, frameWidth: number, scale: number, mirror: boolean): { sx: number; sy: number; sw: number; sh: number; flip: boolean } {
  const x = mirror ? frameWidth - roi.x - roi.size : roi.x
  return { sx: x / scale, sy: roi.y / scale, sw: roi.size / scale, sh: roi.size / scale, flip: mirror }
}

/** ROI の画像の座標 → 処理解像度の座標の倍率（ROI の画像 1px が処理解像度の何 px か） */
export function roiScale(roi: Roi): number {
  return roi.size / ROI_IMAGE_SIZE
}

/**
 * ROI の画像の座標で検出したペンを、処理解像度の座標に戻す（CG・追跡・着火はすべてこの座標を使う）。
 * frameWidth / frameHeight は処理解像度の大きさにする。
 */
export function roiToFrame(pen: PenDetection, roi: Roi, frameWidth: number, frameHeight: number): PenDetection {
  const k = roiScale(roi)
  const pt = (p: Point2): Point2 => ({ x: roi.x + p.x * k, y: roi.y + p.y * k })
  const segments: PenSegment[] = pen.segments.map((s) => ({
    ...s,
    area: s.area * k * k,
    centroid: pt(s.centroid),
    center: pt(s.center),
    length: s.length * k,
    thickness: s.thickness * k,
    corners: s.corners.map(pt) as PenSegment['corners'],
    // 2 次の中心モーメントは長さの 4 乗で変わる
    mu20: s.mu20 * k ** 4,
    mu11: s.mu11 * k ** 4,
    mu02: s.mu02 * k ** 4,
  }))
  return penFromAxis(
    {
      center: pt(pen.center),
      u: unitFromAngle(pen.angleDeg),
      length: pen.length * k,
      thickness: pen.thickness * k,
      area: pen.area * k * k,
      segments,
      frameWidth,
      frameHeight,
    },
    true,
  )
}

/** ROI の候補が、ROI の外に続く物（ROI の端で切れている）でないか */
export function insideRoi(pen: PenDetection): boolean {
  const m = FAR_CRITERIA.borderMargin
  return pen.endpoints.every((p) => p.x > m && p.y > m && p.x < ROI_IMAGE_SIZE - m && p.y < ROI_IMAGE_SIZE - m)
}

/** ROI の候補が、遠距離の小さいペンの条件（処理解像度の px に換算）を満たすか */
export function passesFarCriteria(penInFrame: PenDetection): boolean {
  return (
    penInFrame.area >= FAR_CRITERIA.minArea &&
    penInFrame.length >= FAR_CRITERIA.minLength &&
    penInFrame.length / Math.max(penInFrame.thickness, 0.5) >= FAR_CRITERIA.minAspect &&
    penInFrame.area / Math.max(penInFrame.length * penInFrame.thickness, 1e-6) >= FAR_CRITERIA.minCoverage &&
    penInFrame.segments.length <= FAR_CRITERIA.maxSegments
  )
}

/** 色の候補の ROI で何も見つからなかった場所を、この時間は調べ直さない ms（背景の服・旗などで毎フレーム ROI を作らない） */
export const CANDIDATE_RETRY_MS = 700

/**
 * 色の候補の ROI の「空振り」を覚えて、同じ場所の候補を一定時間は ROI にしない（処理負荷の上限）。
 * 顔・手・見失ったペンの ROI には使わない。
 */
export class CandidateMemory {
  private misses: { center: Point2; radius: number; until: number }[] = []

  /** 空振りした場所の近くの候補を除く */
  filter<T extends { center: Point2 }>(candidates: T[], now: number): T[] {
    this.misses = this.misses.filter((m) => m.until > now)
    return candidates.filter((c) => !this.misses.some((m) => Math.hypot(c.center.x - m.center.x, c.center.y - m.center.y) <= m.radius))
  }

  /** 色の候補の ROI で何も見つからなかった */
  miss(roi: Roi, now: number): void {
    this.misses.push({ center: { x: roi.x + roi.size / 2, y: roi.y + roi.size / 2 }, radius: roi.size / 2, until: now + CANDIDATE_RETRY_MS })
  }

  reset(): void {
    this.misses = []
  }
}

export type SourcedDetection = ColoredDetection & { source: 'full' | 'roi' }

/**
 * 全画面の検出と ROI の検出をまとめる。全画面の検出を優先し、ROI の検出は全画面の検出・他の ROI の検出と
 * 同じ物でなければ加える（複数の ROI で同じペンを見つけた場合は 1 本にする）。合計 maxPens 本まで。
 */
export function mergeDetections(full: ColoredDetection[], roi: ColoredDetection[], maxPens: number): SourcedDetection[] {
  const out: SourcedDetection[] = full.map((d) => ({ ...d, source: 'full' as const }))
  const rank = (d: ColoredDetection) => d.pen.area * (d.score?.total ?? 1)
  for (const d of [...roi].sort((a, b) => rank(b) - rank(a))) {
    if (out.length >= maxPens) break
    if (out.some((k) => sameObject(k.pen, d.pen))) continue
    out.push({ ...d, source: 'roi' })
  }
  return out.slice(0, maxPens)
}
