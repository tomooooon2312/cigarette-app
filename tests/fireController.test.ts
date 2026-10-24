import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_FIRE, FireController, type FireFrameInput } from '../src/lib/fireController.ts'
import { SNAP_FLAME_MS } from '../src/lib/flameEffect.ts'
import type { TrackedHand } from '../src/lib/handTracker.ts'
import { penFromAxis, type PenDetection } from '../src/lib/penGeometry.ts'
import type { HandSample } from '../src/lib/snapDetector.ts'

type P = { x: number; y: number }
const FRAME = 33

/** 右手の合成姿勢（snapDetector.test.ts と同じ形）。thumbAt に親指の先端が来るよう平行移動する */
function hand(phase: 'press' | 'snapped' | 'open', thumbAt: P, time: number): TrackedHand {
  const at = (x: number, y: number): P => ({ x: thumbAt.x + 60 + x, y: thumbAt.y + 55 + y })
  const middle = { press: at(-55, -75), snapped: at(-25, 15), open: at(-5, -140) }[phase]
  const sample: HandSample = {
    time,
    thumbTip: at(-60, -55),
    middleTip: middle,
    wrist: at(0, 60),
    indexMcp: at(-30, -40),
    pinkyMcp: at(35, -30),
    scale: 100,
  }
  return { key: 'right', side: 'right', landmarks: [], sample, sampleId: 0 }
}

// 全長 200px のタバコ：吸い口 (100,300)、火側 (300,300)
const CIGARETTE = { emberEnd: { x: 300, y: 300 }, mouthEnd: { x: 100, y: 300 }, length: 200 }

function input(now: number, p: Partial<FireFrameInput> = {}): FireFrameInput {
  return {
    now,
    frameWidth: 640,
    frameHeight: 480,
    hands: [],
    handsFresh: true,
    lighterMeasured: null,
    lighterPressed: false,
    manualFlameRequested: false,
    cigarette: CIGARETTE,
    settings: DEFAULT_FIRE,
    ...p,
  }
}

/** 縦向き（火口が上）のライター：中心 (cx, cy)、長さ 100、幅 40 */
function lighterAt(cx: number, cy: number): PenDetection {
  return penFromAxis({ center: { x: cx, y: cy }, u: { x: 0, y: 1 }, length: 100, thickness: 40, area: 4000, segments: [], frameWidth: 640, frameHeight: 480 })
}

describe('FireController', () => {
  it('指パッチンで親指の先に炎が出て、火側の端が近ければ着火する', () => {
    const fire = new FireController()
    const thumb = { x: 320, y: 340 } // 炎の胴体が火側の端の近くに来る位置
    let t = 0
    for (let i = 0; i < 4; i++) fire.update(input((t += FRAME), { hands: [hand('press', thumb, t)] }))
    const snapped = fire.update(input((t += FRAME), { hands: [hand('snapped', thumb, t)] }))
    assert.ok(snapped.snapEvent, '指パッチンを判定')
    assert.equal(snapped.flames.length, 1)
    assert.equal(snapped.flames[0].source, 'snap')
    let last = snapped
    for (let i = 0; i < 10; i++) last = fire.update(input((t += FRAME), { hands: [hand('open', thumb, t)], handsFresh: true }))
    assert.equal(last.ignition.state, 'LIT')
  })

  it('指パッチンをしなければ炎は出ず、着火しない', () => {
    const fire = new FireController()
    let t = 0
    let last
    for (let i = 0; i < 60; i++) last = fire.update(input((t += FRAME), { hands: [hand(i % 2 ? 'open' : 'press', { x: 320, y: 340 }, t)] }))
    // 押す・開くを交互に繰り返しても、弾く動き（中指が手のひら側へ）が無ければ判定しない
    assert.equal(last!.flames.length, 0)
    assert.equal(last!.ignition.state, 'UNLIT')
  })

  it('炎がタバコから遠い、または吸い口側にあるときは着火しない', () => {
    for (const thumb of [{ x: 600, y: 100 }, { x: 100, y: 340 }]) {
      const fire = new FireController()
      let t = 0
      for (let i = 0; i < 4; i++) fire.update(input((t += FRAME), { hands: [hand('press', thumb, t)] }))
      fire.update(input((t += FRAME), { hands: [hand('snapped', thumb, t)] }))
      let last
      for (let i = 0; i < 20; i++) last = fire.update(input((t += FRAME), { hands: [hand('open', thumb, t)] }))
      assert.equal(last!.ignition.state, 'UNLIT', JSON.stringify(thumb))
    }
  })

  it('指パッチンの炎は手に追従し、一定時間で消える', () => {
    const fire = new FireController()
    let t = 0
    for (let i = 0; i < 4; i++) fire.update(input((t += FRAME), { hands: [hand('press', { x: 500, y: 100 }, t)] }))
    fire.update(input((t += FRAME), { hands: [hand('snapped', { x: 500, y: 100 }, t)] }))
    const moved = fire.update(input((t += FRAME), { hands: [hand('open', { x: 520, y: 140 }, t)] }))
    assert.ok(Math.abs(moved.flames[0].position.x - 520) < 1, '炎が親指の先に追従')
    const later = fire.update(input(t + SNAP_FLAME_MS + 100, { hands: [] }))
    assert.equal(later.flames.length, 0)
  })

  it('ライター：ボタンを押している間だけ火口（上端）に炎が出て、火側を近づけると着火する', () => {
    const fire = new FireController()
    // 火口（上端）が (300, 330) 付近に来るライター → 炎の胴体が火側の端 (300,300) の近く
    const lighter = lighterAt(300, 380)
    let t = 0
    let last
    for (let i = 0; i < 15; i++) last = fire.update(input((t += FRAME), { lighterMeasured: lighter, lighterPressed: false }))
    assert.equal(last!.flames.length, 0, '押していなければ炎なし')
    assert.equal(last!.ignition.state, 'UNLIT')
    assert.ok(last!.lighterNozzle && last!.lighterNozzle.y < 380, '火口は上端')
    for (let i = 0; i < 15; i++) last = fire.update(input((t += FRAME), { lighterMeasured: lighter, lighterPressed: true }))
    assert.equal(last!.flames[0]?.source, 'lighter')
    assert.equal(last!.ignition.state, 'LIT')
  })

  it('ライター認識を OFF にすると、ライターも炎も出ない', () => {
    const fire = new FireController()
    const settings = { ...DEFAULT_FIRE, lighterEnabled: false }
    let t = 0
    let last
    for (let i = 0; i < 15; i++) last = fire.update(input((t += FRAME), { lighterMeasured: lighterAt(300, 380), lighterPressed: true, settings }))
    assert.equal(last!.lighter, null)
    assert.equal(last!.flames.length, 0)
  })

  it('手動の炎：手が無ければ画面中央に出る', () => {
    const fire = new FireController()
    const out = fire.update(input(100, { manualFlameRequested: true, cigarette: null }))
    assert.equal(out.flames[0].source, 'manual')
    assert.ok(Math.abs(out.flames[0].position.x - 320) < 1)
  })
})
