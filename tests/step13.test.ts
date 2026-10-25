import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { DEFAULT_FIRE, FireController, SOLO_CIGARETTE, type FireCigarette, type FireFrame, type FireFrameInput } from '../src/lib/fireController.ts'
import { DOUSE_FADE_MS, FlameEffect } from '../src/lib/flameEffect.ts'
import type { TrackedHand } from '../src/lib/handTracker.ts'
import type { HandSample } from '../src/lib/snapDetector.ts'
import { WAVE_MIN_SPEED, WaveDetector } from '../src/lib/waveDetector.ts'

const FRAME = 33
const realRandom = Math.random
beforeEach(() => {
  let seed = 11
  Math.random = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
})
afterEach(() => {
  Math.random = realRandom
})

type P = { x: number; y: number }
/** 2D の手（手の大きさ 100px）：親指の先端 at、人差し指の先端は at から d × 100px 上（d は親指と人差し指の正規化距離） */
function sample2(at: P, d: number, time: number): HandSample {
  return {
    time,
    thumbTip: at,
    indexTip: { x: at.x, y: at.y - d * 100 },
    wrist: { x: at.x + 60, y: at.y + 115 },
    indexMcp: { x: at.x + 30, y: at.y + 15 },
    pinkyMcp: { x: at.x + 95, y: at.y + 25 },
    scale: 100,
  }
}
function hand2(at: P, d: number, time: number, key = 'right'): TrackedHand {
  return { key, side: key === 'left' ? 'left' : 'right', landmarks: [], sample: sample2(at, d, time), sampleId: 0 }
}
function cig(p: Partial<FireCigarette> = {}): FireCigarette {
  return { key: SOLO_CIGARETTE, emberEnd: { x: 300, y: 300 }, mouthEnd: { x: 100, y: 300 }, length: 200, thickness: 16, ...p }
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

const AWAY: P = { x: 480, y: 160 }
const LEFT_AWAY: P = { x: 120, y: 120 }
/** 指パッチンで炎を出す（他の手 others は開いたまま映っている） */
function snap(fire: FireController, t: number, key = 'right', at = AWAY, others: (time: number) => TrackedHand[] = () => []) {
  for (let i = 0; i < 3; i++) fire.update(input((t += FRAME), { hands: [hand2(at, 0.15, t, key), ...others(t)] }))
  const out = fire.update(input((t += FRAME), { hands: [hand2(at, 0.8, t, key), ...others(t)] }))
  assert.ok(out.snapEvent, '炎が出る')
  return t
}

/** 手全体を動かす：offset(経過 ms) の位置へ、durationMs の間（指は開いたまま） */
function move(fire: FireController, t: number, durationMs: number, offset: (ms: number) => P, p: Partial<FireFrameInput> = {}, key = 'right', base = AWAY, others: (time: number) => TrackedHand[] = () => []) {
  const start = t
  const outs: FireFrame[] = []
  while (t < start + durationMs) {
    t += FRAME
    const o = offset(t - start)
    outs.push(fire.update(input(t, { hands: [hand2({ x: base.x + o.x, y: base.y + o.y }, 0.8, t, key), ...others(t)], ...p })))
  }
  return { outs, t, waved: outs.some((o) => o.waveEvent) }
}
const shake = (hz: number, amp: number, axis: 'x' | 'y' = 'x') => (ms: number) => {
  const v = amp * Math.sin((2 * Math.PI * hz * ms) / 1000)
  return axis === 'x' ? { x: v, y: 0 } : { x: 0, y: v }
}
const handFlames = (fire: FireController, t: number) => fire.flames.active(t).filter((f) => f.handKey !== null)

describe('STEP 13：手を振ると指先の火が消える', () => {
  it('炎を出した手を左右に振ると、その炎が消える（フェードアウトの後に表示も消える）', () => {
    const fire = new FireController()
    let t = snap(fire, 0)
    assert.equal(handFlames(fire, t).length, 1)
    const r = move(fire, t, 700, shake(3, 60))
    t = r.t
    assert.ok(r.waved, '手を振った')
    assert.equal(r.outs.find((o) => o.waveEvent)!.waveEvent!.handKey, 'right')
    assert.equal(handFlames(fire, t).length, 0, '着火判定に使う炎から外れる')
    fire.update(input(t + DOUSE_FADE_MS + FRAME, { hands: [hand2(AWAY, 0.8, t + DOUSE_FADE_MS + FRAME)] }))
    assert.equal(fire.flames.remaining(t + DOUSE_FADE_MS + FRAME).length, 0, '表示からも消える')
  })

  it('縦に振っても消える', () => {
    const fire = new FireController()
    const t = snap(fire, 0)
    assert.ok(move(fire, t, 700, shake(3, 60, 'y')).waved)
    assert.equal(handFlames(fire, t + 700).length, 0)
  })

  it('消した炎ではタバコに着火しない（消えかけの炎を火側の端へ運んでも）', () => {
    const fire = new FireController()
    let t = snap(fire, 0)
    t = move(fire, t, 700, shake(3, 60)).t
    // すぐに人差し指の先端を火側の端へ
    const target = { x: 300, y: 380 }
    for (let i = 1; i <= 4; i++) {
      const at = { x: AWAY.x + ((target.x - AWAY.x) * i) / 4, y: AWAY.y + ((target.y - AWAY.y) * i) / 4 }
      fire.update(input((t += FRAME), { hands: [hand2(at, 0.8, t)] }))
    }
    assert.equal(fire.ignition(SOLO_CIGARETTE).current, 'UNLIT')
  })

  it('炎をタバコへ運ぶ動き（一方向に動かすだけ）では消えず、着火できる', () => {
    const fire = new FireController()
    const t = snap(fire, 0)
    // 0.3 秒で (480,160) → (300,380)
    const r = move(fire, t, 300, (ms) => ({ x: (-180 * Math.min(ms, 300)) / 300, y: (220 * Math.min(ms, 300)) / 300 }))
    assert.equal(r.waved, false)
    for (let i = 0; i < 4; i++) fire.update(input(r.t + (i + 1) * FRAME, { hands: [hand2({ x: 300, y: 380 }, 0.8, r.t + (i + 1) * FRAME)] }))
    assert.equal(fire.ignition(SOLO_CIGARETTE).current, 'LIT')
  })

  it('ゆっくり揺らす・小さく震えるだけでは消えない', () => {
    // ゆっくり（0.6 回/秒、振れ幅 ±50px。速さの最大 2π × 0.6 × 0.5 ≒ 1.9 < WAVE_MIN_SPEED）
    assert.ok(2 * Math.PI * 0.6 * 0.5 < WAVE_MIN_SPEED)
    const a = new FireController()
    const slow = move(a, snap(a, 0), 3000, shake(0.6, 50))
    assert.equal(slow.waved, false)
    assert.equal(handFlames(a, slow.t).length, 1, '炎は残っている')
    // 小さく震える（5 回/秒、±10px。振れ幅が WAVE_MIN_SWING より小さい）
    const b = new FireController()
    const jitter = move(b, snap(b, 0), 2000, shake(5, 10))
    assert.equal(jitter.waved, false)
    assert.equal(handFlames(b, jitter.t).length, 1, '炎は残っている')
  })

  it('指パッチン（指だけの動き）を繰り返しても、手を振ったことにならない', () => {
    const det = new WaveDetector()
    let t = 0
    let waved = 0
    for (let k = 0; k < 6; k++) {
      for (const d of [0.15, 0.15, 0.8, 0.8]) if (det.update('right', sample2(AWAY, d, (t += FRAME)))) waved++
    }
    assert.equal(waved, 0)
  })

  it('振った手の炎だけが消える（もう一方の手の炎は残る）', () => {
    const fire = new FireController()
    const still = (time: number) => [hand2(LEFT_AWAY, 0.8, time, 'left')]
    let t = snap(fire, 0, 'left', LEFT_AWAY)
    t = snap(fire, t, 'right', AWAY, still)
    assert.equal(handFlames(fire, t).length, 2)
    const r = move(fire, t, 700, shake(3, 60), {}, 'right', AWAY, still)
    assert.ok(r.waved)
    const left = fire.flames.active(r.t).filter((f) => f.handKey === 'left')
    assert.equal(left.length, 1)
    assert.equal(handFlames(fire, r.t).length, 1)
  })

  it('設定を OFF にすると、振っても消えない', () => {
    const fire = new FireController()
    const t = snap(fire, 0)
    const r = move(fire, t, 700, shake(3, 60), { settings: { ...DEFAULT_FIRE, lighterEnabled: false, waveExtinguish: false } })
    assert.equal(r.waved, false)
    assert.equal(handFlames(fire, r.t).length, 1)
  })

  it('消した後も、指パッチンでまた炎を出せる', () => {
    const fire = new FireController()
    let t = snap(fire, 0)
    t = move(fire, t, 700, shake(3, 60)).t
    t += 700
    snap(fire, t)
    assert.equal(handFlames(fire, t + 4 * FRAME).length, 1)
  })

  it('ライターの炎（手に付いていない炎）は消さない', () => {
    const flames = new FlameEffect()
    flames.spawn('manual', { x: 100, y: 100 }, 50, 0, 'right')
    flames.setLighter({ x: 300, y: 300 }, 30, 0)
    assert.equal(flames.douse('right', 10), true)
    assert.deepEqual(flames.active(20).map((f) => f.source), ['lighter'])
    assert.equal(flames.douse('right', 30), false, '同じ炎を 2 回消さない')
  })
})
