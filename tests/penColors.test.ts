import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { before, describe, it } from 'node:test'
import {
  BUILTIN_COLORS,
  DEFAULT_COLOR_SETTINGS,
  activeColors,
  clientToCanvas,
  estimateColor,
  parseColorSettings,
  rgbToHsv,
} from '../src/lib/penColors.ts'

const require = createRequire(import.meta.url)
let cv: any
before(async () => {
  const m = require('@techstark/opencv-js')
  cv = m instanceof Promise ? await m : m
})

/** 幅 w・高さ h の RGBA 画像を、画素ごとの色関数で作る */
function image(w: number, h: number, color: (x: number, y: number) => number[]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = color(x, y)
      data.set([r, g, b, 255], (y * w + x) * 4)
    }
  }
  return data
}
// 再現可能なノイズ
let seed = 11
const noise = (amp: number) => {
  seed = (seed * 16807) % 2147483647
  return Math.round(((seed / 2147483647) * 2 - 1) * amp)
}
const inRange = (h: number, s: number, v: number, r: { hMin: number; hMax: number; sMin: number; sMax: number; vMin: number; vMax: number }) =>
  (r.hMin <= r.hMax ? h >= r.hMin && h <= r.hMax : h >= r.hMin || h <= r.hMax) && s >= r.sMin && s <= r.sMax && v >= r.vMin && v <= r.vMax

describe('rgbToHsv', () => {
  it('OpenCV の COLOR_RGB2HSV と同じ値（±1）になる', () => {
    const colors: number[][] = []
    for (let i = 0; i < 300; i++) colors.push([noise(127) + 128, noise(127) + 128, noise(127) + 128])
    colors.push([255, 0, 0], [0, 0, 0], [255, 255, 255], [255, 60, 170], [220, 30, 40])
    const src = cv.matFromArray(1, colors.length, cv.CV_8UC3, colors.flat())
    const dst = new cv.Mat()
    cv.cvtColor(src, dst, cv.COLOR_RGB2HSV)
    colors.forEach(([r, g, b], i) => {
      const mine = rgbToHsv(r, g, b)
      const [h, s, v] = [dst.data[i * 3], dst.data[i * 3 + 1], dst.data[i * 3 + 2]]
      const dh = Math.min(Math.abs(mine.h - h), 180 - Math.abs(mine.h - h))
      assert.ok(dh <= 1 && Math.abs(mine.s - s) <= 1 && mine.v === v, `${[r, g, b]}: ${JSON.stringify(mine)} vs ${[h, s, v]}`)
    })
    src.delete()
    dst.delete()
  })
})

describe('estimateColor（タップした位置の色の推定）', () => {
  it('ノイズのある黄色のペンから、中央値で色相を推定し、その色を含む範囲を返す', () => {
    const data = image(100, 100, () => [240 + noise(10), 200 + noise(15), 30 + noise(15)])
    const e = estimateColor(data, 100, 100, { x: 50, y: 50 }, 6)!
    const truth = rgbToHsv(240, 200, 30)
    assert.ok(Math.abs(e.h - truth.h) <= 2, `${e.h} vs ${truth.h}`)
    assert.equal(e.achromatic, false)
    assert.ok(e.samples > 100)
    // 推定した範囲に、元の画素の大部分が入る
    let inside = 0
    for (let i = 0; i < data.length; i += 4) {
      const hsv = rgbToHsv(data[i], data[i + 1], data[i + 2])
      if (inRange(hsv.h, hsv.s, hsv.v, e.range)) inside++
    }
    assert.ok(inside / (data.length / 4) > 0.97, `${inside}`)
  })

  it('赤（色相 0/179 の両側の画素が混ざる）でも中央値が 0 付近になり、範囲が折り返す', () => {
    const data = image(40, 40, (x) => (x % 2 ? [220, 30, 40] : [220, 40, 25])) // H 178 と H 2
    const e = estimateColor(data, 40, 40, { x: 20, y: 20 }, 6)!
    assert.ok(e.h >= 178 || e.h <= 2, `${e.h}`)
    assert.ok(e.range.hMin > e.range.hMax, '範囲が 0/179 をまたぐ')
    assert.ok(inRange(178, 220, 220, e.range) && inRange(2, 220, 220, e.range))
  })

  it('周辺の一部が背景でも、中央値なので外れ値に引っ張られない', () => {
    // 中央の縦 8px の帯だけがペン（青）、それ以外は灰色の背景。半径 3 ならほぼペンの画素
    const data = image(60, 60, (x) => (Math.abs(x - 30) <= 4 ? [30, 90, 230] : [120, 120, 120]))
    const e = estimateColor(data, 60, 60, { x: 30, y: 30 }, 5)!
    assert.ok(Math.abs(e.h - rgbToHsv(30, 90, 230).h) <= 2, `${e.h}`)
  })

  it('白・灰色・黒は「彩度の低い色」として扱い、色相を全域にする', () => {
    for (const rgb of [[245, 245, 245], [128, 128, 128], [20, 20, 20]]) {
      const e = estimateColor(image(20, 20, () => rgb), 20, 20, { x: 10, y: 10 }, 4)!
      assert.equal(e.achromatic, true, `${rgb}`)
      assert.deepEqual([e.range.hMin, e.range.hMax], [0, 179])
      assert.ok(inRange(0, rgbToHsv(rgb[0], rgb[1], rgb[2]).s, rgb[0], e.range))
    }
  })

  it('画面の外はサンプルしない（端をタップしても例外にならない）', () => {
    const e = estimateColor(image(10, 10, () => [255, 0, 0]), 10, 10, { x: 0, y: 0 }, 5)!
    assert.ok(e.samples > 0 && e.samples < 121)
    assert.equal(estimateColor(image(10, 10, () => [255, 0, 0]), 10, 10, { x: -50, y: -50 }, 3), null)
  })
})

describe('clientToCanvas（object-fit: contain の canvas へのタップ）', () => {
  it('左右に余白がある表示で、余白を除いて画素座標に変換する', () => {
    const rect = { left: 10, top: 20, width: 800, height: 300 } // 640×360 を高さ 300 に縮小 → 幅 533.3、左右に余白
    const canvas = { width: 640, height: 360 }
    const offset = (800 - 640 * (300 / 360)) / 2
    assert.deepEqual(clientToCanvas({ x: 10 + offset, y: 20 }, rect, canvas), { x: 0, y: 0 })
    const p = clientToCanvas({ x: 10 + 400, y: 20 + 150 }, rect, canvas)!
    assert.ok(Math.abs(p.x - 320) < 1e-9 && Math.abs(p.y - 180) < 1e-9)
    assert.equal(clientToCanvas({ x: 15, y: 100 }, rect, canvas), null, '余白')
  })
})

describe('色の設定の保存・読み込み', () => {
  it('壊れた値・無い値は既定値（ピンク 1 色）', () => {
    assert.deepEqual(parseColorSettings(null), DEFAULT_COLOR_SETTINGS)
    assert.deepEqual(parseColorSettings('{broken'), DEFAULT_COLOR_SETTINGS)
    assert.deepEqual(activeColors(DEFAULT_COLOR_SETTINGS).map((c) => c.id), ['pink'])
  })

  it('カスタム色と、組み込みの色の範囲の変更を復元する。不正な範囲・id のものは捨てる', () => {
    const saved = {
      mode: 'all',
      selectedId: 'custom-a',
      colors: [
        { ...BUILTIN_COLORS[1], hsv: { ...BUILTIN_COLORS[1].hsv, sMin: 150 } },
        { id: 'custom-a', name: '黄色', hsv: { hMin: 20, hMax: 35, sMin: 80, sMax: 255, vMin: 80, vMax: 255 }, swatch: '#ffd400', achromatic: false, enabled: true },
        { id: 'custom-bad', name: 'x', hsv: { hMin: -5 } },
        { id: 'evil', name: 'x', hsv: { hMin: 0, hMax: 1, sMin: 0, sMax: 1, vMin: 0, vMax: 1 } },
      ],
    }
    const s = parseColorSettings(JSON.stringify(saved))
    assert.equal(s.mode, 'all')
    assert.equal(s.selectedId, 'custom-a')
    assert.deepEqual(s.colors.map((c) => c.id), ['pink', 'blue', 'green', 'red', 'custom-a'])
    assert.equal(s.colors[1].hsv.sMin, 150)
    assert.equal(s.colors[4].builtin, false)
    assert.deepEqual(activeColors(s).map((c) => c.id), ['pink', 'blue', 'green', 'red', 'custom-a'])
  })

  it('選択中の色が無くなっていたらピンクを選ぶ', () => {
    assert.equal(parseColorSettings(JSON.stringify({ mode: 'single', selectedId: 'custom-gone', colors: [] })).selectedId, 'pink')
  })
})
