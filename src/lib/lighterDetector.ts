import type { Mat } from '@techstark/opencv-js'
import type { OpenCv } from './opencv'
import { axisAngleDeg, penFromAxis, unitFromAngle, type PenDetection, type Point2 } from './penGeometry'

/** ライターとして認識する長方形の小物の設定（単色で輪郭のはっきりしたもの） */
export type LighterSettings = {
  hMin: number
  hMax: number
  sMin: number
  vMin: number
  /** 輪郭面積の下限 px² */
  minArea: number
  /** 長方形らしさ（輪郭面積 / 最小外接矩形の面積）の下限 */
  minRectangularity: number
  /** 長辺 / 短辺 の範囲 */
  minAspect: number
  maxAspect: number
}

/** 既定は青系（ピンクのペンと色相が重ならない） */
export const DEFAULT_LIGHTER: LighterSettings = {
  hMin: 95,
  hMax: 130,
  sMin: 110,
  vMin: 60,
  minArea: 800,
  minRectangularity: 0.8,
  minAspect: 1.3,
  maxAspect: 4.5,
}

export type RectCandidate = {
  area: number
  /** approxPolyDP の頂点数 */
  vertices: number
  convex: boolean
  /** minAreaRect */
  cx: number
  cy: number
  w: number
  h: number
  angle: number
}

/**
 * 長方形判定（OpenCV に依存しない部分）。
 * 輪郭近似で 4 頂点・凸であること、輪郭が最小外接矩形をほぼ埋めること、縦横比が範囲内であることを確かめる。
 */
export function isLighterRectangle(c: RectCandidate, s: LighterSettings): boolean {
  if (c.area < s.minArea) return false
  if (c.vertices !== 4 || !c.convex) return false
  const rectArea = c.w * c.h
  if (rectArea <= 0 || c.area / rectArea < s.minRectangularity) return false
  const aspect = Math.max(c.w, c.h) / Math.max(Math.min(c.w, c.h), 1)
  return aspect >= s.minAspect && aspect <= s.maxAspect
}

/** 長方形の候補を、ペンと同じ形式の検出結果（中心・長軸角度・長辺・短辺）に変換する */
export function rectangleToDetection(c: RectCandidate, frameWidth: number, frameHeight: number): PenDetection {
  const length = Math.max(c.w, c.h)
  const thickness = Math.min(c.w, c.h)
  const angle = axisAngleDeg(unitFromAngle(c.w >= c.h ? c.angle : c.angle + 90))
  return penFromAxis({
    center: { x: c.cx, y: c.cy },
    u: unitFromAngle(angle),
    length,
    thickness,
    area: c.area,
    segments: [],
    frameWidth,
    frameHeight,
  })
}

/**
 * ライターの火が出る位置：長軸の両端のうち画面上で上にある端（ライターは火口を上にして持つ前提）の少し先。
 * 返り値の up は火口側の単位ベクトル（キャップの描画にも使う）。
 */
export function lighterNozzle(d: Pick<PenDetection, 'center' | 'endpoints' | 'length'>): { nozzle: Point2; flameBase: Point2; up: Point2 } {
  const [a, b] = d.endpoints
  const top = a.y <= b.y ? a : b
  const len = Math.hypot(top.x - d.center.x, top.y - d.center.y) || 1
  const up = { x: (top.x - d.center.x) / len, y: (top.y - d.center.y) / len }
  return {
    nozzle: top,
    flameBase: { x: top.x + up.x * d.length * 0.06, y: top.y + up.y * d.length * 0.06 },
    up,
  }
}

const KERNEL_SIZE = 5

/**
 * OpenCV.js による長方形の小物（ライター）の検出。
 * ペン検出で作った HSV 画像とマスクを受け取り、色抽出 → ペンの画素を除外 → ノイズ除去 → 輪郭 → 近似 → 長方形判定 を行う。
 * Mat はフレームサイズごとに使い回し、dispose() で解放する。
 */
export class LighterDetector {
  private readonly cv: OpenCv
  private readonly kernel: Mat
  private mats: { width: number; height: number; mask: Mat; lower: Mat; upper: Mat } | null = null
  private appliedKey = ''

  constructor(cv: OpenCv) {
    this.cv = cv
    this.kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(KERNEL_SIZE, KERNEL_SIZE))
  }

  /** 直近フレームのライター用マスク（デバッグ表示用） */
  get mask(): Mat | null {
    return this.mats?.mask ?? null
  }

  detect(hsv: Mat, penMask: Mat | null, s: LighterSettings): PenDetection | null {
    const cv = this.cv
    const m = this.ensureMats(hsv.cols, hsv.rows)
    const key = `${s.hMin},${s.hMax},${s.sMin},${s.vMin}`
    if (key !== this.appliedKey) {
      this.appliedKey = key
      m.lower.setTo(new cv.Scalar(Math.min(s.hMin, s.hMax), s.sMin, s.vMin, 0))
      m.upper.setTo(new cv.Scalar(Math.max(s.hMin, s.hMax), 255, 255, 0))
    }
    cv.inRange(hsv, m.lower, m.upper, m.mask)
    // ペン（ピンク）として抽出した画素はライターの候補から除く（色範囲が重なるように設定された場合の干渉防止）
    if (penMask) cv.subtract(m.mask, penMask, m.mask)
    cv.morphologyEx(m.mask, m.mask, cv.MORPH_OPEN, this.kernel)
    cv.morphologyEx(m.mask, m.mask, cv.MORPH_CLOSE, this.kernel)

    const contours = new cv.MatVector()
    const hierarchy = new cv.Mat()
    const approx = new cv.Mat()
    try {
      cv.findContours(m.mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
      let best: RectCandidate | null = null
      const count = contours.size()
      for (let i = 0; i < count; i++) {
        const contour = contours.get(i)
        try {
          const area = cv.contourArea(contour)
          if (area < s.minArea || (best && area <= best.area)) continue
          cv.approxPolyDP(contour, approx, 0.04 * cv.arcLength(contour, true), true)
          const rect = cv.minAreaRect(contour)
          const candidate: RectCandidate = {
            area,
            vertices: approx.rows,
            convex: cv.isContourConvex(approx),
            cx: rect.center.x,
            cy: rect.center.y,
            w: rect.size.width,
            h: rect.size.height,
            angle: rect.angle,
          }
          if (isLighterRectangle(candidate, s)) best = candidate
        } finally {
          contour.delete()
        }
      }
      return best ? rectangleToDetection(best, m.width, m.height) : null
    } finally {
      contours.delete()
      hierarchy.delete()
      approx.delete()
    }
  }

  dispose(): void {
    if (this.mats) {
      this.mats.mask.delete()
      this.mats.lower.delete()
      this.mats.upper.delete()
      this.mats = null
    }
    this.kernel.delete()
  }

  private ensureMats(width: number, height: number) {
    if (this.mats && this.mats.width === width && this.mats.height === height) return this.mats
    if (this.mats) {
      this.mats.mask.delete()
      this.mats.lower.delete()
      this.mats.upper.delete()
    }
    const cv = this.cv
    this.mats = {
      width,
      height,
      mask: new cv.Mat(height, width, cv.CV_8UC1),
      lower: new cv.Mat(height, width, cv.CV_8UC3),
      upper: new cv.Mat(height, width, cv.CV_8UC3),
    }
    this.appliedKey = ''
    return this.mats
  }
}
