import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, before, describe, it } from 'node:test'
import {
  DEFAULT_LIGHTER,
  LighterDetector,
  isLighterRectangle,
  lighterNozzle,
  type RectCandidate,
} from '../src/lib/lighterDetector.ts'
import { DEFAULT_SETTINGS, PenDetector } from '../src/lib/penDetector.ts'

// OpenCV.js（WASM）を Node で読み込む。ブラウザと同じ処理を合成画像で検証する
const require = createRequire(import.meta.url)
type Cv = any
let cv: Cv
let pen: InstanceType<typeof PenDetector>
let lighter: InstanceType<typeof LighterDetector>

const W = 640
const H = 360
const PINK = [255, 60, 170]
const BLUE = [30, 90, 230]
const BG = [40, 90, 40]

type Shape = { cx: number; cy: number; L: number; T: number; deg: number; rgb: number[] } | { circle: true; cx: number; cy: number; r: number; rgb: number[] }

function scene(shapes: Shape[]) {
  const img = new cv.Mat(H, W, cv.CV_8UC4, new cv.Scalar(...BG, 255))
  for (const s of shapes) {
    if ('circle' in s) {
      cv.circle(img, new cv.Point(s.cx, s.cy), s.r, new cv.Scalar(...s.rgb, 255), -1)
      continue
    }
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
    cv.fillPoly(img, v, new cv.Scalar(...s.rgb, 255))
    poly.delete()
    v.delete()
  }
  const data = { width: W, height: H, data: new Uint8ClampedArray(img.data) }
  img.delete()
  return data as unknown as ImageData
}

function detectBoth(shapes: Shape[]) {
  const penResult = pen.detect(scene(shapes), DEFAULT_SETTINGS)
  const lighterResult = lighter.detect(pen.hsv!, pen.mask, DEFAULT_LIGHTER)
  return { penResult, lighterResult }
}

before(async () => {
  const m = require('@techstark/opencv-js')
  cv = m instanceof Promise ? await m : m
  pen = new PenDetector(cv)
  lighter = new LighterDetector(cv)
})
after(() => {
  pen.dispose()
  lighter.dispose()
})

describe('isLighterRectangle', () => {
  const base: RectCandidate = { area: 4000, vertices: 4, convex: true, cx: 0, cy: 0, w: 100, h: 42, angle: 0 }
  it('4 頂点・凸・矩形をほぼ埋める・縦横比が範囲内なら長方形', () => {
    assert.equal(isLighterRectangle(base, DEFAULT_LIGHTER), true)
  })
  it('頂点数・凸性・充填率・縦横比・面積のどれかが外れたら長方形ではない', () => {
    for (const bad of [
      { vertices: 6 },
      { convex: false },
      { area: 2500 },
      { w: 100, h: 95 },
      { w: 300, h: 40, area: 11000 },
      { area: 500, w: 30, h: 17 },
    ]) {
      assert.equal(isLighterRectangle({ ...base, ...bad }, DEFAULT_LIGHTER), false, JSON.stringify(bad))
    }
  })
})

describe('lighterNozzle', () => {
  it('画面上で上にある端を火口にする（ライターの向きが逆でも上側）', () => {
    const d = { center: { x: 100, y: 100 }, length: 80, endpoints: [{ x: 100, y: 140 }, { x: 100, y: 60 }] as [{ x: number; y: number }, { x: number; y: number }] }
    const { nozzle, flameBase, up } = lighterNozzle(d)
    assert.deepEqual(nozzle, { x: 100, y: 60 })
    assert.ok(flameBase.y < nozzle.y)
    assert.ok(up.y < -0.99)
  })
})

describe('LighterDetector（OpenCV、合成画像）', () => {
  it('青い長方形の中心・角度・長辺・短辺を検出する（回転しても追従）', () => {
    for (const deg of [0, 30, 80, 135]) {
      const { lighterResult: d } = detectBoth([{ cx: 400, cy: 200, L: 110, T: 44, deg, rgb: BLUE }])
      assert.ok(d, `deg=${deg}`)
      assert.ok(Math.abs(d.center.x - 400) < 3 && Math.abs(d.center.y - 200) < 3, `center deg=${deg}`)
      assert.ok(Math.abs(d.length - 110) < 6 && Math.abs(d.thickness - 44) < 6, `size deg=${deg}`)
      const diff = Math.abs(d.angleDeg - deg) % 180
      assert.ok(Math.min(diff, 180 - diff) < 2, `angle deg=${deg} got ${d.angleDeg}`)
    }
  })

  it('円や細長すぎる帯は長方形として扱わない', () => {
    assert.equal(detectBoth([{ circle: true, cx: 300, cy: 180, r: 50, rgb: BLUE }]).lighterResult, null)
    assert.equal(detectBoth([{ cx: 300, cy: 180, L: 400, T: 30, deg: 10, rgb: BLUE }]).lighterResult, null)
  })

  it('ピンクのペンはライターとして検出しない', () => {
    const { penResult, lighterResult } = detectBoth([{ cx: 300, cy: 180, L: 200, T: 60, deg: 20, rgb: PINK }])
    assert.ok(penResult)
    assert.equal(lighterResult, null)
  })

  it('ライターが近くにあってもペンの検出結果は変わらない', () => {
    const penShape: Shape = { cx: 250, cy: 180, L: 200, T: 24, deg: 30, rgb: PINK }
    const alone = pen.detect(scene([penShape]), DEFAULT_SETTINGS)!
    const { penResult: withLighter, lighterResult } = detectBoth([penShape, { cx: 480, cy: 200, L: 110, T: 44, deg: 75, rgb: BLUE }])
    assert.ok(lighterResult)
    assert.ok(withLighter)
    assert.ok(Math.abs(withLighter.center.x - alone.center.x) < 1e-6)
    assert.ok(Math.abs(withLighter.length - alone.length) < 1e-6)
    assert.ok(Math.abs(withLighter.angleDeg - alone.angleDeg) < 1e-6)
  })
})
