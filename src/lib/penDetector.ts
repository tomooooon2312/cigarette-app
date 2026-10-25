import type { Mat } from '@techstark/opencv-js'
import { FAR_CRITERIA, ROI_IMAGE_SIZE, insideRoi, passesFarCriteria, roiScale, roiToFrame, type Roi } from './farDetection'
import type { OpenCv } from './opencv'
import { ACHROMATIC_SCORE_PENALTY, type PenColor } from './penColors'
import { scorePenShape, type ShapeHand, type ShapeScore, type ShapeSettings } from './penShape'
import {
  axisAngleDiff,
  findPen,
  findPens,
  findScoredPens,
  segmentFromRect,
  type FilterSettings,
  type MergeSettings,
  type PenDetection,
  type PenSegment,
} from './penGeometry'

/** OpenCV の HSV 範囲（H: 0-179, S/V: 0-255）。hMin > hMax のときは色相の折り返し（赤〜ピンク）として扱う */
export type HsvRange = {
  hMin: number
  hMax: number
  sMin: number
  sMax: number
  vMin: number
  vMax: number
}

export type DetectorSettings = HsvRange & FilterSettings & MergeSettings

export type { PenDetection, PenSegment, Point2 } from './penGeometry'

/** STEP 6：色ごとの検出結果 */
export type ColoredDetection = {
  pen: PenDetection
  /** 検出した色（PenColor.id） */
  colorId: string
  /** 形状スコア（形状判定が OFF なら null） */
  score: ShapeScore | null
}

export type ColorDetectOptions = {
  shape: ShapeSettings
  /** 手のランドマーク（手の推論が無い・使わないなら null） */
  hands: ShapeHand[] | null
  /**
   * 遠距離認識モード：ノイズ除去の前の色のマスクから、小さく細長い候補（遠くのペンかもしれない物）をここに集める。
   * 全画面の検出の結果は変わらない（候補は ROI の場所を決めるだけで、ペンとは判定しない）
   */
  smallCandidates?: SmallCandidate[]
}

/** 遠距離認識の ROI の候補：ノイズ除去の前のマスクで見つけた、小さく細長い色の領域（処理解像度の座標） */
export type SmallCandidate = { center: { x: number; y: number }; length: number; area: number; aspect: number }

/** 小さい候補の条件（処理解像度）：面積 SMALL_MIN_AREA 以上・全画面の最小面積未満、縦横比 SMALL_MIN_ASPECT 以上、長さ SMALL_MIN_LENGTH 以上 */
const SMALL_MIN_AREA = 6
const SMALL_MIN_ASPECT = 3
const SMALL_MIN_LENGTH = 8
/** 集める候補の上限（細長い・大きい順） */
const SMALL_MAX_CANDIDATES = 8

/** 色ごとのマスクと、inRange の範囲（毎フレーム作り直さないよう色ごとに保持） */
type ColorMats = {
  mask: Mat
  maskAlt: Mat
  lower: Mat
  upper: Mat
  lowerAlt: Mat
  upperAlt: Mat
  rangeKey: string
}

/** 別々の色で検出した 2 本を「同じ物」とみなす条件（重複除去）：角度差・軸からのずれ（太さに対する倍率）・重なり */
const DUPLICATE_MAX_ANGLE = 20
const DUPLICATE_MAX_OFFSET = 1
const DUPLICATE_MIN_OVERLAP = 0.5

export const DEFAULT_SETTINGS: DetectorSettings = {
  hMin: 140,
  hMax: 175,
  sMin: 70,
  sMax: 255,
  vMin: 70,
  vMax: 255,
  minArea: 300,
  minAspectRatio: 2,
  maxGapRatio: 4,
  maxAngleDiff: 15,
}

/** cv.moments の戻り値（型定義が any のため必要な項目だけ定義） */
type RawMoments = { m00: number; m10: number; m01: number; mu20: number; mu11: number; mu02: number }

type FrameMats = {
  width: number
  height: number
  rgba: Mat
  rgb: Mat
  hsv: Mat
  mask: Mat
  maskAlt: Mat
  lower: Mat
  upper: Mat
  lowerAlt: Mat
  upperAlt: Mat
}

const KERNEL_SIZE = 5
/** 遠距離認識の ROI の候補として拾う輪郭の最小面積（ROI の画像の px²） */
const ROI_MIN_SEGMENT_AREA_PX = 6

/** 遠距離認識の ROI 用の Mat（ROI_IMAGE_SIZE 四方に固定して使い回す） */
type RoiMats = { rgba: Mat; rgb: Mat; hsv: Mat; colors: Map<string, ColorMats> }
/** 結合候補として拾う輪郭の最小面積（minArea に対する比率）。指の間から覗く短い根元も拾うため小さめにする */
const SEGMENT_AREA_RATIO = 0.2
const MIN_SEGMENT_AREA_PX = 30

/**
 * ピンク色のペン 1 本（STEP 5 からは最大 3 本）を検出する。
 * 指で挟んで分断された場合に備え、ピンク領域の輪郭を複数候補として取り出し penGeometry で結合する。
 * 毎フレームの確保・解放を避けるため Mat はフレームサイズごとに使い回し、dispose() で一括解放する。
 */
export class PenDetector {
  private readonly cv: OpenCv
  private readonly kernel: Mat
  /** 遠距離認識の ROI のノイズ除去（細いペンを消さない小さいクロージングだけ） */
  private roiKernel: Mat | null = null
  private roiMats: RoiMats | null = null
  private mats: FrameMats | null = null
  private colorMats = new Map<string, ColorMats>()
  private overlay: Mat | null = null
  private appliedRangeKey = ''
  private disposed = false

  constructor(cv: OpenCv) {
    this.cv = cv
    this.kernel = cv.getStructuringElement(
      cv.MORPH_ELLIPSE,
      new cv.Size(KERNEL_SIZE, KERNEL_SIZE),
    )
  }

  /** 直近フレームのノイズ除去済み二値マスク */
  get mask(): Mat | null {
    return this.mats?.mask ?? null
  }

  /** 直近フレームの HSV 画像（STEP 4：ライター検出で色変換を重複させないために共有する。読み取り専用） */
  get hsv(): Mat | null {
    return this.mats?.hsv ?? null
  }

  detect(image: ImageData, settings: DetectorSettings): PenDetection | null {
    const m = this.prepareMask(image, settings)
    return findPen(this.extractSegments(m.mask, settings), settings, m.width, m.height)
  }

  /**
   * STEP 5：最大 maxPens 本のペンを検出する。色変換・マスク・輪郭抽出は 1 回だけ行い、全ペンで共有する。
   * maxPens = 1 のときは detect と同じ結果（配列）を返す。
   */
  detectAll(image: ImageData, settings: DetectorSettings, maxPens: number): PenDetection[] {
    const m = this.prepareMask(image, settings)
    return findPens(this.extractSegments(m.mask, settings), settings, m.width, m.height, maxPens)
  }

  private prepareMask(image: ImageData, settings: DetectorSettings): FrameMats {
    if (this.disposed) throw new Error('PenDetector is disposed')
    const cv = this.cv
    const m = this.ensureMats(image.width, image.height)

    m.rgba.data.set(image.data)
    // OpenCV.js には RGBA→HSV が無いため RGB を経由する
    cv.cvtColor(m.rgba, m.rgb, cv.COLOR_RGBA2RGB)
    cv.cvtColor(m.rgb, m.hsv, cv.COLOR_RGB2HSV)

    this.applyRange(m, settings)
    cv.inRange(m.hsv, m.lower, m.upper, m.mask)
    if (settings.hMin > settings.hMax) {
      cv.inRange(m.hsv, m.lowerAlt, m.upperAlt, m.maskAlt)
      cv.bitwise_or(m.mask, m.maskAlt, m.mask)
    }

    // オープニングで小さな点ノイズを除去し、クロージングでペン内部の穴・ハイライトを埋める
    cv.morphologyEx(m.mask, m.mask, cv.MORPH_OPEN, this.kernel)
    cv.morphologyEx(m.mask, m.mask, cv.MORPH_CLOSE, this.kernel)
    return m
  }

  /**
   * STEP 6：複数の色のペンを検出する。HSV 変換は 1 回だけ行い、色ごとにマスク・輪郭抽出・結合・形状判定をする。
   * - 結合は色ごとに行うので、別々の色の領域を 1 本に結合しない。
   * - 形状判定が ON なら、ペンらしさのスコア（penShape.ts）が下限未満の候補を除外する。
   * - 複数の色の範囲に入る物（ピンクと赤の境目など）は、重なる検出を 1 本にまとめる（スコア × 面積の大きい方を残す）。
   * - mask（ゲッター）は全色のマスクの和になる（ライター検出でペンの画素を除外するのに使う）。
   * 1 色・形状判定 OFF のときは、その色の範囲で detectAll と同じ結果になる。
   */
  detectColors(
    image: ImageData,
    settings: FilterSettings & MergeSettings,
    colors: PenColor[],
    maxPens: number,
    options: ColorDetectOptions,
  ): ColoredDetection[] {
    if (this.disposed) throw new Error('PenDetector is disposed')
    const cv = this.cv
    const m = this.ensureMats(image.width, image.height)
    m.rgba.data.set(image.data)
    cv.cvtColor(m.rgba, m.rgb, cv.COLOR_RGBA2RGB)
    cv.cvtColor(m.rgb, m.hsv, cv.COLOR_RGB2HSV)
    m.mask.setTo(new cv.Scalar(0))
    // 範囲キャッシュを無効にする（m.mask を detect と共用しているため、次の detect で範囲を設定し直す）
    this.appliedRangeKey = ''

    const all: ColoredDetection[] = []
    for (const color of colors) {
      const cm = this.colorMask(color, m, settings.minArea, options.smallCandidates)
      if (!cm.present) continue
      const maskData = cm.mask.data as Uint8Array
      const segments = this.extractSegments(cm.mask, settings)
      const minScore = options.shape.minScore + (color.achromatic ? ACHROMATIC_SCORE_PENALTY : 0)
      const hands = options.shape.useHands ? options.hands : null
      const evaluate = options.shape.enabled
        ? (pen: PenDetection) => {
            const score = scorePenShape(pen, maskData, hands)
            return score.total >= minScore ? score : null
          }
        : undefined
      for (const r of findScoredPens(segments, settings, m.width, m.height, maxPens, evaluate)) {
        all.push({ pen: r.pen, colorId: color.id, score: r.score })
      }
      cv.bitwise_or(m.mask, cm.mask, m.mask)
    }
    if (colors.length <= 1) return all
    return dedupeAcrossColors(all).slice(0, maxPens)
  }

  /**
   * 遠距離認識モード：ROI の画像（ROI_IMAGE_SIZE 四方。カメラの映像から切り出したもの）から小さいペンを探す。
   * 結果は処理解像度の座標（roiToFrame）に戻して返す。判定は全画面より厳しい（FAR_CRITERIA、形状判定は常に使う）。
   * hands は処理解像度の座標。frameWidth / frameHeight は処理解像度の大きさ。
   */
  detectInRoi(
    image: ImageData,
    roi: Roi,
    frameWidth: number,
    frameHeight: number,
    settings: FilterSettings & MergeSettings,
    colors: PenColor[],
    maxPens: number,
    options: ColorDetectOptions,
  ): ColoredDetection[] {
    if (this.disposed) throw new Error('PenDetector is disposed')
    if (image.width !== ROI_IMAGE_SIZE || image.height !== ROI_IMAGE_SIZE) throw new Error('ROI の画像の大きさが違います')
    const cv = this.cv
    const m = this.ensureRoiMats()
    m.rgba.data.set(image.data)
    cv.cvtColor(m.rgba, m.rgb, cv.COLOR_RGBA2RGB)
    cv.cvtColor(m.rgb, m.hsv, cv.COLOR_RGB2HSV)
    const k = roiScale(roi)
    // ROI の画像の px に換算した条件
    const roiSettings = { ...settings, minArea: FAR_CRITERIA.minArea / (k * k), minAspectRatio: FAR_CRITERIA.minAspect }
    const toRoi = (p: { x: number; y: number }) => ({ x: (p.x - roi.x) / k, y: (p.y - roi.y) / k })
    const hands = options.shape.useHands && options.hands ? options.hands.map((h) => ({ points: h.points.map(toRoi), scale: h.scale / k })) : null
    // 面積・太さの比率は、ROI ではなく画面全体（ROI の画像の px に換算）に対して測る
    const ratioFrame = { width: frameWidth / k, height: frameHeight / k }
    const all: ColoredDetection[] = []
    for (const color of colors) {
      const cm = this.roiColorMask(color, m)
      if (cv.countNonZero(cm.mask) < roiSettings.minArea) continue
      const maskData = cm.mask.data as Uint8Array
      const segments = this.extractSegments(cm.mask, roiSettings, ROI_MIN_SEGMENT_AREA_PX)
      const minScore = FAR_CRITERIA.minScore + (color.achromatic ? ACHROMATIC_SCORE_PENALTY : 0)
      const evaluate = (pen: PenDetection) => {
        if (!insideRoi(pen)) return null
        const score = scorePenShape(pen, maskData, hands, ratioFrame)
        return score.total >= minScore ? score : null
      }
      for (const r of findScoredPens(segments, roiSettings, ROI_IMAGE_SIZE, ROI_IMAGE_SIZE, maxPens, evaluate)) {
        const pen = roiToFrame(r.pen, roi, frameWidth, frameHeight)
        if (passesFarCriteria(pen)) all.push({ pen, colorId: color.id, score: r.score })
      }
    }
    return colors.length <= 1 ? all : dedupeAcrossColors(all).slice(0, maxPens)
  }

  private ensureRoiMats(): RoiMats {
    if (this.roiMats) return this.roiMats
    const cv = this.cv
    const n = ROI_IMAGE_SIZE
    this.roiKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(FAR_CRITERIA.closeKernel, FAR_CRITERIA.closeKernel))
    this.roiMats = { rgba: new cv.Mat(n, n, cv.CV_8UC4), rgb: new cv.Mat(n, n, cv.CV_8UC3), hsv: new cv.Mat(n, n, cv.CV_8UC3), colors: new Map() }
    return this.roiMats
  }

  /** ROI の色のマスク（オープニングはせず、小さいクロージングだけ。細い・小さいペンを消さない） */
  private roiColorMask(color: PenColor, m: RoiMats): ColorMats {
    const cv = this.cv
    const n = ROI_IMAGE_SIZE
    let cm = m.colors.get(color.id)
    if (!cm) {
      const mat = (type: number) => new cv.Mat(n, n, type)
      cm = { mask: mat(cv.CV_8UC1), maskAlt: mat(cv.CV_8UC1), lower: mat(cv.CV_8UC3), upper: mat(cv.CV_8UC3), lowerAlt: mat(cv.CV_8UC3), upperAlt: mat(cv.CV_8UC3), rangeKey: '' }
      m.colors.set(color.id, cm)
    }
    const s = color.hsv
    const wraps = s.hMin > s.hMax
    const key = `${s.hMin},${s.hMax},${s.sMin},${s.sMax},${s.vMin},${s.vMax}`
    if (key !== cm.rangeKey) {
      cm.rangeKey = key
      cm.lower.setTo(new cv.Scalar(s.hMin, s.sMin, s.vMin, 0))
      cm.upper.setTo(new cv.Scalar(wraps ? 179 : s.hMax, s.sMax, s.vMax, 0))
      cm.lowerAlt.setTo(new cv.Scalar(0, s.sMin, s.vMin, 0))
      cm.upperAlt.setTo(new cv.Scalar(s.hMax, s.sMax, s.vMax, 0))
    }
    cv.inRange(m.hsv, cm.lower, cm.upper, cm.mask)
    if (wraps) {
      cv.inRange(m.hsv, cm.lowerAlt, cm.upperAlt, cm.maskAlt)
      cv.bitwise_or(cm.mask, cm.maskAlt, cm.mask)
    }
    cv.morphologyEx(cm.mask, cm.mask, cv.MORPH_CLOSE, this.roiKernel!)
    return cm
  }

  /** 色ごとのマスクを色分けした RGBA 画像（デバッグ用の「色マスク」表示）。detectColors の後に呼ぶ */
  colorMaskImage(colors: PenColor[]): Mat | null {
    const m = this.mats
    if (!m) return null
    const cv = this.cv
    if (!this.overlay || this.overlay.rows !== m.height || this.overlay.cols !== m.width) {
      this.overlay?.delete()
      this.overlay = new cv.Mat(m.height, m.width, cv.CV_8UC4)
    }
    this.overlay.setTo(new cv.Scalar(0, 0, 0, 255))
    for (const color of colors) {
      const cm = this.colorMats.get(color.id)
      if (!cm) continue
      const [r, g, b] = hexToRgb(color.swatch)
      this.overlay.setTo(new cv.Scalar(r, g, b, 255), cm.mask)
    }
    return this.overlay
  }

  /**
   * 色のマスクを作る。範囲に入る画素がペン 1 本分（最小面積）に満たない色は、
   * ノイズ除去と輪郭抽出を省略する（present = false。全色同時認識の負荷を下げるため）。
   */
  private colorMask(color: PenColor, m: FrameMats, minArea: number, small?: SmallCandidate[]): ColorMats & { present: boolean } {
    const cv = this.cv
    let cm = this.colorMats.get(color.id)
    if (!cm) {
      const mat = (type: number) => new cv.Mat(m.height, m.width, type)
      cm = {
        mask: mat(cv.CV_8UC1),
        maskAlt: mat(cv.CV_8UC1),
        lower: mat(cv.CV_8UC3),
        upper: mat(cv.CV_8UC3),
        lowerAlt: mat(cv.CV_8UC3),
        upperAlt: mat(cv.CV_8UC3),
        rangeKey: '',
      }
      this.colorMats.set(color.id, cm)
    }
    const s = color.hsv
    const wraps = s.hMin > s.hMax
    const key = `${s.hMin},${s.hMax},${s.sMin},${s.sMax},${s.vMin},${s.vMax}`
    if (key !== cm.rangeKey) {
      cm.rangeKey = key
      cm.lower.setTo(new cv.Scalar(s.hMin, s.sMin, s.vMin, 0))
      cm.upper.setTo(new cv.Scalar(wraps ? 179 : s.hMax, s.sMax, s.vMax, 0))
      cm.lowerAlt.setTo(new cv.Scalar(0, s.sMin, s.vMin, 0))
      cm.upperAlt.setTo(new cv.Scalar(s.hMax, s.sMax, s.vMax, 0))
    }
    cv.inRange(m.hsv, cm.lower, cm.upper, cm.mask)
    if (wraps) {
      // 赤のように色相が 0/179 をまたぐ範囲は、「最小〜179」と「0〜最大」の和
      cv.inRange(m.hsv, cm.lowerAlt, cm.upperAlt, cm.maskAlt)
      cv.bitwise_or(cm.mask, cm.maskAlt, cm.mask)
    }
    const count = cv.countNonZero(cm.mask)
    // 遠距離認識モード：ノイズ除去（細い物を消すオープニング）の前のマスクから、小さく細長い候補を集める
    if (small && count >= SMALL_MIN_AREA) this.collectSmall(cm.mask, minArea, small)
    if (count < minArea) {
      cm.mask.setTo(new cv.Scalar(0))
      return { ...cm, present: false }
    }
    cv.morphologyEx(cm.mask, cm.mask, cv.MORPH_OPEN, this.kernel)
    cv.morphologyEx(cm.mask, cm.mask, cv.MORPH_CLOSE, this.kernel)
    return { ...cm, present: true }
  }

  /** マスク（変更しない）から、小さく細長い輪郭を集める（遠距離認識の ROI の候補） */
  private collectSmall(mask: Mat, minArea: number, out: SmallCandidate[]): void {
    const cv = this.cv
    const contours = new cv.MatVector()
    const hierarchy = new cv.Mat()
    try {
      // OpenCV 3.2 以降の findContours は入力の画像を変更しない
      cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i)
        try {
          const area = cv.contourArea(c)
          if (area < SMALL_MIN_AREA || area >= minArea) continue
          const r = cv.minAreaRect(c)
          const length = Math.max(r.size.width, r.size.height)
          const aspect = length / Math.max(Math.min(r.size.width, r.size.height), 1)
          if (length < SMALL_MIN_LENGTH || aspect < SMALL_MIN_ASPECT) continue
          out.push({ center: { x: r.center.x, y: r.center.y }, length, area, aspect })
        } finally {
          c.delete()
        }
      }
    } finally {
      contours.delete()
      hierarchy.delete()
    }
    out.sort((a, b) => b.aspect * b.area - a.aspect * a.area)
    out.splice(SMALL_MAX_CANDIDATES)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.releaseMats()
    this.kernel.delete()
    if (this.roiMats) {
      for (const mat of [this.roiMats.rgba, this.roiMats.rgb, this.roiMats.hsv]) mat.delete()
      for (const cm of this.roiMats.colors.values()) {
        for (const mat of [cm.mask, cm.maskAlt, cm.lower, cm.upper, cm.lowerAlt, cm.upperAlt]) mat.delete()
      }
      this.roiMats = null
    }
    this.roiKernel?.delete()
    this.roiKernel = null
  }

  private extractSegments(mask: Mat, settings: FilterSettings, minSegmentPx = MIN_SEGMENT_AREA_PX): PenSegment[] {
    const cv = this.cv
    const contours = new cv.MatVector()
    const hierarchy = new cv.Mat()
    const minSegmentArea = Math.max(settings.minArea * SEGMENT_AREA_RATIO, minSegmentPx)
    const segments: PenSegment[] = []
    try {
      cv.findContours(
        mask,
        contours,
        hierarchy,
        cv.RETR_EXTERNAL,
        cv.CHAIN_APPROX_SIMPLE,
      )
      const count = contours.size()
      for (let i = 0; i < count; i++) {
        const contour = contours.get(i)
        try {
          if (cv.contourArea(contour) < minSegmentArea) continue
          const rect = cv.minAreaRect(contour)
          const moments = cv.moments(contour, false) as RawMoments
          segments.push(
            segmentFromRect(
              {
                cx: rect.center.x,
                cy: rect.center.y,
                w: rect.size.width,
                h: rect.size.height,
                angle: rect.angle,
              },
              moments,
            ),
          )
        } finally {
          contour.delete()
        }
      }
      return segments
    } finally {
      contours.delete()
      hierarchy.delete()
    }
  }

  private applyRange(m: FrameMats, s: HsvRange): void {
    const key = `${s.hMin},${s.hMax},${s.sMin},${s.sMax},${s.vMin},${s.vMax}`
    if (key === this.appliedRangeKey) return
    this.appliedRangeKey = key

    const cv = this.cv
    const wraps = s.hMin > s.hMax
    m.lower.setTo(new cv.Scalar(s.hMin, s.sMin, s.vMin, 0))
    m.upper.setTo(new cv.Scalar(wraps ? 179 : s.hMax, s.sMax, s.vMax, 0))
    if (wraps) {
      m.lowerAlt.setTo(new cv.Scalar(0, s.sMin, s.vMin, 0))
      m.upperAlt.setTo(new cv.Scalar(s.hMax, s.sMax, s.vMax, 0))
    }
  }

  private ensureMats(width: number, height: number): FrameMats {
    if (this.mats && this.mats.width === width && this.mats.height === height) {
      return this.mats
    }
    this.releaseMats()
    const cv = this.cv
    const mat = (type: number) => new cv.Mat(height, width, type)
    this.mats = {
      width,
      height,
      rgba: mat(cv.CV_8UC4),
      rgb: mat(cv.CV_8UC3),
      hsv: mat(cv.CV_8UC3),
      mask: mat(cv.CV_8UC1),
      maskAlt: mat(cv.CV_8UC1),
      lower: mat(cv.CV_8UC3),
      upper: mat(cv.CV_8UC3),
      lowerAlt: mat(cv.CV_8UC3),
      upperAlt: mat(cv.CV_8UC3),
    }
    this.appliedRangeKey = ''
    return this.mats
  }

  private releaseMats(): void {
    for (const cm of this.colorMats.values()) {
      for (const mat of [cm.mask, cm.maskAlt, cm.lower, cm.upper, cm.lowerAlt, cm.upperAlt]) mat.delete()
    }
    this.colorMats.clear()
    this.overlay?.delete()
    this.overlay = null
    if (!this.mats) return
    const m = this.mats
    for (const mat of [m.rgba, m.rgb, m.hsv, m.mask, m.maskAlt, m.lower, m.upper, m.lowerAlt, m.upperAlt]) {
      mat.delete()
    }
    this.mats = null
  }
}

/** "#rrggbb" → [r, g, b]（解釈できなければ白） */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255]
}

/** 2 本の検出が同じ物か（角度がほぼ同じ・同じ軸の上・軸方向に半分以上重なる） */
export function sameObject(a: PenDetection, b: PenDetection): boolean {
  if (axisAngleDiff(a.angleDeg, b.angleDeg) > DUPLICATE_MAX_ANGLE) return false
  const [e0, e1] = a.endpoints
  const len = Math.hypot(e1.x - e0.x, e1.y - e0.y) || 1
  const u = { x: (e1.x - e0.x) / len, y: (e1.y - e0.y) / len }
  const dx = b.center.x - a.center.x
  const dy = b.center.y - a.center.y
  if (Math.abs(-u.y * dx + u.x * dy) > Math.max(a.thickness, b.thickness) * DUPLICATE_MAX_OFFSET) return false
  const t = u.x * dx + u.y * dy
  const overlap = Math.min(a.length / 2, t + b.length / 2) - Math.max(-a.length / 2, t - b.length / 2)
  return overlap >= Math.min(a.length, b.length) * DUPLICATE_MIN_OVERLAP
}

/** 色をまたいだ重複除去：スコア × 面積の大きい順に残し、残した物と同じ物は捨てる */
export function dedupeAcrossColors(all: ColoredDetection[]): ColoredDetection[] {
  const rank = (d: ColoredDetection) => d.pen.area * (d.score?.total ?? 1)
  const kept: ColoredDetection[] = []
  for (const d of [...all].sort((a, b) => rank(b) - rank(a))) {
    if (!kept.some((k) => sameObject(k.pen, d.pen))) kept.push(d)
  }
  return kept
}
