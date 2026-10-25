import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, before, describe, it } from 'node:test'
import { CigaretteLifeManager } from '../src/lib/cigaretteLife.ts'
import { DEFAULT_CIGARETTE, placeCigarette } from '../src/lib/cigaretteRenderer.ts'
import {
  CANDIDATE_RETRY_MS,
  CandidateMemory,
  FAR_ROI,
  MAX_ROIS,
  ROI_IMAGE_SIZE,
  buildRois,
  mergeDetections,
  roiSourceRect,
  type Roi,
  type RoiFace,
} from '../src/lib/farDetection.ts'
import { MultiPenTracker } from '../src/lib/multiPenTracker.ts'
import { BUILTIN_COLORS } from '../src/lib/penColors.ts'
import { DEFAULT_SETTINGS, PenDetector, type ColoredDetection, type SmallCandidate } from '../src/lib/penDetector.ts'
import { DEFAULT_SHAPE } from '../src/lib/penShape.ts'
import { DEFAULT_TRACKING, FAR_HOLD_MS, PenTrackingFilter } from '../src/lib/penTracking.ts'

// OpenCV.js（WASM）を Node で読み込み、ブラウザと同じ検出処理を合成画像で検証する
const require = createRequire(import.meta.url)
type Cv = any
let cv: Cv
let detector: InstanceType<typeof PenDetector>

/** カメラの映像（1280×720）と処理解像度（640×360、STEP 1 からの上限 640） */
const CW = 1280
const CH = 720
const W = 640
const H = 360
const K = W / CW
const BG = [70, 75, 70]
const PINK = [255, 60, 170]
const PINK_COLOR = BUILTIN_COLORS.filter((c) => c.id === 'pink')

/** カメラの映像の座標で描く */
function cameraScene(draw: (img: any) => void): any {
  const img = new cv.Mat(CH, CW, cv.CV_8UC4, new cv.Scalar(...BG, 255))
  draw(img)
  return img
}
function bar(img: any, cx: number, cy: number, L: number, T: number, deg: number, rgb: number[]) {
  const r = (deg * Math.PI) / 180
  const ux = Math.cos(r)
  const uy = Math.sin(r)
  const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [cx + (ux * a * L) / 2 - (uy * b * T) / 2, cy + (uy * a * L) / 2 + (ux * b * T) / 2])
  const p = cv.matFromArray(4, 1, cv.CV_32SC2, pts.flat().map(Math.round))
  const v = new cv.MatVector()
  v.push_back(p)
  cv.fillPoly(img, v, new cv.Scalar(...rgb, 255), cv.LINE_AA)
  p.delete()
  v.delete()
}
const toImageData = (m: any): ImageData => ({ width: m.cols, height: m.rows, data: new Uint8ClampedArray(m.data) }) as unknown as ImageData

/** 処理解像度の画像（ブラウザの drawImage の縮小に相当） */
function frameOf(cam: any): ImageData {
  const out = new cv.Mat()
  cv.resize(cam, out, new cv.Size(W, H), 0, 0, cv.INTER_AREA)
  const d = toImageData(out)
  out.delete()
  return d
}
/** ROI の画像：カメラの映像から ROI の範囲を切り出して ROI_IMAGE_SIZE 四方にする（PenTracker の canvas と同じ。ミラーなし） */
function roiImageOf(cam: any, roi: Roi): ImageData {
  const src = roiSourceRect(roi, W, K, false)
  const rect = new cv.Rect(Math.round(src.sx), Math.round(src.sy), Math.round(src.sw), Math.round(src.sh))
  const crop = cam.roi(rect)
  const out = new cv.Mat()
  cv.resize(crop, out, new cv.Size(ROI_IMAGE_SIZE, ROI_IMAGE_SIZE), 0, 0, cv.INTER_LINEAR)
  const d = toImageData(out)
  crop.delete()
  out.delete()
  return d
}

const OPTIONS = { shape: DEFAULT_SHAPE, hands: null }
function full(frame: ImageData, maxPens = 1): ColoredDetection[] {
  return detector.detectColors(frame, DEFAULT_SETTINGS, PINK_COLOR, maxPens, OPTIONS)
}
/** 遠距離認識モード：全画面 + 顔の ROI */
function withFar(cam: any, faces: RoiFace[], maxPens = 1) {
  const frame = frameOf(cam)
  const fullDet = full(frame, maxPens)
  const rois = buildRois({ faces: faces, hands: [] }, W, H, MAX_ROIS[maxPens as 1 | 2 | 3])
  const found = rois.flatMap((roi) => detector.detectInRoi(roiImageOf(cam, roi), roi, W, H, DEFAULT_SETTINGS, PINK_COLOR, maxPens, OPTIONS))
  return { full: fullDet, rois, merged: mergeDetections(fullDet, found, maxPens) }
}

before(async () => {
  const m = require('@techstark/opencv-js')
  cv = m instanceof Promise ? await m : m
  detector = new PenDetector(cv)
})
after(() => detector.dispose())

/** 遠くの人：顔の大きさ 28px（処理解像度）。口元は (cx, cy) */
const farFace = (cx: number, cy: number): RoiFace => ({ center: { x: cx, y: cy }, faceScale: 28 })

describe('遠距離認識モード（ROI）', () => {
  it('遠距離で失敗していた原因：小さく写ったペン（処理解像度で 30×3px）は全画面の検出では見つからない', () => {
    const cam = cameraScene((i) => bar(i, 640, 400, 60, 6, 20, PINK))
    assert.equal(full(frameOf(cam)).length, 0)
  })

  it('1. 近距離のペンは従来どおり全画面で検出し、遠距離認識モードでも結果は同じ', () => {
    const cam = cameraScene((i) => bar(i, 640, 360, 400, 32, 25, PINK))
    const before = full(frameOf(cam))
    // 近い（大きい）顔では ROI を作らない
    const r = withFar(cam, [{ center: { x: 320, y: 150 }, faceScale: 120 }])
    cam.delete()
    assert.equal(before.length, 1)
    assert.equal(r.rois.length, 0)
    assert.equal(r.merged.length, 1)
    assert.deepEqual(r.merged[0].pen, before[0].pen)
    assert.equal(r.merged[0].source, 'full')
  })

  it('2. 小さく写ったペンも、顔の近くの ROI で条件を満たせば検出する（座標は処理解像度）', () => {
    const cam = cameraScene((i) => bar(i, 640, 400, 60, 6, 20, PINK))
    const r = withFar(cam, [farFace(320, 190)])
    cam.delete()
    assert.equal(r.full.length, 0)
    assert.equal(r.merged.length, 1)
    const d = r.merged[0]
    assert.equal(d.source, 'roi')
    assert.ok(Math.hypot(d.pen.center.x - 320, d.pen.center.y - 200) < 2, `中心 ${JSON.stringify(d.pen.center)}`)
    assert.ok(Math.abs(d.pen.angleDeg - 20) < 4, `角度 ${d.pen.angleDeg}`)
    assert.ok(Math.abs(d.pen.length - 30) < 4, `長さ ${d.pen.length}`)
    assert.equal(d.pen.frameWidth, W)
    assert.ok(d.score!.total >= 0.6)
  })

  it('2b. 指で 2 つに分かれた小さいペンも 1 本として検出する', () => {
    const cam = cameraScene((i) => {
      bar(i, 640, 400, 60, 6, 0, PINK)
      bar(i, 645, 400, 7, 14, 0, [225, 175, 145])
    })
    const r = withFar(cam, [farFace(320, 190)])
    cam.delete()
    assert.equal(r.merged.length, 1)
    assert.ok(Math.abs(r.merged[0].pen.length - 30) < 4, `長さ ${r.merged[0].pen.length}`)
    assert.equal(r.merged[0].pen.segments.length, 2)
  })

  it('3. ROI の中の背景の色の領域（塊・ROI の外へ続く帯・点の集まり）は誤検出しない', () => {
    const cam = cameraScene((i) => {
      // 太い塊（服の柄など）
      bar(i, 600, 380, 40, 30, 0, PINK)
      // ROI の外へ続く帯（服の縁・壁の線）
      bar(i, 640, 470, 900, 6, 0, PINK)
      // 途切れ途切れの破線（2 本の短い線。見えている部分が少ない）
      bar(i, 560, 330, 12, 5, 0, PINK)
      bar(i, 590, 330, 12, 5, 0, PINK)
      // 小さな点の集まり
      for (let k = 0; k < 8; k++) bar(i, 700 + (k % 4) * 9, 330 + Math.floor(k / 4) * 9, 4, 4, 0, PINK)
    })
    const r = withFar(cam, [farFace(320, 190)])
    cam.delete()
    assert.equal(r.merged.filter((d) => d.source === 'roi').length, 0, JSON.stringify(r.merged.map((d) => [d.pen.center, d.pen.length, d.pen.thickness])))
  })

  it('4. 複数の小さいペン（2 人モード：2 人の顔の近く）をそれぞれ検出する', () => {
    const cam = cameraScene((i) => {
      bar(i, 360, 400, 60, 6, 15, PINK)
      bar(i, 920, 400, 60, 6, 160, PINK)
    })
    const r = withFar(cam, [farFace(180, 190), farFace(460, 190)], 2)
    cam.delete()
    assert.equal(r.merged.length, 2)
    const xs = r.merged.map((d) => d.pen.center.x).sort((a, b) => a - b)
    assert.ok(Math.abs(xs[0] - 180) < 3 && Math.abs(xs[1] - 460) < 3, `${xs}`)
  })

  it('4b. 同じペンが重なる 2 つの ROI で見つかっても 1 本にまとめる', () => {
    const cam = cameraScene((i) => bar(i, 640, 400, 60, 6, 20, PINK))
    const frame = frameOf(cam)
    const a: Roi = { x: 260, y: 140, size: 120, kind: 'face' }
    const b: Roi = { x: 280, y: 150, size: 120, kind: 'hand' }
    const found = [a, b].flatMap((roi) => detector.detectInRoi(roiImageOf(cam, roi), roi, W, H, DEFAULT_SETTINGS, PINK_COLOR, 2, OPTIONS))
    cam.delete()
    assert.equal(found.length, 2)
    assert.equal(mergeDetections(full(frame, 2), found, 2).length, 1)
  })

  it('5. ROI の外（顔・手から離れた位置）の小さい物は、従来どおり検出しない', () => {
    const cam = cameraScene((i) => bar(i, 1150, 120, 60, 6, 20, PINK))
    const r = withFar(cam, [farFace(320, 190)])
    cam.delete()
    assert.equal(r.merged.length, 0)
    // 顔・手が無ければ ROI は作らない（全画面の検出だけ）
    assert.equal(buildRois({ faces: [], hands: [] }, W, H, 2).length, 0)
  })

  it('ROI の大きさは顔の大きさに合わせ、顔が小さくても下限より小さくならない。重なる ROI はまとめる', () => {
    const [tiny] = buildRois({ faces: [{ center: { x: 320, y: 180 }, faceScale: 10 }], hands: [] }, W, H, 2)
    assert.equal(tiny.size, FAR_ROI.minSize)
    const [mid] = buildRois({ faces: [{ center: { x: 320, y: 180 }, faceScale: 40 }], hands: [] }, W, H, 2)
    assert.equal(mid.size, 40 * FAR_ROI.faceScale)
    const merged = buildRois({ faces: [farFace(320, 180)], hands: [{ landmarks: [{ x: 310, y: 200 }, { x: 330, y: 230 }], scale: 30 }] }, W, H, 2)
    assert.equal(merged.length, 1)
    // 画面の外にはみ出さない
    const [edge] = buildRois({ faces: [farFace(5, 5)], hands: [] }, W, H, 2)
    assert.ok(edge.x >= 0 && edge.y >= 0)
  })

  it('6. 検出座標と CG の描画座標が一致する（ミラーの切り出しも同じ向き）', () => {
    const cam = cameraScene((i) => bar(i, 640, 400, 60, 6, 20, PINK))
    const r = withFar(cam, [farFace(320, 190)])
    cam.delete()
    const pen = new PenTrackingFilter().update(r.merged[0].pen, 0, DEFAULT_TRACKING)!
    const placement = placeCigarette(pen, DEFAULT_CIGARETTE)
    assert.ok(Math.hypot(placement.center.x - r.merged[0].pen.center.x, placement.center.y - r.merged[0].pen.center.y) < 1e-6)
    // ミラー：処理解像度（ミラー後）の ROI は、カメラの映像の左右反転した位置から切り出す
    const roi: Roi = { x: 100, y: 50, size: 120, kind: 'face' }
    const m = roiSourceRect(roi, W, K, true)
    assert.equal(m.sx, (W - 100 - 120) / K)
    assert.equal(m.sw, 120 / K)
    assert.equal(m.flip, true)
    assert.equal(roiSourceRect(roi, W, K, false).sx, 100 / K)
  })
})

describe('遠距離認識モード（顔が見つからないとき：小さい色の候補・見失ったペンの ROI）', () => {
  /** PenTracker と同じ流れ：全画面の検出で小さい候補を集め、候補の ROI を高解像度で確かめる */
  function fromCandidates(cam: any, maxPens = 1) {
    const frame = frameOf(cam)
    const small: SmallCandidate[] = []
    const fullDet = detector.detectColors(frame, DEFAULT_SETTINGS, PINK_COLOR, maxPens, { ...OPTIONS, smallCandidates: small })
    const rois = buildRois({ faces: [], hands: [], candidates: small, found: fullDet.map((d) => d.pen) }, W, H, MAX_ROIS[maxPens as 1 | 2 | 3])
    const found = rois.flatMap((roi) => detector.detectInRoi(roiImageOf(cam, roi), roi, W, H, DEFAULT_SETTINGS, PINK_COLOR, maxPens, OPTIONS))
    return { full: fullDet, small, rois, merged: mergeDetections(fullDet, found, maxPens) }
  }

  it('顔が小さすぎて MediaPipe で見つからなくても、小さく細長い色の候補の ROI で遠くのペンを検出する', () => {
    const cam = cameraScene((i) => bar(i, 640, 400, 60, 6, 20, PINK))
    const r = fromCandidates(cam)
    cam.delete()
    assert.ok(r.small.length >= 1)
    assert.equal(r.rois[0].kind, 'candidate')
    assert.equal(r.merged.length, 1)
    assert.ok(Math.hypot(r.merged[0].pen.center.x - 320, r.merged[0].pen.center.y - 200) < 2)
  })

  it('小さい候補を集めても、全画面の検出の結果は変わらない（ノイズ除去の前のマスクを読むだけ）', () => {
    const cam = cameraScene((i) => {
      bar(i, 500, 360, 400, 32, 25, PINK)
      bar(i, 1100, 150, 60, 6, 20, PINK)
    })
    const frame = frameOf(cam)
    const plain = full(frame)
    const r = fromCandidates(cam)
    cam.delete()
    assert.deepEqual(r.full.map((d) => d.pen), plain.map((d) => d.pen))
  })

  it('近距離のペンを全画面で見つけたときは、その近くに ROI を作らない（近距離では追加の処理をしない）', () => {
    const cam = cameraScene((i) => bar(i, 640, 360, 400, 32, 25, PINK))
    const r = fromCandidates(cam)
    cam.delete()
    assert.equal(r.full.length, 1)
    assert.equal(r.rois.length, 0)
    // 顔の ROI も、その中に見つけたペンがあれば作らない
    assert.equal(buildRois({ faces: [farFace(320, 150)], hands: [], found: r.full.map((d) => d.pen) }, W, H, 2).length, 0)
  })

  it('色の候補でも、太い塊・点の並び・ROI の外へ続く帯はペンにしない', () => {
    const cam = cameraScene((i) => {
      bar(i, 300, 200, 40, 30, 0, PINK)
      bar(i, 640, 600, 1400, 6, 0, PINK)
      for (let k = 0; k < 6; k++) bar(i, 900 + k * 9, 300, 4, 4, 0, PINK)
    })
    const r = fromCandidates(cam, 3)
    cam.delete()
    assert.equal(r.merged.filter((d) => d.source === 'roi').length, 0, JSON.stringify(r.rois))
  })

  it('色の候補の ROI で何も見つからなかった場所は、一定時間 ROI にしない（背景で毎フレーム処理しない）', () => {
    const memory = new CandidateMemory()
    const c = [{ center: { x: 300, y: 200 }, length: 20 }, { center: { x: 500, y: 100 }, length: 20 }]
    memory.miss({ x: 240, y: 140, size: 120, kind: 'candidate' }, 0)
    assert.deepEqual(memory.filter(c, 100), [c[1]])
    assert.deepEqual(memory.filter(c, CANDIDATE_RETRY_MS + 1), c)
  })

  it('見失った直後のペンの位置に ROI を作る', () => {
    const rois = buildRois({ faces: [], hands: [], tracked: [{ center: { x: 400, y: 200 }, length: 30 }] }, W, H, 2)
    assert.equal(rois.length, 1)
    assert.equal(rois[0].kind, 'track')
    assert.ok(rois[0].x <= 400 && rois[0].x + rois[0].size >= 400)
  })
})

describe('遠距離認識モードの追跡', () => {
  const det = (x: number) => {
    const cam = cameraScene((i) => bar(i, x / K, 400, 60, 6, 20, PINK))
    const r = withFar(cam, [farFace(x, 190)])
    cam.delete()
    return r.merged[0].pen
  }

  it('7. 一時的に見失っても CG をすぐ消さず、直前の動きから予測した位置に出す（予測は検出と区別する）', () => {
    const filter = new PenTrackingFilter()
    const tracking = { ...DEFAULT_TRACKING, holdMs: FAR_HOLD_MS, predictHeld: true }
    let t = 0
    let out
    for (let i = 0; i < 6; i++) out = filter.update(det(300 + i * 4), (t += 33), tracking)
    assert.equal(out!.status, 'measured')
    assert.equal(out!.predicted, false)
    const lastX = out!.center.x
    const held = filter.update(null, t + 150, tracking)!
    assert.equal(held.status, 'held')
    assert.equal(held.predicted, true)
    assert.ok(held.center.x > lastX, '動いていた向きへ進める')
    assert.ok(held.center.x - lastX < 30, '大きく飛ばない')
    assert.ok(filter.update(null, t + FAR_HOLD_MS - 10, tracking), '保持時間内は残る')
    assert.equal(filter.update(null, t + FAR_HOLD_MS + 50, tracking), null, '保持時間を過ぎたら消す')
    // 遠距離認識モードでなければ従来どおり 300ms で消え、予測しない
    const normal = new PenTrackingFilter()
    for (let i = 0; i < 6; i++) normal.update(det(300 + i * 4), i * 33, DEFAULT_TRACKING)
    const h = normal.update(null, 5 * 33 + 150, DEFAULT_TRACKING)!
    assert.equal(h.predicted, false)
    assert.equal(normal.update(null, 5 * 33 + 350, DEFAULT_TRACKING), null)
  })

  it('7b. 再検出したときに大きくジャンプしない（追跡 ID を保ち、平滑化して戻る）', () => {
    const tracker = new MultiPenTracker()
    const tracking = { ...DEFAULT_TRACKING, holdMs: FAR_HOLD_MS, predictHeld: true }
    let t = 0
    let pens = tracker.update([det(300)], (t += 33), tracking, 1)
    const id = pens[0].id
    for (let i = 0; i < 5; i++) pens = tracker.update([], (t += 33), tracking, 1)
    assert.equal(pens[0].status, 'held')
    pens = tracker.update([det(306)], (t += 33), tracking, 1)
    assert.equal(pens[0].id, id)
    assert.equal(pens[0].status, 'measured')
    assert.ok(Math.abs(pens[0].center.x - 303) < 4)
  })

  it('8. 予測で表示している間はシケモクの燃焼時間を進めず、画面の中央なので退出にもならない', () => {
    const life = new CigaretteLifeManager()
    life.forceButt('1')
    const ends: [{ x: number; y: number }, { x: number; y: number }] = [{ x: 290, y: 200 }, { x: 320, y: 210 }]
    let t = 0
    life.update((t += 33), W, H, [{ key: '1', ends, measured: true, lit: false }], 0)
    for (let i = 0; i < 18; i++) life.update((t += 33), W, H, [{ key: '1', ends, measured: false, lit: false }], 0)
    for (let i = 0; i < 40; i++) life.update((t += 33), W, H, [], 0)
    life.update((t += 33), W, H, [{ key: '1', ends, measured: true, lit: false }], 0)
    assert.equal(life.state('1'), 'BUTT')
  })

  it('9. カメラの切り替え（追跡のリセット）の後も、新しい映像の ROI で正常に検出・追跡できる', () => {
    const tracker = new MultiPenTracker()
    const tracking = { ...DEFAULT_TRACKING, holdMs: FAR_HOLD_MS, predictHeld: true }
    tracker.update([det(300)], 33, tracking, 1)
    tracker.reset()
    // 切り替えの後：古い位置は残らない
    assert.equal(tracker.update([], 66, tracking, 1).length, 0)
    const pens = tracker.update([det(200)], 99, tracking, 1)
    assert.equal(pens.length, 1)
    assert.ok(Math.abs(pens[0].center.x - 200) < 3)
    assert.equal(pens[0].predicted, false)
  })
})
