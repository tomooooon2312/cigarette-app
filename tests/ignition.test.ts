import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_IGNITION, IGNITION_TIMING, IgnitionStateMachine, type IgnitionInput } from '../src/lib/ignition.ts'

// 全長 200px のタバコ：吸い口 (100,200)、火側 (300,200)
const BASE = { emberEnd: { x: 300, y: 200 }, mouthEnd: { x: 100, y: 200 }, cigaretteLength: 200 }
const NEAR_EMBER = { x: 320, y: 195 } // 火側から 0.1
const FRAME_MS = 33

function run(fsm: IgnitionStateMachine, frames: number, p: Partial<IgnitionInput>, start = 0) {
  const outs = []
  for (let i = 0; i < frames; i++) {
    outs.push(fsm.update({ now: start + i * FRAME_MS, flames: [], ...BASE, ...p }, DEFAULT_IGNITION))
  }
  return outs
}

describe('IgnitionStateMachine', () => {
  it('初期状態は UNLIT', () => {
    assert.equal(new IgnitionStateMachine().current, 'UNLIT')
  })

  it('炎が無ければ着火しない', () => {
    const fsm = new IgnitionStateMachine()
    assert.ok(run(fsm, 60, { flames: [] }).every((o) => o.state === 'UNLIT'))
  })

  it('火側の端を炎に数フレーム連続で近づけると LIT になる', () => {
    const fsm = new IgnitionStateMachine()
    const outs = run(fsm, 10, { flames: [NEAR_EMBER] })
    const first = outs.findIndex((o) => o.state === 'LIT')
    assert.ok(first >= IGNITION_TIMING.confirmFrames - 1)
    assert.ok(first * FRAME_MS >= IGNITION_TIMING.confirmMs)
    assert.equal(outs.filter((o) => o.ignitedNow).length, 1)
  })

  it('1〜2 フレームだけ炎に触れても着火しない', () => {
    const fsm = new IgnitionStateMachine()
    run(fsm, 2, { flames: [NEAR_EMBER] })
    run(fsm, 5, { flames: [] }, 100)
    assert.equal(fsm.current, 'UNLIT')
  })

  it('時間と回数の両方を満たすまで着火しない（低 fps で 2 フレーム / 高 fps で短時間）', () => {
    const lowFps = new IgnitionStateMachine()
    lowFps.update({ now: 0, flames: [NEAR_EMBER], ...BASE }, DEFAULT_IGNITION)
    lowFps.update({ now: 200, flames: [NEAR_EMBER], ...BASE }, DEFAULT_IGNITION)
    assert.equal(lowFps.current, 'UNLIT', '2 フレームでは時間を満たしても着火しない')
    const highFps = new IgnitionStateMachine()
    for (let i = 0; i < 10; i++) highFps.update({ now: i * 5, flames: [NEAR_EMBER], ...BASE }, DEFAULT_IGNITION)
    assert.equal(highFps.current, 'UNLIT', '45ms では回数を満たしても着火しない')
  })

  it('吸い口側や胴体の中央を炎に当てても着火しない', () => {
    for (const flame of [{ x: 90, y: 200 }, { x: 200, y: 205 }]) {
      const fsm = new IgnitionStateMachine()
      run(fsm, 30, { flames: [flame] })
      assert.equal(fsm.current, 'UNLIT', JSON.stringify(flame))
    }
  })

  it('距離はタバコの全長で正規化する（近づいて大きく写っても同じ判定）', () => {
    const fsm = new IgnitionStateMachine()
    // 2 倍の大きさで写ったタバコ：火側から 40px（全長 400 の 0.1）
    run(fsm, 10, {
      emberEnd: { x: 600, y: 400 },
      mouthEnd: { x: 200, y: 400 },
      cigaretteLength: 400,
      flames: [{ x: 640, y: 400 }],
    })
    assert.equal(fsm.current, 'LIT')
    // 小さく写ったタバコ（全長 50）では 40px 離れた炎は遠い（0.8）
    const far = new IgnitionStateMachine()
    run(far, 10, { emberEnd: { x: 150, y: 100 }, mouthEnd: { x: 100, y: 100 }, cigaretteLength: 50, flames: [{ x: 190, y: 100 }] })
    assert.equal(far.current, 'UNLIT')
  })

  it('タバコが無い（未検出）ときは判定しない', () => {
    const fsm = new IgnitionStateMachine()
    run(fsm, 20, { emberEnd: null, mouthEnd: null, flames: [NEAR_EMBER] })
    assert.equal(fsm.current, 'UNLIT')
  })

  it('LIT は炎から離れても維持し、消火で UNLIT に戻る。手動着火もできる', () => {
    const fsm = new IgnitionStateMachine()
    run(fsm, 10, { flames: [NEAR_EMBER] })
    run(fsm, 30, { flames: [] }, 400)
    assert.equal(fsm.current, 'LIT')
    fsm.extinguish()
    assert.equal(fsm.current, 'UNLIT')
    fsm.light()
    assert.equal(fsm.current, 'LIT')
  })
})
