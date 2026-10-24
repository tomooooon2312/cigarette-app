import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AUTO_CG_THRESHOLDS,
  CIGAR_THICKNESS,
  DEFAULT_CIGARETTE,
  chooseCgKind,
  placeCigarette,
} from '../src/lib/cigaretteRenderer.ts'
import type { Mouth } from '../src/lib/mouthTracker.ts'
import { MultiPenTracker, majorityColor } from '../src/lib/multiPenTracker.ts'
import { penFromAxis, type PenDetection } from '../src/lib/penGeometry.ts'
import { DEFAULT_TRACKING, PenTrackingFilter } from '../src/lib/penTracking.ts'
import { PersonController } from '../src/lib/personController.ts'

function pen(cx: number, cy: number, deg = 0, length = 150, thickness = 12): PenDetection {
  const r = (deg * Math.PI) / 180
  return penFromAxis({ center: { x: cx, y: cy }, u: { x: Math.cos(r), y: Math.sin(r) }, length, thickness, area: length * thickness, segments: [], frameWidth: 640, frameHeight: 480 })
}
const tracked = (p: PenDetection) => new PenTrackingFilter().update(p, 0, DEFAULT_TRACKING)!

describe('CG の種類', () => {
  it('自動選択：細長い → タバコ、太め → 葉巻、短く太い → パイプ', () => {
    assert.equal(chooseCgKind(12), 'cigarette')
    assert.equal(chooseCgKind(7), 'cigar')
    assert.equal(chooseCgKind(4), 'pipe')
  })

  it('自動選択：しきい値の近くでは直前の種類を保つ（ちらつかない）', () => {
    const t = AUTO_CG_THRESHOLDS.cigar
    assert.equal(chooseCgKind(t - 0.3, 'cigarette'), 'cigarette')
    assert.equal(chooseCgKind(t + 0.3, 'cigar'), 'cigar')
    assert.equal(chooseCgKind(t - 1.5, 'cigarette'), 'cigar', 'しきい値から十分離れたら切り替える')
    let prev = chooseCgKind(t + 0.2)
    let switches = 0
    for (let i = 0; i < 50; i++) {
      const k = chooseCgKind(t + (i % 2 ? 0.4 : -0.4), prev)
      if (k !== prev) switches++
      prev = k
    }
    assert.equal(switches, 0)
  })

  it('タバコの配置は STEP 5 までと同じ。葉巻は太く、パイプの火はボウルの開口部（画面の上側）', () => {
    const p = tracked(pen(300, 200, 0, 200, 12))
    const cig = placeCigarette(p, DEFAULT_CIGARETTE, { x: 1, y: 0 })
    assert.deepEqual(cig.emberEnd, { x: 400, y: 200 })
    assert.equal(cig.kind, 'cigarette')
    const cigar = placeCigarette(p, DEFAULT_CIGARETTE, { x: 1, y: 0 }, 'cigar')
    assert.ok(Math.abs(cigar.thickness - cig.thickness * CIGAR_THICKNESS) < 1e-9)
    assert.deepEqual(cigar.emberEnd, cig.emberEnd)
    // 火の向きが左右・上下どちらでも、ボウルは画面の上側に立ち上がる
    for (const dir of [{ x: 1, y: 0 }, { x: -1, y: 0 }]) {
      const pipe = placeCigarette(p, DEFAULT_CIGARETTE, dir, 'pipe')
      assert.ok(pipe.emberEnd.y < 200 - 20, `ボウルの開口部は柄より上 ${pipe.emberEnd.y}`)
      assert.ok(Math.sign(pipe.emberEnd.x - 300) === Math.sign(dir.x), '火側の端の近く')
      assert.ok(pipe.bowlUp!.y < 0)
    }
    const vertical = placeCigarette(tracked(pen(300, 200, 80, 200, 12)), DEFAULT_CIGARETTE, null, 'pipe')
    assert.ok(vertical.bowlUp!.y <= 0)
  })
})

describe('色と追跡 ID（MultiPenTracker）', () => {
  it('追跡 ID と検出色を別々に持ち、照明で色の判定が一時的に変わっても ID と表示色を保つ', () => {
    const tracker = new MultiPenTracker()
    let id = -1
    for (let i = 0; i < 20; i++) {
      // 10 フレーム目から 4 フレームだけ、同じペンが「赤」と判定される（ピンクと赤の境目の色が照明で変化）
      const colorId = i >= 10 && i < 14 ? 'red' : 'pink'
      const [p] = tracker.update([pen(300 + i, 200)], i * 33, DEFAULT_TRACKING, 2, [{ colorId, score: 0.9 }])
      if (i === 0) id = p.id
      assert.equal(p.id, id, `frame ${i}`)
      assert.equal(p.colorId, 'pink', `frame ${i}`)
      assert.equal(p.score, 0.9)
    }
  })

  it('ずっと別の色と判定されるようになったら、表示色もその色に変わる', () => {
    const tracker = new MultiPenTracker()
    let last
    for (let i = 0; i < 40; i++) {
      ;[last] = tracker.update([pen(300, 200)], i * 33, DEFAULT_TRACKING, 2, [{ colorId: i < 10 ? 'pink' : 'red', score: null }])
    }
    assert.equal(last!.colorId, 'red')
  })

  it('同じくらい近い 2 本の候補があれば、同じ色の方に対応付ける', () => {
    const tracker = new MultiPenTracker()
    const raw = { ...DEFAULT_TRACKING, smoothing: 0 } // 対応付けだけを見るため平滑化しない
    const info = [{ colorId: 'pink', score: null }, { colorId: 'blue', score: null }]
    // ピンク（上）と青（下）の 2 本を追跡
    tracker.update([pen(300, 200), pen(300, 240)], 0, raw, 2, info)
    const before = tracker.update([pen(300, 200), pen(300, 240)], 33, raw, 2, info)
    const pinkId = before.find((p) => p.colorId === 'pink')!.id
    // 2 本が中間付近ですれ違う：位置だけなら「入れ替わり」の方がわずかに近い（15px 対 25px）が、色が一致する組を選ぶ
    const after = tracker.update([pen(300, 225), pen(300, 215)], 66, raw, 2, info)
    const pink = after.find((p) => p.id === pinkId)!
    assert.equal(pink.colorId, 'pink')
    assert.ok(Math.abs(pink.center.y - 225) < 1, `${pink.center.y}`)
  })

  it('majorityColor：多数決（履歴が無ければ null）', () => {
    assert.equal(majorityColor([]), null)
    assert.equal(majorityColor(['pink', 'red', 'pink']), 'pink')
  })
})

function mouth(x: number, y: number): Mouth {
  return { center: { x, y }, width: 40, height: 15, faceScale: 80, facing: 0.5, pucker: 0, funnel: 0, sampleId: 0, detectedAt: 0, debugPoints: [] }
}

describe('複数人・複数色', () => {
  it('2 人が異なる色のペンを持っても、それぞれに割り当てて色を保つ。CG の自動選択はペンごと', () => {
    const persons = new PersonController()
    let frame
    for (let i = 0; i < 10; i++) {
      frame = persons.track({
        now: i * 33,
        mode: 2,
        // A：細長いピンクのペン（タバコ）、B：太い青のペン（葉巻）
        measuredPens: [pen(178 - 75, 252, 0, 150, 12), pen(462 + 60, 252, 0, 120, 18)],
        penInfo: [{ colorId: 'pink', score: 0.95 }, { colorId: 'blue', score: 0.9 }],
        mouths: i % 2 === 0 ? [mouth(170, 250), mouth(470, 250)] : [],
        mouthsFresh: i % 2 === 0,
        hands: [],
        tracking: DEFAULT_TRACKING,
        cigarette: { ...DEFAULT_CIGARETTE, kind: 'auto' },
        showCigarette: true,
      })
    }
    const a = frame!.persons.find((p) => p.face && p.face.center.x < 320)!
    const b = frame!.persons.find((p) => p.face && p.face.center.x > 320)!
    assert.equal(a.pen!.colorId, 'pink')
    assert.equal(b.pen!.colorId, 'blue')
    assert.equal(a.kind, 'cigarette')
    assert.equal(b.kind, 'cigar')
    assert.equal(b.placement!.kind, 'cigar')
  })
})
