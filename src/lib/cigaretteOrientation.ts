import type { Point2 } from './penGeometry'

/** 反対側の端の方が、顔の大きさ × この値以上口元に近いときだけ反転を検討する（距離差のヒステリシス） */
export const ORIENT_SWITCH_MARGIN = 0.25
/** 反転条件がこの回数の推論結果で連続したら反転する */
export const ORIENT_SWITCH_SAMPLES = 3
/** ペンの近い方の端が口元から 顔の大きさ × この値 より遠いときは判定しない（顔から離れた位置での誤反転防止） */
export const ORIENT_MAX_DISTANCE = 4

export type OrientationPen = {
  center: Point2
  /** 追跡中のペンの両端 */
  endpoints: [Point2, Point2]
  length: number
}

export type OrientationMouth = {
  center: Point2
  faceScale: number
  sampleId: number
}

const dot = (a: Point2, b: Point2) => a.x * b.x + a.y * b.y

/**
 * タバコ CG の向き（吸い口 → 火 の方向）を、唇の中心に近い端がフィルターになるように自動で決める。
 *
 * - 向きは端点の番号ではなく画面上のベクトルとして保持し、毎フレーム現在のペンの軸に合わせる。
 *   端点の順序が入れ替わっても（再検出時など）、向きが突然反転しない。
 * - 反転するのは、反対側の端が「距離差のヒステリシス」を超えて口元に近い状態が、
 *   推論結果で ORIENT_SWITCH_SAMPLES 回続いたときだけ。
 * - 顔を見失っている間（mouth = null）は直前の向きを維持する。
 */
export class CigaretteOrienter {
  private emberDir: Point2 | null = null
  private pending = 0
  private lastSampleId = -1

  reset(): void {
    this.emberDir = null
    this.pending = 0
    this.lastSampleId = -1
  }

  /** 吸い口 → 火 の単位ベクトルを返す（ペンの軸に平行） */
  update(pen: OrientationPen, mouth: OrientationMouth | null): Point2 {
    const [e0, e1] = pen.endpoints
    const len = Math.hypot(e1.x - e0.x, e1.y - e0.y) || 1
    const u = { x: (e1.x - e0.x) / len, y: (e1.y - e0.y) / len }
    // 初回は従来どおり endpoints[0] 側を吸い口にする
    let dir = this.emberDir && dot(this.emberDir, u) < 0 ? { x: -u.x, y: -u.y } : u

    if (mouth && mouth.sampleId !== this.lastSampleId) {
      this.lastSampleId = mouth.sampleId
      const half = pen.length / 2
      const filterEnd = { x: pen.center.x - dir.x * half, y: pen.center.y - dir.y * half }
      const emberEnd = { x: pen.center.x + dir.x * half, y: pen.center.y + dir.y * half }
      const dFilter = Math.hypot(filterEnd.x - mouth.center.x, filterEnd.y - mouth.center.y) / mouth.faceScale
      const dEmber = Math.hypot(emberEnd.x - mouth.center.x, emberEnd.y - mouth.center.y) / mouth.faceScale
      const shouldFlip =
        Math.min(dFilter, dEmber) <= ORIENT_MAX_DISTANCE && dEmber + ORIENT_SWITCH_MARGIN < dFilter
      this.pending = shouldFlip ? this.pending + 1 : 0
      if (this.pending >= ORIENT_SWITCH_SAMPLES) {
        dir = { x: -dir.x, y: -dir.y }
        this.pending = 0
      }
    }
    this.emberDir = dir
    return dir
  }
}
