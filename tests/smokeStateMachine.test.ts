import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_FSM_SETTINGS,
  FSM_TIMING,
  SmokeStateMachine,
  type SmokeFsmInput,
  type SmokeFsmOutput,
} from '../src/lib/smokeStateMachine.ts'

const S = DEFAULT_FSM_SETTINGS
const NEAR = S.enterDistance * 0.5
const MIDDLE = (S.enterDistance + S.leaveDistance) / 2
const FAR = S.leaveDistance * 2
const PUCKER = S.puckerThreshold + 0.2
const STEP_MS = 66 // 顔推論 1 回分

/** 顔推論の間隔で入力を流すテスト用の小さなドライバ */
function driver() {
  const fsm = new SmokeStateMachine()
  let now = 0
  let sample = 0
  let last: SmokeFsmOutput = fsm.update(input({}), S)
  function input(p: Partial<SmokeFsmInput> & { face?: boolean }): SmokeFsmInput {
    const face = p.face ?? true
    return {
      now,
      faceSampleId: face ? sample : null,
      penVisible: p.penVisible ?? true,
      filterDistance: p.filterDistance === undefined ? FAR : p.filterDistance,
      pucker: p.pucker ?? 0,
      funnel: p.funnel ?? 0,
    }
  }
  /** ms の間、同じ条件で推論結果を流し、各回の出力を返す */
  function run(ms: number, p: Partial<SmokeFsmInput> & { face?: boolean } = {}): SmokeFsmOutput[] {
    const outs: SmokeFsmOutput[] = []
    for (let t = 0; t < ms; t += STEP_MS) {
      now += STEP_MS
      sample++
      last = fsm.update(input(p), S)
      outs.push(last)
    }
    return outs
  }
  return { run, get last() { return last } }
}

describe('SmokeStateMachine', () => {
  it('タバコを持っているだけ（口から遠い）では煙を出さない', () => {
    const d = driver()
    const outs = d.run(3000, { filterDistance: FAR })
    assert.ok(outs.every((o) => o.state === 'IDLE' && o.emitter === 'none'))
  })

  it('吸い口が口元に数回連続で近づくと SMOKING になり、火側からのみ煙を出す', () => {
    const d = driver()
    const outs = d.run(1000, { filterDistance: NEAR })
    const firstSmoking = outs.findIndex((o) => o.state === 'SMOKING')
    assert.equal(firstSmoking, FSM_TIMING.confirmSamples - 1)
    assert.ok(outs.slice(firstSmoking).every((o) => o.emitter === 'ember'))
    assert.ok(outs.every((o) => o.emitter !== 'mouth'))
  })

  it('1 回だけ近づいた（ノイズ）では SMOKING にならない', () => {
    const d = driver()
    d.run(STEP_MS, { filterDistance: NEAR })
    d.run(STEP_MS, { filterDistance: FAR })
    d.run(STEP_MS, { filterDistance: NEAR })
    assert.equal(d.last.state, 'IDLE')
  })

  it('吸う距離と離す距離の間（ヒステリシス帯）では SMOKING を維持する', () => {
    const d = driver()
    d.run(1000, { filterDistance: NEAR })
    const outs = d.run(1000, { filterDistance: MIDDLE })
    assert.ok(outs.every((o) => o.state === 'SMOKING'))
  })

  it('ペンを離しただけでは口から煙が出ない（IDLE で待機）', () => {
    const d = driver()
    d.run(1200, { filterDistance: NEAR })
    const outs = d.run(1500, { filterDistance: FAR, pucker: 0 })
    assert.equal(d.last.state, 'IDLE')
    assert.ok(d.last.exhaleReady)
    assert.ok(outs.every((o) => o.emitter !== 'mouth'))
  })

  it('十分に吸った後、離してから口をすぼめると EXHALING になり口からのみ煙を出す', () => {
    const d = driver()
    d.run(1200, { filterDistance: NEAR })
    d.run(500, { filterDistance: FAR })
    const outs = d.run(600, { filterDistance: FAR, pucker: PUCKER })
    const exhaling = outs.filter((o) => o.state === 'EXHALING')
    assert.ok(exhaling.length > 0)
    assert.ok(exhaling.every((o) => o.emitter === 'mouth'))
    assert.ok(outs.every((o) => o.emitter !== 'ember'))
  })

  it('mouthFunnel でも吐く動作として判定する', () => {
    const d = driver()
    d.run(1200, { filterDistance: NEAR })
    d.run(500, { filterDistance: FAR })
    d.run(400, { filterDistance: FAR, funnel: S.funnelThreshold + 0.1 })
    assert.equal(d.last.state, 'EXHALING')
  })

  it('吸う動作なしでは口をすぼめても EXHALING にならない', () => {
    const d = driver()
    const outs = d.run(2000, { filterDistance: FAR, pucker: PUCKER })
    assert.ok(outs.every((o) => o.state === 'IDLE' && o.emitter === 'none'))
  })

  it('吸った時間が短いと吐けない', () => {
    const d = driver()
    d.run(FSM_TIMING.confirmSamples * STEP_MS + 100, { filterDistance: NEAR })
    assert.equal(d.last.state, 'SMOKING')
    d.run(500, { filterDistance: FAR })
    const outs = d.run(1000, { filterDistance: FAR, pucker: PUCKER })
    assert.ok(outs.every((o) => o.state === 'IDLE'))
  })

  it('口すぼめを解除すると IDLE に戻り、1 回の吸う動作で吐くのは 1 回まで', () => {
    const d = driver()
    d.run(1200, { filterDistance: NEAR })
    d.run(500, { filterDistance: FAR })
    d.run(600, { filterDistance: FAR, pucker: PUCKER })
    assert.equal(d.last.state, 'EXHALING')
    d.run(400, { filterDistance: FAR, pucker: 0 })
    assert.equal(d.last.state, 'IDLE')
    assert.equal(d.last.exhaleReady, false)
    const again = d.run(1000, { filterDistance: FAR, pucker: PUCKER })
    assert.ok(again.every((o) => o.state === 'IDLE' && o.emitter === 'none'))
  })

  it('口をすぼめ続けても、最大時間を過ぎたら IDLE に戻る', () => {
    const d = driver()
    d.run(1200, { filterDistance: NEAR })
    d.run(500, { filterDistance: FAR })
    d.run(FSM_TIMING.maxExhaleMs + 1000, { filterDistance: FAR, pucker: PUCKER })
    assert.equal(d.last.state, 'IDLE')
  })

  it('離してから時間が経ちすぎると吐く権利を失う', () => {
    const d = driver()
    d.run(1200, { filterDistance: NEAR })
    d.run(FSM_TIMING.exhaleWindowMs + 800, { filterDistance: FAR })
    assert.equal(d.last.exhaleReady, false)
    d.run(600, { filterDistance: FAR, pucker: PUCKER })
    assert.equal(d.last.state, 'IDLE')
  })

  it('SMOKING 中にペンを見失うと煙を止め、タイムアウトで IDLE に戻る', () => {
    const d = driver()
    d.run(1200, { filterDistance: NEAR })
    const lost = d.run(1000, { penVisible: false, filterDistance: null })
    assert.ok(lost.every((o) => o.emitter !== 'ember'))
    assert.equal(d.last.state, 'IDLE')
  })

  it('SMOKING 中に顔を一時的に見失っても、短時間なら SMOKING を維持する', () => {
    const d = driver()
    d.run(1200, { filterDistance: NEAR })
    d.run(200, { face: false, filterDistance: null })
    assert.equal(d.last.state, 'SMOKING')
    d.run(1000, { face: false, filterDistance: null })
    assert.equal(d.last.state, 'IDLE')
    assert.ok(d.last.emitter === 'none')
  })

  it('EXHALING 中に顔を見失うと IDLE に戻る', () => {
    const d = driver()
    d.run(1200, { filterDistance: NEAR })
    d.run(500, { filterDistance: FAR })
    d.run(400, { filterDistance: FAR, pucker: PUCKER })
    assert.equal(d.last.state, 'EXHALING')
    const outs = d.run(800, { face: false, filterDistance: null })
    assert.equal(d.last.state, 'IDLE')
    assert.ok(outs.every((o) => o.emitter !== 'mouth'))
  })

  it('どの出力でも、口とタバコの両方から同時に煙を出さない', () => {
    const d = driver()
    const outs = [
      ...d.run(1200, { filterDistance: NEAR, pucker: PUCKER }),
      ...d.run(600, { filterDistance: FAR, pucker: PUCKER }),
      ...d.run(600, { filterDistance: NEAR, pucker: PUCKER }),
    ]
    for (const o of outs) {
      if (o.state === 'SMOKING') assert.notEqual(o.emitter, 'mouth')
      if (o.state === 'EXHALING') assert.notEqual(o.emitter, 'ember')
      if (o.state === 'IDLE') assert.equal(o.emitter, 'none')
    }
  })
})
