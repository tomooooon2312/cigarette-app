import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, before, describe, it } from 'node:test'
import { BUILTIN_COLORS, type PenColor } from '../src/lib/penColors.ts'
import { DEFAULT_SETTINGS, PenDetector, type ColoredDetection } from '../src/lib/penDetector.ts'
import { DEFAULT_SHAPE, scorePenShape, type ShapeSettings } from '../src/lib/penShape.ts'

// OpenCV.js（WASM）を Node で読み込み、ブラウザと同じ検出処理を合成画像で検証する
const require = createRequire(import.meta.url)
type Cv = any
let cv: Cv
let detector: InstanceType<typeof PenDetector>

const W = 640
const H = 360
const BG = [70, 75, 70]
const SKIN = [225, 175, 145]
const RGB = {
  pink: [255, 60, 170], // H 163
  blue: [30, 90, 230], // H 111
  green: [30, 180, 60], // H 66
  red: [220, 30, 40], // H 178（0/179 の上側）
  red2: [220, 40, 25], // H 2（0/179 の下側）
  pinkRed: [235, 25, 70], // H 173（ピンクと赤の範囲が重なる色）
}
type Pt = [number, number]

function scene(draw: (img: any) => void): ImageData {
  const img = new cv.Mat(H, W, cv.CV_8UC4, new cv.Scalar(...BG, 255))
  draw(img)
  const data = { width: W, height: H, data: new Uint8ClampedArray(img.data) }
  img.delete()
  return data as unknown as ImageData
}
function poly(img: any, pts: Pt[], rgb: number[]) {
  const p = cv.matFromArray(pts.length, 1, cv.CV_32SC2, pts.flat().map(Math.round))
  const v = new cv.MatVector()
  v.push_back(p)
  cv.fillPoly(img, v, new cv.Scalar(...rgb, 255))
  p.delete()
  v.delete()
}
function bar(img: any, cx: number, cy: number, L: number, T: number, deg: number, rgb: number[]) {
  const r = (deg * Math.PI) / 180
  const ux = Math.cos(r)
  const uy = Math.sin(r)
  poly(
    img,
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [cx + (ux * a * L) / 2 - (uy * b * T) / 2, cy + (uy * a * L) / 2 + (ux * b * T) / 2] as Pt),
    rgb,
  )
}
const SHAPE_OFF: ShapeSettings = { ...DEFAULT_SHAPE, enabled: false }
function detect(img: ImageData, colors: PenColor[] = BUILTIN_COLORS, maxPens = 3, shape = DEFAULT_SHAPE, hands: { points: { x: number; y: number }[]; scale: number }[] | null = null): ColoredDetection[] {
  return detector.detectColors(img, DEFAULT_SETTINGS, colors, maxPens, { shape, hands })
}
const color = (id: string) => BUILTIN_COLORS.find((c) => c.id === id)!
const near = (d: ColoredDetection, x: number, y: number, tol = 4) => Math.hypot(d.pen.center.x - x, d.pen.center.y - y) <= tol

before(async () => {
  const m = require('@techstark/opencv-js')
  cv = m instanceof Promise ? await m : m
  detector = new PenDetector(cv)
})
after(() => detector.dispose())

describe('複数色のペン認識（detectColors）', () => {
  it('ピンク・青・緑・赤の各ペンを、それぞれの色として認識する（全色同時モード）', () => {
    for (const [id, rgb] of [['pink', RGB.pink], ['blue', RGB.blue], ['green', RGB.green], ['red', RGB.red], ['red', RGB.red2]] as const) {
      const r = detect(scene((i) => bar(i, 320, 180, 200, 16, 25, rgb)))
      assert.equal(r.length, 1, `${id} ${rgb}`)
      assert.equal(r[0].colorId, id, `${rgb}`)
      assert.ok(near(r[0], 320, 180), `${id} の中心`)
      assert.ok(Math.abs(r[0].pen.angleDeg - 25) < 2 && Math.abs(r[0].pen.length - 200) < 6)
      assert.ok(r[0].score!.total > 0.9, `${id} のスコア ${r[0].score!.total}`)
    }
  })

  it('赤は色相 0/179 をまたいでも 1 本として認識する（上側と下側の画素が混ざったペン）', () => {
    const r = detect(
      scene((i) => {
        bar(i, 270, 180, 100, 16, 0, RGB.red)
        bar(i, 370, 180, 100, 16, 0, RGB.red2)
      }),
      [color('red')],
    )
    assert.equal(r.length, 1)
    assert.ok(Math.abs(r[0].pen.length - 200) < 6, `${r[0].pen.length}`)
  })

  it('1 色モードでは選んだ色だけを認識する', () => {
    const img = scene((i) => {
      bar(i, 200, 180, 180, 14, 80, RGB.pink)
      bar(i, 440, 180, 180, 14, 100, RGB.blue)
    })
    const onlyBlue = detect(img, [color('blue')])
    assert.equal(onlyBlue.length, 1)
    assert.equal(onlyBlue[0].colorId, 'blue')
  })

  it('2 色以上のペンを同時に認識する', () => {
    const r = detect(
      scene((i) => {
        bar(i, 140, 180, 180, 14, 80, RGB.pink)
        bar(i, 320, 180, 180, 14, 100, RGB.blue)
        bar(i, 500, 180, 180, 14, 70, RGB.green)
      }),
    )
    assert.deepEqual(r.map((d) => d.colorId).sort(), ['blue', 'green', 'pink'])
  })

  it('キャップの部分が少し太いペン（幅が 3〜4 割変わる）は、幅の均一性で除外しない', () => {
    for (const rgb of [RGB.pink, RGB.blue]) {
      const r = detect(
        scene((i) => {
          bar(i, 320, 180, 200, 14, 0, rgb)
          bar(i, 395, 180, 50, 19, 0, rgb) // キャップ
        }),
      )
      assert.equal(r.length, 1, `${rgb}`)
      assert.ok(r[0].score!.uniformity > 0.8, `${r[0].score!.uniformity}`)
    }
  })

  it('同じ色のペンが複数本あっても別々に認識する', () => {
    const r = detect(
      scene((i) => {
        bar(i, 200, 180, 180, 14, 80, RGB.green)
        bar(i, 440, 180, 180, 14, 100, RGB.green)
      }),
    )
    assert.equal(r.length, 2)
    assert.ok(r.every((d) => d.colorId === 'green'))
  })

  it('指で分断されたペンは、どの色でも 1 本に結合する', () => {
    for (const rgb of [RGB.pink, RGB.blue, RGB.green, RGB.red]) {
      const r = detect(
        scene((i) => {
          bar(i, 320, 180, 200, 16, 30, rgb)
          bar(i, 320, 180, 30, 50, 30, SKIN) // 指
        }),
      )
      assert.equal(r.length, 1, `${rgb}`)
      assert.equal(r[0].pen.segments.length, 2)
      assert.ok(Math.abs(r[0].pen.length - 200) < 6, `${r[0].pen.length}`)
    }
  })

  it('別々の色の領域は、端を向け合って並んでいても 1 本に結合しない', () => {
    const r = detect(
      scene((i) => {
        bar(i, 200, 180, 200, 14, 0, RGB.pink)
        bar(i, 430, 180, 200, 14, 0, RGB.blue)
      }),
    )
    assert.equal(r.length, 2)
    assert.ok(r.every((d) => d.pen.length < 210))
  })

  it('ピンクと赤の両方の範囲に入る色は、重複して 2 本にしない', () => {
    const r = detect(scene((i) => bar(i, 320, 180, 200, 16, 10, RGB.pinkRed)))
    assert.equal(r.length, 1)
  })
})

describe('誤認識の防止（形状判定）', () => {
  it('赤い服（胴体・袖）をペンとして認識しない。そばのペンは認識する', () => {
    const torso = (i: any) => poly(i, [[180, 200], [460, 200], [560, 360], [80, 360]], RGB.red)
    const sleeve = (i: any) => bar(i, 320, 200, 220, 64, 15, RGB.red)
    assert.equal(detect(scene(torso)).length, 0, '胴体')
    assert.equal(detect(scene(sleeve)).length, 0, '袖（太い帯）')
    assert.equal(detect(scene((i) => bar(i, 320, 200, 260, 62, 15, RGB.red))).length, 0, '長い袖（縦横比 4.2）')
    // 参考：形状判定を OFF にすると（STEP 5 までの判定）袖はペンになってしまう
    assert.equal(detect(scene(sleeve), BUILTIN_COLORS, 3, SHAPE_OFF).length, 1)
    const withPen = detect(
      scene((i) => {
        torso(i)
        bar(i, 320, 120, 200, 16, 20, RGB.pink)
      }),
    )
    assert.equal(withPen.length, 1)
    assert.equal(withPen[0].colorId, 'pink')
  })

  it('色付きの壁をペンとして認識しない。壁の前のペンは認識する', () => {
    const wall = (i: any) => poly(i, [[0, 0], [300, 0], [300, 360], [0, 360]], RGB.green)
    assert.equal(detect(scene(wall)).length, 0)
    // 壁の端が細長い帯として見える場合（画面端の縦長の壁）
    assert.equal(detect(scene((i) => poly(i, [[560, 0], [640, 0], [640, 360], [560, 360]], RGB.green))).length, 0)
    // 画面を横切る細長い色の柱・ドア枠（縦横比・幅・直線性はペンと同じだが、面積が大きすぎる）
    assert.equal(detect(scene((i) => bar(i, 320, 300, 600, 40, 0, RGB.green))).length, 0)
    const withPen = detect(
      scene((i) => {
        wall(i)
        bar(i, 470, 180, 200, 16, 60, RGB.blue)
      }),
    )
    assert.equal(withPen.length, 1)
    assert.equal(withPen[0].colorId, 'blue')
  })

  it('色が似ている別の物体（箱・ボール・先細りの物・曲がった物）を除外する', () => {
    const cases: [string, (i: any) => void][] = [
      ['青い箱（ライター程度の縦横比）', (i) => bar(i, 320, 180, 100, 40, 10, RGB.blue)],
      ['ピンクのボール', (i) => cv.circle(i, new cv.Point(320, 180), 40, new cv.Scalar(...RGB.pink, 255), -1)],
      ['ピンクの先細りの物', (i) => poly(i, [[220, 160], [420, 178], [420, 182], [220, 200]], RGB.pink)],
      [
        'ピンクの曲がった物',
        (i) => {
          for (let a = 0; a < 140; a += 2) {
            const r = (a * Math.PI) / 180
            cv.circle(i, new cv.Point(320 + 110 * Math.cos(r), 250 - 110 * Math.sin(r)), 8, new cv.Scalar(...RGB.pink, 255), -1)
          }
        },
      ],
    ]
    cases.push([
      '緑のペットボトル型の物（太い胴と細い首。幅が均一でない）',
      (i) => {
        bar(i, 280, 180, 120, 40, 0, RGB.green)
        bar(i, 380, 180, 80, 14, 0, RGB.green)
      },
    ])
    for (const [name, draw] of cases) {
      assert.equal(detect(scene(draw)).length, 0, name)
    }
    // 参考：先細り・曲がった物・箱は、形状判定 OFF（STEP 5 まで）ではペンとして検出される
    assert.equal(detect(scene(cases[0][1]), BUILTIN_COLORS, 3, SHAPE_OFF).length, 1)
    assert.equal(detect(scene(cases[2][1]), BUILTIN_COLORS, 3, SHAPE_OFF).length, 1)
    assert.equal(detect(scene(cases[3][1]), BUILTIN_COLORS, 3, SHAPE_OFF).length, 1)
  })

  it('手に持たれているペンを、置いてあるだけの同じ形の物より優先する', () => {
    const img = scene((i) => {
      bar(i, 160, 180, 180, 14, 90, RGB.pink)
      bar(i, 480, 180, 180, 14, 90, RGB.pink)
    })
    // 右のペンを握る手（指先の点がペンの軸の上にある）
    const hand = { points: [{ x: 520, y: 260 }, { x: 495, y: 200 }, { x: 482, y: 185 }], scale: 70 }
    const [first] = detect(img, [color('pink')], 1, DEFAULT_SHAPE, [hand])
    assert.ok(near(first, 480, 180), `手に持たれた右のペンを選ぶ（${first.pen.center.x}）`)
    const both = detect(img, [color('pink')], 2, DEFAULT_SHAPE, [hand])
    const held = both.find((d) => near(d, 480, 180))!
    const free = both.find((d) => near(d, 160, 180))!
    assert.equal(held.score!.hand, 1)
    assert.ok(held.score!.total > free.score!.total)
    assert.ok(free.score!.total >= DEFAULT_SHAPE.minScore, '手から離れたペンも除外まではしない')
  })
})

describe('従来のピンク認識との互換性', () => {
  const scenes = () => [
    scene((i) => bar(i, 320, 180, 200, 24, 30, RGB.pink)),
    scene((i) => {
      bar(i, 320, 180, 200, 24, 0, RGB.pink)
      bar(i, 320, 180, 50, 90, 0, SKIN)
    }),
    scene((i) => {
      bar(i, 200, 150, 180, 14, 30, RGB.pink)
      bar(i, 450, 200, 120, 12, 100, RGB.pink)
    }),
    scene((i) => cv.circle(i, new cv.Point(300, 200), 30, new cv.Scalar(...RGB.pink, 255), -1)),
    scene(() => {}),
  ]

  it('ピンク 1 色・形状判定 OFF は、STEP 5 までの detectAll と同一の結果', () => {
    for (const img of scenes()) {
      for (const maxPens of [1, 2]) {
        const legacy = detector.detectAll(img, DEFAULT_SETTINGS, maxPens)
        const now = detect(img, [color('pink')], maxPens, SHAPE_OFF).map((d) => d.pen)
        assert.deepEqual(now, legacy)
      }
    }
  })

  it('ピンク 1 色・形状判定 ON でも、ペンの検出結果は同じ（形状判定はペンを除外しない）', () => {
    for (const img of scenes()) {
      const legacy = detector.detect(img, DEFAULT_SETTINGS)
      const now = detect(img, [color('pink')], 1)[0]?.pen ?? null
      assert.deepEqual(now, legacy)
    }
  })

  it('組み込みのピンクの範囲は STEP 1 からの既定値と同じ', () => {
    const { hMin, hMax, sMin, sMax, vMin, vMax } = DEFAULT_SETTINGS
    assert.deepEqual(color('pink').hsv, { hMin, hMax, sMin, sMax, vMin, vMax })
  })
})

describe('彩度の低い色（実験的）', () => {
  const white: PenColor = {
    id: 'custom-white',
    name: '白',
    hsv: { hMin: 0, hMax: 179, sMin: 0, sMax: 40, vMin: 200, vMax: 255 },
    swatch: '#ffffff',
    builtin: false,
    enabled: true,
    achromatic: true,
  }
  it('白いペンを明度・彩度の範囲と形状で検出できる（単純な背景の合成画像のみ）', () => {
    const r = detect(scene((i) => bar(i, 320, 180, 200, 16, 20, [245, 245, 245])), [white])
    assert.equal(r.length, 1)
  })
  it('彩度の低い色は形状スコアの下限が高く、白い壁・白い紙は検出しない', () => {
    assert.equal(detect(scene((i) => poly(i, [[0, 0], [260, 0], [260, 360], [0, 360]], [240, 240, 240])), [white]).length, 0)
    assert.equal(detect(scene((i) => bar(i, 320, 180, 210, 150, 5, [240, 240, 240])), [white]).length, 0)
    // 白いカード（縦横比 3.8）：色のある物なら下限ぎりぎりで通る形だが、彩度の低い色では下限を上げているので除外する
    assert.equal(detect(scene((i) => bar(i, 320, 180, 152, 40, 5, [240, 240, 240])), [white]).length, 0)
  })
})

describe('scorePenShape', () => {
  it('手の推論が無ければ手のスコアは null で、合計に影響しない', () => {
    const r = detect(scene((i) => bar(i, 320, 180, 200, 16, 0, RGB.pink)), [color('pink')], 1)
    const mask = new Uint8Array(W * H)
    const withoutHands = scorePenShape(r[0].pen, mask, null)
    assert.equal(withoutHands.hand, null)
  })
})
