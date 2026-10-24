import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, before, describe, it } from 'node:test'
import { MultiPenTracker } from '../src/lib/multiPenTracker.ts'
import { DEFAULT_SETTINGS, PenDetector } from '../src/lib/penDetector.ts'
import { penFromAxis, type PenDetection } from '../src/lib/penGeometry.ts'
import { DEFAULT_TRACKING } from '../src/lib/penTracking.ts'

// OpenCV.js（WASM）を Node で読み込み、ブラウザと同じ検出処理を合成画像で検証する
const require = createRequire(import.meta.url)
type Cv = any
let cv: Cv
let detector: InstanceType<typeof PenDetector>

const W = 640
const H = 360
const PINK = [255, 60, 170]
const SKIN = [200, 160, 130]
const BG = [40, 90, 40]

type Bar = { cx: number; cy: number; L: number; T: number; deg: number; rgb?: number[] }

function scene(bars: Bar[]): ImageData {
  const img = new cv.Mat(H, W, cv.CV_8UC4, new cv.Scalar(...BG, 255))
  for (const s of bars) {
    const r = (s.deg * Math.PI) / 180
    const ux = Math.cos(r)
    const uy = Math.sin(r)
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].flatMap(([a, b]) => [
      Math.round(s.cx + (ux * a * s.L) / 2 - (uy * b * s.T) / 2),
      Math.round(s.cy + (uy * a * s.L) / 2 + (ux * b * s.T) / 2),
    ])
    const poly = cv.matFromArray(4, 1, cv.CV_32SC2, pts)
    const v = new cv.MatVector()
    v.push_back(poly)
    cv.fillPoly(img, v, new cv.Scalar(...(s.rgb ?? PINK), 255))
    poly.delete()
    v.delete()
  }
  const data = { width: W, height: H, data: new Uint8ClampedArray(img.data) }
  img.delete()
  return data as unknown as ImageData
}

before(async () => {
  const m = require('@techstark/opencv-js')
  cv = m instanceof Promise ? await m : m
  detector = new PenDetector(cv)
})
after(() => detector.dispose())

const near = (a: { x: number; y: number }, b: { x: number; y: number }, tol: number) =>
  Math.hypot(a.x - b.x, a.y - b.y) <= tol

describe('PenDetector.detectAll（複数ペン）', () => {
  it('離れた 2 本のピンクのペンを別々に検出し、位置・角度・長さ・太さを返す', () => {
    const pens = detector.detectAll(
      scene([
        { cx: 160, cy: 180, L: 180, T: 14, deg: 20 },
        { cx: 470, cy: 170, L: 160, T: 12, deg: 150 },
      ]),
      DEFAULT_SETTINGS,
      2,
    )
    assert.equal(pens.length, 2)
    const left = pens.find((p) => p.center.x < 320)!
    const right = pens.find((p) => p.center.x > 320)!
    assert.ok(near(left.center, { x: 160, y: 180 }, 4))
    assert.ok(near(right.center, { x: 470, y: 170 }, 4))
    assert.ok(Math.abs(left.angleDeg - 20) < 3, `${left.angleDeg}`)
    assert.ok(Math.abs(right.angleDeg - 150) < 3, `${right.angleDeg}`)
    assert.ok(Math.abs(left.length - 180) < 8 && Math.abs(left.thickness - 14) < 4)
    assert.ok(Math.abs(right.length - 160) < 8 && Math.abs(right.thickness - 12) < 4)
  })

  it('指で分断されたペンは 1 本に結合し、もう 1 本のペンとは結合しない', () => {
    const pens = detector.detectAll(
      scene([
        { cx: 160, cy: 180, L: 200, T: 14, deg: 0 },
        { cx: 150, cy: 180, L: 26, T: 40, deg: 0, rgb: SKIN }, // 指
        { cx: 450, cy: 200, L: 170, T: 14, deg: 80 },
      ]),
      DEFAULT_SETTINGS,
      2,
    )
    assert.equal(pens.length, 2)
    const split = pens.find((p) => p.center.x < 320)!
    assert.equal(split.segments.length, 2, '分断された 2 片を結合')
    assert.ok(Math.abs(split.length - 200) < 8, `${split.length}`)
    assert.equal(pens.find((p) => p.center.x > 320)!.segments.length, 1)
  })

  it('同一直線上で端を向け合った別々の 2 本は、複数ペン検出では 1 本に結合しない', () => {
    const shapes: Bar[] = [
      { cx: 190, cy: 180, L: 200, T: 14, deg: 0 },
      { cx: 420, cy: 180, L: 200, T: 14, deg: 0 }, // すき間 30px（太さの約 2 倍）
    ]
    const multi = detector.detectAll(scene(shapes), DEFAULT_SETTINGS, 2)
    assert.equal(multi.length, 2)
    assert.ok(multi.every((p) => p.length < 220), multi.map((p) => p.length).join(','))
    // 参考：1 本検出（従来）は指による分断と区別できず 1 本に結合する（従来の挙動を変えていないことの確認）
    const single = detector.detect(scene(shapes), DEFAULT_SETTINGS)
    assert.ok(single && single.length > 400)
  })

  it('maxPens = 1 は従来の detect と同じ結果', () => {
    const scenes = [
      scene([{ cx: 200, cy: 150, L: 180, T: 14, deg: 30 }, { cx: 450, cy: 200, L: 120, T: 12, deg: 100 }]),
      scene([{ cx: 300, cy: 180, L: 200, T: 14, deg: 0 }, { cx: 290, cy: 180, L: 26, T: 40, deg: 0, rgb: SKIN }]),
      scene([]),
    ]
    for (const img of scenes) {
      const one = detector.detect(img, DEFAULT_SETTINGS)
      const all = detector.detectAll(img, DEFAULT_SETTINGS, 1)
      assert.deepEqual(all, one ? [one] : [])
    }
  })

  it('3 本まで検出でき、上限を超える分は面積の小さいものを捨てる', () => {
    const img = scene([
      { cx: 110, cy: 180, L: 200, T: 16, deg: 90 },
      { cx: 320, cy: 180, L: 180, T: 14, deg: 90 },
      { cx: 530, cy: 180, L: 120, T: 12, deg: 90 },
    ])
    assert.equal(detector.detectAll(img, DEFAULT_SETTINGS, 3).length, 3)
    const two = detector.detectAll(img, DEFAULT_SETTINGS, 2)
    assert.equal(two.length, 2)
    assert.ok(two.every((p) => p.center.x < 420), '最も小さい右のペンを捨てる')
  })
})

function pen(cx: number, cy: number, deg = 0, length = 150): PenDetection {
  const r = (deg * Math.PI) / 180
  return penFromAxis({ center: { x: cx, y: cy }, u: { x: Math.cos(r), y: Math.sin(r) }, length, thickness: 12, area: length * 12, segments: [], frameWidth: 640, frameHeight: 480 })
}

describe('MultiPenTracker（ペンの追跡 ID）', () => {
  it('検出結果の順番が入れ替わっても、ペンごとの ID を維持する', () => {
    const tracker = new MultiPenTracker()
    let ids: Record<string, number> = {}
    for (let i = 0; i < 20; i++) {
      const a = pen(150 + i * 3, 200)
      const b = pen(450 - i * 3, 220, 90)
      const out = tracker.update(i % 2 ? [a, b] : [b, a], i * 33, DEFAULT_TRACKING, 2)
      assert.equal(out.length, 2)
      const left = out.find((p) => p.center.x < 320)!
      const right = out.find((p) => p.center.x > 320)!
      if (i === 0) ids = { left: left.id, right: right.id }
      assert.equal(left.id, ids.left)
      assert.equal(right.id, ids.right)
    }
    assert.notEqual(ids.left, ids.right)
  })

  it('近くに並んだ 2 本でも、コストの小さい組から対応付けて ID を取り違えない', () => {
    const tracker = new MultiPenTracker()
    let ids: { top: number; bottom: number } | null = null
    for (let i = 0; i < 12; i++) {
      // 40px 間隔で平行に並んだ 2 本（お互いが対応付けのゲート内に入る距離）
      const top = pen(300 + i * 4, 200)
      const bottom = pen(300 - i * 4, 240)
      const out = tracker.update(i % 2 ? [top, bottom] : [bottom, top], i * 33, DEFAULT_TRACKING, 2)
      const t = out.find((p) => p.center.y < 220)!
      const b = out.find((p) => p.center.y > 220)!
      if (!ids) ids = { top: t.id, bottom: b.id }
      assert.equal(t.id, ids.top, `frame ${i}`)
      assert.equal(b.id, ids.bottom, `frame ${i}`)
    }
  })

  it('1 本を見失っても、もう 1 本の ID と追跡は影響を受けず、見失ったペンは保持時間の後に破棄する', () => {
    const tracker = new MultiPenTracker()
    tracker.update([pen(150, 200), pen(450, 200, 90)], 0, DEFAULT_TRACKING, 2)
    const first = tracker.update([pen(150, 200), pen(450, 200, 90)], 33, DEFAULT_TRACKING, 2)
    const rightId = first.find((p) => p.center.x > 320)!.id
    const held = tracker.update([pen(450, 200, 90)], 66, DEFAULT_TRACKING, 2)
    assert.equal(held.length, 2)
    assert.equal(held.find((p) => p.center.x < 320)!.status, 'held')
    const gone = tracker.update([pen(450, 200, 90)], 66 + DEFAULT_TRACKING.holdMs + 50, DEFAULT_TRACKING, 2)
    assert.equal(gone.length, 1)
    assert.equal(gone[0].id, rightId)
    assert.equal(gone[0].status, 'measured')
  })

  it('離れた位置に新しいペンが現れたら新しい ID を振る（ID は再利用しない）', () => {
    const tracker = new MultiPenTracker()
    const [a] = tracker.update([pen(150, 200)], 0, DEFAULT_TRACKING, 2)
    const both = tracker.update([pen(150, 200), pen(500, 300)], 33, DEFAULT_TRACKING, 2)
    const b = both.find((p) => p.id !== a.id)!
    assert.ok(b.id > a.id)
  })

  it('1 本モードでは大きく移動しても同じペン（ID）として追跡する（従来の単独追跡と同じ）', () => {
    const tracker = new MultiPenTracker()
    const [a] = tracker.update([pen(100, 100)], 0, DEFAULT_TRACKING, 1)
    const [b] = tracker.update([pen(500, 400, 70)], 33, DEFAULT_TRACKING, 1)
    assert.equal(a.id, b.id)
    assert.ok(near(b.center, { x: 500, y: 400 }, 1), '飛んだときは平滑化せずに追従')
  })
})
