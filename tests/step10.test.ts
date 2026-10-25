import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { DEFAULT_ASH } from '../src/lib/ashTap.ts'
import {
  ASH_RESIDUAL,
  BURN_LIFETIME_MS,
  CigaretteLifeManager,
  EXIT_CONFIRM_MS,
} from '../src/lib/cigaretteLife.ts'
import { DEFAULT_CIGARETTE, burnRingFraction, placeCigarette } from '../src/lib/cigaretteRenderer.ts'
import { DEFAULT_FIRE, FireController, SOLO_CIGARETTE, type FireCigarette, type FireFrameInput } from '../src/lib/fireController.ts'
import { FLAME_DURATION_MS, FlameEffect, PREVIOUS_FLAME_DURATION_MS } from '../src/lib/flameEffect.ts'
import type { TrackedHand } from '../src/lib/handTracker.ts'
import { IgnitionStateMachine, DEFAULT_IGNITION } from '../src/lib/ignition.ts'
import { penFromAxis } from '../src/lib/penGeometry.ts'
import { DEFAULT_TRACKING, PenTrackingFilter } from '../src/lib/penTracking.ts'
import { PersonController, SOLO_PERSON_ID } from '../src/lib/personController.ts'
import { DEFAULT_SMOKE as DEFAULT_SMOKE_FOR_TEST, SmokeEffect, frontalAmount, resolveSmokeSource, type SmokeStyle } from '../src/lib/smokeEffect.ts'
import type { HandSample } from '../src/lib/snapDetector.ts'

const FRAME = 33
const realRandom = Math.random
beforeEach(() => {
  let seed = 3
  Math.random = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
})
afterEach(() => {
  Math.random = realRandom
})

type P = { x: number; y: number }
/** 手：人差し指の先端 index と親指の先端 thumb を指定（手の大きさ 100px、手首は離れた位置に固定） */
function hand(index: P, time: number, thumb: P = { x: index.x - 90, y: index.y + 70 }, key = 'right'): TrackedHand {
  const sample: HandSample = {
    time,
    thumbTip: thumb,
    indexTip: index,
    wrist: { x: 560, y: 460 },
    indexMcp: { x: 520, y: 380 },
    pinkyMcp: { x: 570, y: 385 },
    scale: 100,
  }
  return { key, side: 'right', landmarks: [], sample, sampleId: 0 }
}

/** 全長 200・太さ 16 のタバコ：吸い口 (100,300)、火側 (300,300)。上の表面は y = 292 */
function cig(dy = 0, p: Partial<FireCigarette> = {}): FireCigarette {
  return { key: SOLO_CIGARETTE, emberEnd: { x: 300, y: 300 + dy }, mouthEnd: { x: 100, y: 300 + dy }, length: 200, thickness: 16, ...p }
}

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
    cigarettes: [cig()],
    settings: { ...DEFAULT_FIRE, lighterEnabled: false },
    ...p,
  }
}

/** 着火して、灰を少し伸ばす（5 秒） */
function litWithAsh(fire: FireController, cigarettes = [cig()]): number {
  fire.lightAll(cigarettes.map((c) => c.key!))
  let t = 0
  for (let i = 0; i < 150; i++) fire.update(input((t += FRAME), { cigarettes }))
  return t
}

/** 人差し指で 1 回タップ：離れた位置（タバコの 50px 上）→ 表面 → 離れた位置。指先の x は火側の近く */
const FAR: P = { x: 260, y: 240 }
const NEAR: P = { x: 260, y: 291 }
function tap(fire: FireController, t: number, p: Partial<FireFrameInput> = {}) {
  const outs = []
  for (const at of [FAR, FAR, NEAR, FAR]) outs.push(fire.update(input((t += FRAME), { hands: [hand(at, t)], ...p })))
  return { outs, t }
}

describe('灰落とし（STEP 10）', () => {
  it('1. 着火済みのタバコを 2 回タップすると灰が落ちる（先端に少し残り、燃焼部分が光る）', () => {
    const fire = new FireController()
    let t = litWithAsh(fire)
    const before = fire.life.view(SOLO_CIGARETTE, t).ash
    assert.ok(before > ASH_RESIDUAL, '灰が伸びている')
    const first = tap(fire, t)
    assert.ok(first.outs.every((o) => o.ashEvent === null))
    t = first.t
    const second = tap(fire, t)
    const hit = second.outs.find((o) => o.ashEvent)
    assert.ok(hit, '2 回目で灰を落とす')
    assert.equal(hit!.ashEvent!.cigaretteKey, SOLO_CIGARETTE)
    const after = fire.life.view(SOLO_CIGARETTE, second.t)
    // 先端に少しだけ残る（同じフレームで伸びた分を除く）
    assert.ok(after.ash <= ASH_RESIDUAL + 0.001, `${after.ash}`)
    assert.ok(after.flash > 0, '燃焼部分が光る')
    assert.ok(fire.ash.particleCount > 0, '落ちる灰の粒子')
  })

  it('2. 1 回だけでは落ちない', () => {
    const fire = new FireController()
    const t = litWithAsh(fire)
    const { outs, t: t2 } = tap(fire, t)
    let last = outs[outs.length - 1]
    for (let i = 0; i < 40; i++) last = fire.update(input(t2 + (i + 1) * FRAME, { hands: [hand(FAR, t2 + (i + 1) * FRAME)] }))
    assert.ok(outs.every((o) => o.ashEvent === null) && last.ashEvent === null)
  })

  it('3. 指をゆっくり近づけただけ・近くに置いたままでは落ちない', () => {
    const fire = new FireController()
    let t = litWithAsh(fire)
    let events = 0
    for (let k = 0; k < 3; k++) {
      // 1 秒かけて近づき、0.6 秒とどまり、離れる
      for (let i = 0; i <= 30; i++) if (fire.update(input((t += FRAME), { hands: [hand({ x: 260, y: 240 + (51 * i) / 30 }, t)] })).ashEvent) events++
      for (let i = 0; i < 18; i++) if (fire.update(input((t += FRAME), { hands: [hand(NEAR, t)] })).ashEvent) events++
      if (fire.update(input((t += FRAME), { hands: [hand(FAR, t)] })).ashEvent) events++
    }
    assert.equal(events, 0)
  })

  it('3b. ゆっくり近づけてから素早く離す動きを 2 回しても落ちない（近づく速さ）', () => {
    const fire = new FireController()
    let t = litWithAsh(fire)
    let events = 0
    for (let k = 0; k < 2; k++) {
      // 約 0.33 秒かけて離れた位置から表面へ（叩く速さの下限より遅い）→ すぐ離す
      for (let i = 0; i <= 10; i++) if (fire.update(input((t += FRAME), { hands: [hand({ x: 260, y: 262 + (29 * i) / 10 }, t)] })).ashEvent) events++
      if (fire.update(input((t += FRAME), { hands: [hand(FAR, t)] })).ashEvent) events++
    }
    assert.equal(events, 0)
  })

  it('4. タバコ（ペン）を動かしただけ（指は止まったまま）では落ちない', () => {
    const fire = new FireController()
    let t = litWithAsh(fire)
    let events = 0
    // 指は y = 270 に固定し、タバコを素早く上下させて指に当てる
    for (let k = 0; k < 4; k++) {
      for (const dy of [40, 40, -20, 40]) {
        const c = [cig(dy)]
        if (fire.update(input((t += FRAME), { hands: [hand({ x: 260, y: 270 }, t)], cigarettes: c })).ashEvent) events++
      }
    }
    assert.equal(events, 0)
  })

  it('5. 未着火のタバコの灰は落ちない（灰も伸びない）', () => {
    const fire = new FireController()
    let t = 0
    for (let i = 0; i < 150; i++) fire.update(input((t += FRAME)))
    assert.equal(fire.life.view(SOLO_CIGARETTE, t).ash, 0)
    const a = tap(fire, t)
    const b = tap(fire, a.t)
    assert.ok([...a.outs, ...b.outs].every((o) => o.ashEvent === null))
  })

  it('6. 落ちる灰の粒子は重力で下へ落ち、約 2 秒で消える（fps によらない）', () => {
    for (const step of [16, 50]) {
      const fire = new FireController()
      let t = litWithAsh(fire)
      fire.requestAshDrop()
      fire.update(input((t += step)))
      const start = fire.ash.snapshot()
      assert.ok(start.length > 0)
      const y0 = start.reduce((s, p) => s + p.y, 0) / start.length
      for (let i = 0; i < 400 / step; i++) fire.update(input((t += step)))
      const mid = fire.ash.snapshot()
      assert.ok(mid.reduce((s, p) => s + p.y, 0) / mid.length > y0 + 20, '下へ落ちる')
      for (let i = 0; i < 2000 / step; i++) fire.update(input((t += step)))
      assert.equal(fire.ash.particleCount, 0, `step=${step}`)
    }
  })

  it('複数人：別の人の指では灰が落ちない（手の持ち主のタバコだけ）', () => {
    const fire = new FireController()
    const a = cig(0, { key: '1' })
    let t = litWithAsh(fire, [a])
    const owners = new Map<string, string | null>([['right', '2']])
    let events = 0
    for (let k = 0; k < 3; k++) {
      const r = tap(fire, t, { cigarettes: [a], handOwners: owners })
      t = r.t
      events += r.outs.filter((o) => o.ashEvent).length
    }
    assert.equal(events, 0)
    owners.set('right', '1')
    for (let k = 0; k < 2; k++) {
      const r = tap(fire, t, { cigarettes: [a], handOwners: owners })
      t = r.t
      events += r.outs.filter((o) => o.ashEvent).length
    }
    assert.equal(events, 1)
  })

  it('灰は着火中に時間で伸び、上限で止まる（全長の 12%）', () => {
    const life = new CigaretteLifeManager()
    let t = 0
    const c = { key: 'a', ends: [{ x: 100, y: 300 }, { x: 300, y: 300 }] as [P, P], measured: true, lit: true }
    for (let i = 0; i < 1000; i++) life.update((t += FRAME), 640, 480, [c], DEFAULT_ASH.growthRate)
    assert.ok(Math.abs(life.view('a', t).ash - 0.12) < 1e-9)
  })
})

describe('炎の表示時間（STEP 10）', () => {
  it('7. 炎の表示時間は変更前（2.5 秒）のちょうど 2 倍（5 秒）', () => {
    assert.equal(PREVIOUS_FLAME_DURATION_MS, 2500)
    assert.equal(FLAME_DURATION_MS, PREVIOUS_FLAME_DURATION_MS * 2)
    const flames = new FlameEffect()
    flames.spawn('snap', { x: 0, y: 0 }, 50, 1000, 'right')
    assert.equal(flames.remaining(1000)[0].durationMs, 5000)
  })

  it('8. 炎の残り時間と着火判定に使える時間が一致する（見えている間だけ着火できる）', () => {
    const flames = new FlameEffect()
    flames.spawn('snap', { x: 0, y: 0 }, 50, 0, 'right')
    const end = FLAME_DURATION_MS
    assert.equal(flames.remaining(end - 100)[0].remainingMs, 100)
    assert.equal(flames.active(end - 1).length, 1)
    assert.equal(flames.active(end).length, 0)
    assert.equal(flames.remaining(end).length, 0)
    // 着火判定：消える直前に当てれば着火、消えた後なら着火しない
    const lit = new IgnitionStateMachine()
    for (let i = 0; i < 6; i++) {
      const now = end - 200 + i * 33
      const pos = flames.active(now).map((f) => f.position)
      lit.update({ now, emberEnd: pos[0] ?? { x: 0, y: 0 }, mouthEnd: { x: -200, y: 0 }, cigaretteLength: 200, flames: pos }, DEFAULT_IGNITION)
    }
    assert.equal(lit.current, 'LIT')
    const late = new IgnitionStateMachine()
    for (let i = 0; i < 6; i++) {
      const now = end + i * 33
      late.update({ now, emberEnd: { x: 0, y: 0 }, mouthEnd: { x: -200, y: 0 }, cigaretteLength: 200, flames: flames.active(now).map((f) => f.position) }, DEFAULT_IGNITION)
    }
    assert.equal(late.current, 'UNLIT')
  })

  it('9. 着火ジェスチャーの炎は 5 秒間、人差し指の先端に追従する', () => {
    const fire = new FireController()
    let t = 0
    const thumb = { x: 400, y: 150 }
    for (let i = 0; i < 4; i++) fire.update(input((t += FRAME), { hands: [hand({ x: 402, y: 152 }, t, thumb)], cigarettes: [] }))
    const out = fire.update(input((t += FRAME), { hands: [hand({ x: 400, y: 60 }, t, thumb)], cigarettes: [] }))
    assert.ok(out.snapEvent)
    let last = out
    for (let i = 0; i < 100; i++) {
      const x = 400 + i
      last = fire.update(input((t += FRAME), { hands: [hand({ x, y: 60 }, t, { x, y: 150 })], cigarettes: [] }))
      assert.equal(last.flames.length, 1, `${i}`)
      assert.ok(Math.abs(last.flames[0].position.x - x) < 1e-6)
    }
    // 5 秒たったら消える
    const gone = fire.update(input(out.snapEvent!.time + FLAME_DURATION_MS + 50, { hands: [hand({ x: 500, y: 60 }, 0, { x: 500, y: 150 })], cigarettes: [] }))
    assert.equal(gone.flames.length, 0)
  })
})

describe('顔の向きに応じた吐煙（STEP 10）', () => {
  const STYLE: SmokeStyle = { amount: 1, speed: 1, spread: 1, density: 0.7 }
  const base = { emberEnd: null, cigaretteThickness: 0, frameWidth: 640 }
  /** 発生直後 0.3 秒の粒子の横方向の分布 */
  function spread(facing: number, previousSide = 1) {
    const src = resolveSmokeSource('mouth', { ...base, mouth: { center: { x: 300, y: 200 }, width: 50, facing } }, previousSide)!
    const smoke = new SmokeEffect()
    for (let t = 0; t <= 600; t += 16) smoke.update(t, src, STYLE)
    const ps = smoke.snapshot()
    const dx = ps.map((p) => p.x - 300)
    return { src, mean: dx.reduce((a, b) => a + b, 0) / dx.length, left: dx.filter((d) => d < 0).length, right: dx.filter((d) => d > 0).length, max: Math.max(...dx.map(Math.abs)) }
  }

  it('10. 正面向きでは口元の中央から左右対称に広がる（横へ勢いよく流れない）', () => {
    const front = spread(0)
    assert.equal(front.src.frontal, 1)
    const side = spread(0.6)
    assert.ok(Math.abs(front.mean) < side.mean * 0.15, `正面 ${front.mean} / 横 ${side.mean}`)
    assert.ok(Math.min(front.left, front.right) / Math.max(front.left, front.right) > 0.7, `左 ${front.left} 右 ${front.right}`)
    // 直前の向きが左でも右でも、正面なら同じく中央
    assert.ok(Math.abs(spread(0, -1).mean) < side.mean * 0.15)
  })

  it('10b. 正面の煙は時間とともに大きく膨らむ（小さく生まれる）', () => {
    const src = resolveSmokeSource('mouth', { ...base, mouth: { center: { x: 300, y: 200 }, width: 50, facing: 0 } })!
    const smoke = new SmokeEffect()
    smoke.update(0, src, STYLE)
    smoke.update(16, src, STYLE)
    const young = smoke.snapshot()
    for (let t = 32; t < 1200; t += 16) smoke.update(t, null, STYLE)
    const old = smoke.snapshot()
    const avg = (a: { radius: number }[]) => a.reduce((s, p) => s + p.radius, 0) / a.length
    assert.ok(avg(old) > avg(young) * 4)
  })

  it('11. 横向きでは STEP 3.2 からの横流れを維持する', () => {
    const right = spread(0.6)
    const left = spread(-0.6)
    assert.equal(right.src.frontal, 0)
    assert.ok(right.mean > 20 && left.mean < -20)
    assert.ok(right.src.direction.x > 0.9 && left.src.direction.x < -0.9)
  })

  it('12. 斜め向きでは正面と横向きを連続に補間し、向きが急に変わらない', () => {
    let prev = frontalAmount(0)
    for (let f = 0.01; f <= 1; f += 0.01) {
      const v = frontalAmount(f)
      assert.ok(v <= prev + 1e-12, '|向き| に対して単調に減る')
      assert.ok(prev - v < 0.06, `0.01 の変化で急に変わらない（${f.toFixed(2)}）`)
      assert.equal(frontalAmount(-f), v, '左右対称')
      prev = v
    }
    const oblique = spread(0.2)
    assert.ok(oblique.src.frontal > 0 && oblique.src.frontal < 1)
    assert.ok(oblique.mean > Math.abs(spread(0).mean) && oblique.mean < spread(0.6).mean)
  })

  it('12b. 顔の向きは時間で平滑化してから使う（1 フレームで正面 → 横に飛ばない）', () => {
    const persons = new PersonController()
    const mouthAt = (facing: number) => ({ center: { x: 300, y: 200 }, width: 40, height: 15, faceScale: 80, facing, pucker: 0, funnel: 0, sampleId: 0, detectedAt: 0, debugPoints: [] })
    const track = (now: number, facing: number) =>
      persons.track({ now, mode: 1, measuredPens: [], mouths: [mouthAt(facing)], mouthsFresh: true, hands: [], tracking: DEFAULT_TRACKING, cigarette: DEFAULT_CIGARETTE, showCigarette: true })
    const smokeIn = (now: number) => ({ now, frameWidth: 640, frameHeight: 480, settings: { ...DEFAULT_SMOKE_FOR_TEST }, isLit: () => false, testBurst: true })
    let frame = track(0, 0)
    persons.updateSmoke(frame, smokeIn(0))
    frame = track(33, 0.8)
    const s = persons.updateSmoke(frame, smokeIn(33))[0]
    assert.ok(s.facing! > 0 && s.facing! < 0.3, `平滑化後 ${s.facing}`)
  })
})


describe('60 秒でシケモク・画面外から戻すと新品（STEP 10）', () => {
  const ends = (x0 = 200, x1 = 400, y = 240): [P, P] => [{ x: x0, y }, { x: x1, y }]
  function burn(life: CigaretteLifeManager, ms: number, t: number, c: { key: string; lit: boolean; measured?: boolean; ends?: [P, P] }[]) {
    const end = t + ms
    while (t < end) life.update((t += FRAME), 640, 480, c.map((x) => ({ ends: ends(), measured: true, ...x })), 0.006)
    return t
  }

  it('13. 着火から累積 60 秒で BUTT になり、火が消えて再着火できない', () => {
    const fire = new FireController()
    fire.lightAll([SOLO_CIGARETTE])
    let t = 0
    let out
    let buttAt = -1
    while (t < BURN_LIFETIME_MS + 2000) {
      out = fire.update(input((t += FRAME)))
      if (buttAt < 0 && out.lives.get(SOLO_CIGARETTE)!.state === 'BUTT') buttAt = t
      if (t < BURN_LIFETIME_MS - 100) assert.notEqual(out.lives.get(SOLO_CIGARETTE)!.state, 'BUTT')
    }
    assert.ok(buttAt >= BURN_LIFETIME_MS && buttAt < BURN_LIFETIME_MS + 100, `${buttAt}`)
    assert.equal(out!.ignition.state, 'UNLIT', 'シケモクは火が消える')
    // 炎を当てても・手動着火しても着火しない（ほかの経路で着火状態になっても次のフレームで消える）
    fire.lightAll([SOLO_CIGARETTE])
    assert.equal(fire.ignition(SOLO_CIGARETTE).current, 'UNLIT')
    fire.ignition(SOLO_CIGARETTE).light()
    assert.equal(fire.update(input((t += FRAME))).ignition.state, 'UNLIT')
  })

  it('14. 未着火の間は燃焼時間が進まない。見失っている間も止まる', () => {
    const life = new CigaretteLifeManager()
    let t = burn(life, 10_000, 0, [{ key: 'a', lit: false }])
    assert.equal(life.view('a', t).burnMs, 0)
    assert.equal(life.state('a'), 'NEW')
    t = burn(life, 10_000, t, [{ key: 'a', lit: true }])
    const burned = life.view('a', t).burnMs
    assert.ok(Math.abs(burned - 10_000) < 100)
    assert.equal(life.state('a'), 'BURNING')
    // 見失っている（measured = false・リストに無い）間は止まる
    t = burn(life, 5_000, t, [{ key: 'a', lit: true, measured: false }])
    for (let i = 0; i < 100; i++) life.update((t += FRAME), 640, 480, [], 0.006)
    assert.equal(life.view('a', t).burnMs, burned)
  })

  it('15. 画面の中央で一時的に見失っても、シケモクは新品に戻らない（向きが逆になっても）', () => {
    const life = new CigaretteLifeManager()
    life.forceButt('a')
    let t = burn(life, 500, 0, [{ key: 'a', lit: false }])
    for (let i = 0; i < 150; i++) life.update((t += FRAME), 640, 480, [], 0)
    assert.equal(life.view('a', t).exitCandidate, false)
    t = burn(life, 500, t, [{ key: 'a', lit: false, ends: [{ x: 400, y: 240 }, { x: 200, y: 240 }] }])
    assert.equal(life.state('a'), 'BUTT')
  })

  it('16. 画面の端から外へ出たと推定し、一定時間たってから再び映ると新品になる', () => {
    const life = new CigaretteLifeManager()
    life.forceButt('a')
    let t = 0
    // 右の端へ動いていき、端で消える
    for (let i = 0; i < 10; i++) life.update((t += FRAME), 640, 480, [{ key: 'a', lit: false, measured: true, ends: [{ x: 520 + i * 10, y: 240 }, { x: 600 + i * 4, y: 240 }] }], 0)
    life.update((t += FRAME), 640, 480, [{ key: 'a', lit: false, measured: true, ends: [{ x: 615, y: 240 }, { x: 638, y: 240 }] }], 0)
    for (let i = 0; i < 5; i++) life.update((t += FRAME), 640, 480, [], 0)
    assert.equal(life.view('a', t).exitCandidate, true)
    // 確定の前に戻ってきた：シケモクのまま
    const quick = new CigaretteLifeManager()
    quick.forceButt('a')
    let q = 0
    quick.update((q += FRAME), 640, 480, [{ key: 'a', lit: false, measured: true, ends: [{ x: 615, y: 240 }, { x: 638, y: 240 }] }], 0)
    quick.update((q += 200), 640, 480, [], 0)
    quick.update((q += 200), 640, 480, [{ key: 'a', lit: false, measured: true, ends: ends() }], 0)
    assert.equal(quick.state('a'), 'BUTT')
    // 確定の後に戻ってきた：新品
    const until = t + EXIT_CONFIRM_MS
    while (t < until) life.update((t += FRAME), 640, 480, [], 0)
    assert.equal(life.view('a', t).exited, true)
    const events = life.update((t += FRAME), 640, 480, [{ key: 'a', lit: false, measured: true, ends: ends() }], 0)
    assert.deepEqual(events, [{ key: 'a', kind: 'renewed' }])
    assert.equal(life.state('a'), 'NEW')
    assert.equal(life.view('a', t).burnMs, 0)
  })

  it('17. ペンの追跡 ID が変わっても（1 人モード）同じ人物のタバコとして扱い、新品にならない', () => {
    const persons = new PersonController()
    const fire = new FireController()
    const det = (x: number) =>
      penFromAxis({ center: { x, y: 240 }, u: { x: 1, y: 0 }, length: 150, thickness: 12, area: 1800, segments: [], frameWidth: 640, frameHeight: 480 }, false)
    let t = 0
    const step = (pens: ReturnType<typeof det>[]) => {
      t += FRAME
      const frame = persons.track({ now: t, mode: 1, measuredPens: pens, mouths: [], mouthsFresh: true, hands: [], tracking: DEFAULT_TRACKING, cigarette: DEFAULT_CIGARETTE, showCigarette: true })
      fire.update(
        input(t, {
          cigarettes: frame.persons
            .filter((p) => p.placement)
            .map((p) => ({ key: String(p.id), emberEnd: p.placement!.emberEnd, mouthEnd: p.placement!.mouthEnd, length: p.placement!.length, thickness: p.placement!.thickness, ends: p.pen!.endpoints, measured: p.pen!.status === 'measured' })),
        }),
      )
      return frame
    }
    const first = step([det(300)])
    const firstPenId = first.persons[0].pen!.id
    fire.forceButt([String(SOLO_PERSON_ID)])
    for (let i = 0; i < 30; i++) step([])
    // 別の位置で再検出（追跡 ID が変わる）
    let frame = step([det(330)])
    for (let i = 0; i < 5; i++) frame = step([det(330)])
    assert.equal(frame.persons[0].id, SOLO_PERSON_ID)
    assert.notEqual(frame.persons[0].pen!.id, firstPenId, '追跡 ID は変わった')
    assert.equal(fire.life.state(String(SOLO_PERSON_ID)), 'BUTT')
  })

  it('18. 複数人の燃焼時間は混ざらない', () => {
    const life = new CigaretteLifeManager()
    let t = burn(life, 20_000, 0, [{ key: '1', lit: true }, { key: '2', lit: false }])
    t = burn(life, 10_000, t, [{ key: '1', lit: true }, { key: '2', lit: true }])
    assert.ok(Math.abs(life.view('1', t).burnMs - 30_000) < 200)
    assert.ok(Math.abs(life.view('2', t).burnMs - 10_000) < 200)
  })

  it('カメラの切り替え（追跡のリセット）ではシケモクのままで、リセット直後に見えなくても退出にしない', () => {
    const fire = new FireController()
    fire.forceButt([SOLO_CIGARETTE])
    let t = 0
    // 端で見えていた直後に切り替え
    fire.update(input((t += FRAME), { cigarettes: [cig(0, { ends: [{ x: 610, y: 240 }, { x: 638, y: 240 }] })] }))
    fire.resetTracking()
    for (let i = 0; i < 60; i++) fire.update(input((t += FRAME), { cigarettes: [] }))
    const out = fire.update(input((t += FRAME)))
    assert.equal(out.lives.get(SOLO_CIGARETTE)!.state, 'BUTT')
  })

  it('STEP 11：燃えても CG の全長・火側の端は変わらない（焦げは CG で覆う。burnRingFraction は焦げの位置）', () => {
    const pen = new PenTrackingFilter().update(
      penFromAxis({ center: { x: 320, y: 240 }, u: { x: 1, y: 0 }, length: 200, thickness: 12, area: 2400, segments: [], frameWidth: 640, frameHeight: 480 }, false),
      0,
      DEFAULT_TRACKING,
    )!
    const fresh = placeCigarette(pen, DEFAULT_CIGARETTE, { x: 1, y: 0 })
    assert.ok(Math.abs(fresh.emberEnd.x - 420) < 1e-6, '火側の端は CG の端')
    // 焦げの位置：シケモクでフィルター（27%）の少し先まで
    const ratio = burnRingFraction('cigarette', 1)
    assert.ok(ratio > 0.27 && ratio < 0.4, `${ratio}`)
    assert.equal(burnRingFraction('pipe', 1), 1, 'パイプは焦げない')
  })
})

describe('着火ジェスチャーと灰落としの競合（STEP 10）', () => {
  it('29. 灰落としの途中で着火ジェスチャーが成立したら灰落としの候補を取り消し、同じフレームで両方は起きない', () => {
    const fire = new FireController()
    let t = litWithAsh(fire)
    // 1 回目のタップ（有効）
    t = tap(fire, t).t
    // 親指と人差し指をくっつけて（タバコから離れた位置）、素早く離す → 着火ジェスチャー
    const thumb = { x: 260, y: 160 }
    for (let i = 0; i < 4; i++) fire.update(input((t += FRAME), { hands: [hand({ x: 262, y: 162 }, t, thumb)] }))
    const snapped = fire.update(input((t += FRAME), { hands: [hand(FAR, t, thumb)] }))
    assert.ok(snapped.snapEvent, '着火ジェスチャー')
    assert.equal(snapped.ashEvent, null)
    // 直後の 2 回目のタップでは灰を落とさない（1 回目は取り消されている）
    let events = 0
    for (const at of [FAR, NEAR, FAR]) if (fire.update(input((t += FRAME), { hands: [hand(at, t, thumb)] })).ashEvent) events++
    assert.equal(events, 0)
  })

  it('29c. 着火ジェスチャーの途中（親指と人差し指の接触中）は、成立しなくても灰落としの候補を取り消す', () => {
    const fire = new FireController()
    let t = litWithAsh(fire)
    // タップの制限時間を長くして、取り消し以外では 1 回目のタップが消えないようにする
    const settings = { ...DEFAULT_FIRE, lighterEnabled: false, ash: { ...DEFAULT_ASH, tapWindowMs: 5000 } }
    t = tap(fire, t, { settings }).t
    // 親指と人差し指を接触させてから、ゆっくり開く（着火ジェスチャーは失敗）。人差し指はタバコから離れた位置
    const thumb = { x: 260, y: 236 }
    for (let i = 0; i < 4; i++) fire.update(input((t += FRAME), { hands: [hand({ x: 260, y: 240 }, t, thumb)], settings }))
    for (let i = 1; i <= 25; i++) fire.update(input((t += FRAME), { hands: [hand({ x: 260 + i * 3, y: 240 }, t, thumb)], settings }))
    const second = tap(fire, t, { settings })
    assert.equal(fire.snap.successes, 0)
    assert.ok(second.outs.every((o) => o.ashEvent === null))
  })

  it('29b. タバコをつまんだ親指と人差し指で叩いても、着火ジェスチャーにはならない', () => {
    const fire = new FireController()
    let t = litWithAsh(fire)
    let snaps = 0
    // 親指と人差し指がタバコの上でくっつく（つまんでいる）→ 人差し指を離して叩く
    const thumb = { x: 250, y: 300 }
    for (let i = 0; i < 4; i++) if (fire.update(input((t += FRAME), { hands: [hand({ x: 252, y: 298 }, t, thumb)] })).snapEvent) snaps++
    for (const at of [FAR, NEAR, FAR, FAR]) if (fire.update(input((t += FRAME), { hands: [hand(at, t, thumb)] })).snapEvent) snaps++
    assert.equal(snaps, 0)
  })
})
