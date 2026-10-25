import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_IGNITION,
  IGNITION_TIMING,
  IgnitionStateMachine,
  PREVIOUS_IGNITE_DISTANCE,
  nearestOnFlame,
  type IgnitionInput,
} from '../src/lib/ignition.ts'

// 全長 200px のタバコ：吸い口 (100,200)、火側 (300,200)
const BASE = { emberEnd: { x: 300, y: 200 }, mouthEnd: { x: 100, y: 200 }, cigaretteLength: 200 }
const NEAR_EMBER = { x: 320, y: 195 } // 火側から 0.1（十分に近い：着火距離 × instantRatio 以内）
const MID_EMBER = { x: 350, y: 200 } // 火側から 0.25（着火距離内、十分に近いほどではない）
const FAR_FLAME = { x: 400, y: 200 } // 火側から 0.5（着火距離の外）
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

  it('STEP 11：着火距離は STEP 10 の 1.5 倍（0.25 → 0.375）', () => {
    assert.equal(PREVIOUS_IGNITE_DISTANCE, 0.25)
    assert.ok(Math.abs(DEFAULT_IGNITION.igniteDistance - 0.375) < 1e-9)
  })

  it('着火距離内（十分に近いほどではない）で数フレーム続けると LIT になる', () => {
    const fsm = new IgnitionStateMachine()
    const outs = run(fsm, 10, { flames: [MID_EMBER] })
    const first = outs.findIndex((o) => o.state === 'LIT')
    assert.ok(first >= IGNITION_TIMING.confirmFrames - 1)
    assert.ok(first * FRAME_MS >= IGNITION_TIMING.confirmMs)
    assert.equal(outs.filter((o) => o.ignitedNow).length, 1)
    assert.match(outs[0].reason, /確認中/)
  })

  it('STEP 10 の着火距離（0.25）では届かなかった距離 0.3 でも着火する', () => {
    const fsm = new IgnitionStateMachine()
    run(fsm, 10, { flames: [{ x: 360, y: 200 }] })
    assert.equal(fsm.current, 'LIT')
    const old = new IgnitionStateMachine()
    for (let i = 0; i < 10; i++) old.update({ now: i * FRAME_MS, flames: [{ x: 360, y: 200 }], ...BASE }, { igniteDistance: PREVIOUS_IGNITE_DISTANCE })
    assert.equal(old.current, 'UNLIT')
  })

  it('一瞬だけでも十分に近づけば（着火距離 × instantRatio 以内）その 1 フレームで着火する', () => {
    const fsm = new IgnitionStateMachine()
    const out = fsm.update({ now: 0, flames: [NEAR_EMBER], ...BASE }, DEFAULT_IGNITION)
    assert.equal(out.state, 'LIT')
    assert.ok(out.ignitedNow)
    assert.match(out.reason, /十分に近い/)
  })

  it('十分に近くない炎に 1 フレームだけ触れても着火しない', () => {
    const fsm = new IgnitionStateMachine()
    run(fsm, 1, { flames: [MID_EMBER] })
    run(fsm, 10, { flames: [] }, 300)
    assert.equal(fsm.current, 'UNLIT')
  })

  it('当たっている途中で 1 フレーム外れても（gapMs 以内）数え直さない', () => {
    const fsm = new IgnitionStateMachine()
    fsm.update({ now: 0, flames: [MID_EMBER], ...BASE }, DEFAULT_IGNITION)
    fsm.update({ now: 40, flames: [FAR_FLAME], ...BASE }, DEFAULT_IGNITION)
    const out = fsm.update({ now: 90, flames: [MID_EMBER], ...BASE }, DEFAULT_IGNITION)
    assert.equal(out.state, 'LIT', '2 回目の接触で着火（間に 1 フレーム外れても途中経過を残す）')
    const reset = new IgnitionStateMachine()
    reset.update({ now: 0, flames: [MID_EMBER], ...BASE }, DEFAULT_IGNITION)
    reset.update({ now: 300, flames: [FAR_FLAME], ...BASE }, DEFAULT_IGNITION)
    assert.equal(reset.update({ now: 400, flames: [MID_EMBER], ...BASE }, DEFAULT_IGNITION).state, 'UNLIT', 'gapMs より長く外れたら数え直す')
  })

  it('時間と回数の両方を満たすまで着火しない（低 fps で 1 フレーム / 高 fps で短時間）', () => {
    const lowFps = new IgnitionStateMachine()
    lowFps.update({ now: 0, flames: [MID_EMBER], ...BASE }, DEFAULT_IGNITION)
    assert.equal(lowFps.current, 'UNLIT', '1 フレームでは着火しない')
    const highFps = new IgnitionStateMachine()
    for (let i = 0; i < 10; i++) highFps.update({ now: i * 5, flames: [MID_EMBER], ...BASE }, DEFAULT_IGNITION)
    assert.equal(highFps.current, 'UNLIT', '45ms では回数を満たしても着火しない')
  })

  it('STEP 11：炎は根元〜先端の線分で判定する（描いた炎の先端だけが火側の端に届いても着火する）', () => {
    // 根元は火側の端の 90px 下（全長 ×0.45、着火距離の外）、先端は 10px 下
    const shape = { base: { x: 300, y: 290 }, tip: { x: 300, y: 210 } }
    const fsm = new IgnitionStateMachine()
    const out = fsm.update({ now: 0, flames: [shape], ...BASE }, DEFAULT_IGNITION)
    assert.ok(Math.abs(out.flameDistance! - 0.05) < 1e-9)
    assert.deepEqual(out.nearestFlamePoint, { x: 300, y: 210 })
    assert.equal(out.state, 'LIT')
    assert.deepEqual(nearestOnFlame({ x: 0, y: 0 }, { base: { x: 10, y: 0 }, tip: { x: 20, y: 0 } }), { x: 10, y: 0 })
  })

  it('着火しない理由を返す（炎が無い・遠い・吸い口側）', () => {
    assert.match(new IgnitionStateMachine().update({ now: 0, flames: [], ...BASE }, DEFAULT_IGNITION).reason, /炎が無い/)
    assert.match(new IgnitionStateMachine().update({ now: 0, flames: [FAR_FLAME], ...BASE }, DEFAULT_IGNITION).reason, /炎が遠い/)
    assert.match(
      new IgnitionStateMachine().update({ now: 0, flames: [{ x: 250, y: 200 }], ...BASE, mouthEnd: { x: 240, y: 200 } }, DEFAULT_IGNITION).reason,
      /吸い口側/,
    )
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
