import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CigaretteOrienter,
  ORIENT_SWITCH_SAMPLES,
  type OrientationMouth,
  type OrientationPen,
} from '../src/lib/cigaretteOrientation.ts'

type P = { x: number; y: number }

function pen(center: P, deg: number, length = 200, swap = false): OrientationPen {
  const r = (deg * Math.PI) / 180
  const u = { x: Math.cos(r), y: Math.sin(r) }
  const a = { x: center.x - (u.x * length) / 2, y: center.y - (u.y * length) / 2 }
  const b = { x: center.x + (u.x * length) / 2, y: center.y + (u.y * length) / 2 }
  return { center, endpoints: swap ? [b, a] : [a, b], length }
}

let sample = 0
const mouthAt = (center: P, faceScale = 100): OrientationMouth => ({ center, faceScale, sampleId: ++sample })

/** 吸い口側の端（向きの逆側） */
function filterEnd(p: OrientationPen, dir: P): P {
  return { x: p.center.x - (dir.x * p.length) / 2, y: p.center.y - (dir.y * p.length) / 2 }
}

const near = (a: P, b: P, tol = 1e-6) => Math.hypot(a.x - b.x, a.y - b.y) < tol

describe('CigaretteOrienter', () => {
  it('口元に近い方の端がフィルターになる（連続 N 回で反転）', () => {
    const o = new CigaretteOrienter()
    const p = pen({ x: 300, y: 200 }, 0) // endpoints[0] = 左端 (200,200)
    const mouth = { x: 420, y: 200 } // 右端 (400,200) の近く
    let dir = o.update(p, null)
    assert.ok(near(filterEnd(p, dir), p.endpoints[0]), '初期値は従来どおり endpoints[0] が吸い口')
    for (let i = 0; i < ORIENT_SWITCH_SAMPLES - 1; i++) dir = o.update(p, mouthAt(mouth))
    assert.ok(near(filterEnd(p, dir), p.endpoints[0]), 'N 回未満では反転しない')
    dir = o.update(p, mouthAt(mouth))
    assert.ok(near(filterEnd(p, dir), p.endpoints[1]), 'N 回目で口元側がフィルターになる')
  })

  it('すでに口元側がフィルターなら反転しない', () => {
    const o = new CigaretteOrienter()
    const p = pen({ x: 300, y: 200 }, 0)
    for (let i = 0; i < 10; i++) {
      const dir = o.update(p, mouthAt({ x: 180, y: 200 }))
      assert.ok(near(filterEnd(p, dir), p.endpoints[0]))
    }
  })

  it('端点の順序が入れ替わっても（再検出など）向きは画面上で変わらない', () => {
    const o = new CigaretteOrienter()
    const p = pen({ x: 300, y: 200 }, 30)
    for (let i = 0; i < ORIENT_SWITCH_SAMPLES; i++) o.update(p, mouthAt({ x: 400, y: 260 }))
    const before = filterEnd(p, o.update(p, null))
    const swapped = pen({ x: 300, y: 200 }, 30, 200, true)
    const after = filterEnd(swapped, o.update(swapped, null))
    assert.ok(near(before, after))
  })

  it('ペンを回転させても向きが連続的に追従し、0°/180° をまたいでも反転しない', () => {
    const o = new CigaretteOrienter()
    let prev: P | null = null
    for (let deg = 0; deg <= 360; deg += 10) {
      // 角度の正規化で端点の順序が入れ替わるケースを模擬（180° 以上では逆順）
      const p = pen({ x: 300, y: 200 }, deg % 180, 200, deg >= 180)
      const f = filterEnd(p, o.update(p, null))
      if (prev) assert.ok(Math.hypot(f.x - prev.x, f.y - prev.y) < 40, `deg=${deg}`)
      prev = f
    }
  })

  it('距離差が小さい（ヒステリシス内）ときは前回の向きを維持する', () => {
    const o = new CigaretteOrienter()
    const p = pen({ x: 300, y: 200 }, 0)
    // 口がペンの中央の真上：両端までの距離がほぼ同じ
    for (let i = 0; i < 10; i++) {
      const dir = o.update(p, mouthAt({ x: 305, y: 120 }))
      assert.ok(near(filterEnd(p, dir), p.endpoints[0]))
    }
  })

  it('顔を見失っている間は直前の向きを維持する', () => {
    const o = new CigaretteOrienter()
    const p = pen({ x: 300, y: 200 }, 0)
    for (let i = 0; i < ORIENT_SWITCH_SAMPLES; i++) o.update(p, mouthAt({ x: 420, y: 200 }))
    for (let i = 0; i < 20; i++) {
      assert.ok(near(filterEnd(p, o.update(p, null)), p.endpoints[1]))
    }
  })

  it('同じ推論結果（sampleId が同じ）は 1 回としか数えない', () => {
    const o = new CigaretteOrienter()
    const p = pen({ x: 300, y: 200 }, 0)
    const m = mouthAt({ x: 420, y: 200 })
    for (let i = 0; i < 10; i++) o.update(p, m)
    assert.ok(near(filterEnd(p, o.update(p, m)), p.endpoints[0]))
  })

  it('ペンが顔から遠いときは判定しない', () => {
    const o = new CigaretteOrienter()
    const p = pen({ x: 1300, y: 200 }, 0)
    // 口は右端（1400,200）側にあるが、顔の大きさ 50px に対して 22 倍離れている
    for (let i = 0; i < 10; i++) o.update(p, mouthAt({ x: 2500, y: 200 }, 50))
    assert.ok(near(filterEnd(p, o.update(p, null)), p.endpoints[0]))
  })
})
