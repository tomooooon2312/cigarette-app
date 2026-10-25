import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  BASE_EMIT_RATE,
  MAX_PARTICLES,
  SMOKE_PRESETS,
  SmokeEffect,
  resolveSmokeSource,
  type SmokeSource,
  type SmokeStyle,
} from '../src/lib/smokeEffect.ts'

const STYLE: SmokeStyle = { amount: 1, speed: 1, spread: 1, density: 0.7 }
const MOUTH: SmokeSource = {
  kind: 'mouth',
  position: { x: 300, y: 200 },
  scale: 20,
  direction: { x: 1, y: 0 },
  frontal: 0,
}
const EMBER: SmokeSource = { kind: 'ember', position: { x: 300, y: 200 }, scale: 10, direction: { x: 0, y: -1 }, frontal: 0 }

// 乱数を固定して結果を再現可能にする
const realRandom = Math.random
beforeEach(() => {
  let seed = 42
  Math.random = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
})
afterEach(() => {
  Math.random = realRandom
})

/** fps で ms の間 update を回す */
function run(effect: SmokeEffect, fps: number, fromMs: number, ms: number, source: SmokeSource | null, style = STYLE) {
  const step = 1000 / fps
  let t = fromMs
  for (; t < fromMs + ms; t += step) effect.update(t, source, style)
  return t
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

describe('SmokeEffect', () => {
  it('量 100% のとき、発生数は deltaTime に比例する（1 秒で約 BASE_EMIT_RATE 個）', () => {
    const e = new SmokeEffect()
    run(e, 60, 0, 1000, MOUTH)
    assert.ok(Math.abs(e.particleCount - BASE_EMIT_RATE.mouth) <= 3, `count=${e.particleCount}`)
  })

  it('量 300% では 100% の約 3 倍（上限以内）', () => {
    const e1 = new SmokeEffect()
    const e3 = new SmokeEffect()
    run(e1, 60, 0, 500, MOUTH)
    run(e3, 60, 0, 500, MOUTH, { ...STYLE, amount: 3 })
    const ratio = e3.particleCount / e1.particleCount
    assert.ok(ratio > 2.7 && ratio < 3.3, `ratio=${ratio}`)
  })

  it('タバコ側の発生数は口元より少ない', () => {
    const em = new SmokeEffect()
    const mo = new SmokeEffect()
    run(em, 60, 0, 1000, EMBER)
    run(mo, 60, 0, 1000, MOUTH)
    assert.ok(em.particleCount < mo.particleCount / 4)
  })

  it('粒子数は MAX_PARTICLES を超えない', () => {
    const e = new SmokeEffect()
    run(e, 60, 0, 3000, MOUTH, { ...STYLE, amount: 3 })
    assert.ok(e.particleCount <= MAX_PARTICLES)
    // 上限に張り付く（そのフレームで寿命が尽きた数個だけ下回ることがある）
    assert.ok(e.particleCount >= MAX_PARTICLES * 0.97, `count=${e.particleCount}`)
  })

  it('source が null なら新しい粒子を出さず、既存の粒子は寿命で消える', () => {
    const e = new SmokeEffect()
    let t = run(e, 60, 0, 300, MOUTH)
    const before = e.particleCount
    t = run(e, 60, t, 100, null)
    assert.ok(e.particleCount <= before)
    run(e, 60, t, 4000, null)
    assert.equal(e.particleCount, 0)
  })

  it('fps が違っても煙の動き（平均位置・大きさ）はほぼ同じ（deltaTime による更新）', () => {
    const results = [24, 60, 144].map((fps) => {
      const e = new SmokeEffect()
      const t = run(e, fps, 0, 400, MOUTH)
      run(e, fps, t, 600, null)
      const ps = e.snapshot()
      return { fps, x: mean(ps.map((p) => p.x)), y: mean(ps.map((p) => p.y)), r: mean(ps.map((p) => p.radius)) }
    })
    const [a, b, c] = results
    for (const other of [a, c]) {
      assert.ok(Math.abs(other.x - b.x) < 12, `x: ${JSON.stringify(results)}`)
      assert.ok(Math.abs(other.y - b.y) < 12, `y: ${JSON.stringify(results)}`)
      assert.ok(Math.abs(other.r - b.r) / b.r < 0.15, `r: ${JSON.stringify(results)}`)
    }
  })

  it('口元の煙は噴き出す向きへ勢いよく進み、その後は上へ漂う', () => {
    const e = new SmokeEffect()
    let t = run(e, 60, 0, 100, MOUTH)
    t = run(e, 60, t, 250, null)
    const early = e.snapshot()
    const dx = mean(early.map((p) => p.x)) - MOUTH.position.x
    const dy = mean(early.map((p) => p.y)) - MOUTH.position.y
    assert.ok(dx > MOUTH.scale && dx > Math.abs(dy) * 5, `横方向へ噴き出す dx=${dx} dy=${dy}`)
    run(e, 60, t, 1500, null)
    const late = e.snapshot()
    assert.ok(mean(late.map((p) => p.y)) < mean(early.map((p) => p.y)), '時間がたつと上へ漂う')
  })

  it('速度の倍率を上げると、発生直後の移動距離が伸びる', () => {
    const dist = (speed: number) => {
      const e = new SmokeEffect()
      const t = run(e, 60, 0, 50, MOUTH, { ...STYLE, speed })
      run(e, 60, t, 150, null, { ...STYLE, speed })
      return mean(e.snapshot().map((p) => p.x - MOUTH.position.x))
    }
    assert.ok(dist(3) > dist(1) * 2.2)
  })

  it('発生直後の粒子は小さく（突然大きな円にならない）、時間とともに拡大する', () => {
    const e = new SmokeEffect()
    const t = run(e, 60, 0, 34, MOUTH)
    const born = e.snapshot()
    assert.ok(born.every((p) => p.radius < MOUTH.scale * 0.5))
    run(e, 60, t, 1000, null)
    assert.ok(mean(e.snapshot().map((p) => p.radius)) > MOUTH.scale * 1.2)
  })

  it('口元の煙は最初は細い流れで、その後大きな塊に広がる（STEP 4）', () => {
    const e = new SmokeEffect()
    let t = run(e, 60, 0, 100, MOUTH)
    t = run(e, 60, t, 150, null)
    const early = e.snapshot()
    const spreadY = (ps: { y: number }[]) => {
      const m = mean(ps.map((p) => p.y))
      return Math.sqrt(mean(ps.map((p) => (p.y - m) ** 2)))
    }
    assert.ok(mean(early.map((p) => p.radius)) < MOUTH.scale * 0.4, '最初は細い（半径が小さい）')
    run(e, 60, t, 1300, null)
    const late = e.snapshot()
    assert.ok(mean(late.map((p) => p.radius)) > mean(early.map((p) => p.radius)) * 4, '大きな塊に広がる')
    assert.ok(spreadY(late) > spreadY(early) * 2, '縦方向にも広がる')
  })

  it('タバコ側の煙は上方向へゆっくり立ち上る', () => {
    const e = new SmokeEffect()
    const t = run(e, 60, 0, 200, EMBER)
    run(e, 60, t, 1000, null)
    const ps = e.snapshot()
    const dy = mean(ps.map((p) => p.y)) - EMBER.position.y
    const dx = Math.abs(mean(ps.map((p) => p.x)) - EMBER.position.x)
    assert.ok(dy < -EMBER.scale * 2, `上へ動く dy=${dy}`)
    assert.ok(dx < Math.abs(dy), '横への動きは上への動きより小さい')
  })
})

describe('resolveSmokeSource', () => {
  const input = {
    emberEnd: { x: 100, y: 100 },
    cigaretteThickness: 12,
    mouth: { center: { x: 300, y: 200 }, width: 50, facing: 0.5 },
    frameWidth: 640,
  }

  it('none では発生源なし、ember は火側の端、mouth は唇の中心', () => {
    assert.equal(resolveSmokeSource('none', input), null)
    assert.deepEqual(resolveSmokeSource('ember', input)?.position, input.emberEnd)
    assert.deepEqual(resolveSmokeSource('mouth', input)?.position, input.mouth.center)
  })

  it('口元の煙は顔が向いている側へ横向きに噴き出す（表示座標で判定）', () => {
    const right = resolveSmokeSource('mouth', input)!
    const left = resolveSmokeSource('mouth', { ...input, mouth: { ...input.mouth, facing: -0.5 } })!
    assert.ok(right.direction.x > 0.9)
    assert.ok(left.direction.x < -0.9)
  })

  it('ほぼ正面を向いているときは直前の向きを使う', () => {
    const front = { ...input, mouth: { ...input.mouth, facing: 0.02 } }
    assert.ok(resolveSmokeSource('mouth', front, -1)!.direction.x < 0)
    assert.ok(resolveSmokeSource('mouth', front, 1)!.direction.x > 0)
  })

  it('大きさは顔（口幅）に比例し、画面サイズで上限・下限を設ける', () => {
    const small = resolveSmokeSource('mouth', { ...input, mouth: { ...input.mouth, width: 20 } })!.scale
    const large = resolveSmokeSource('mouth', { ...input, mouth: { ...input.mouth, width: 80 } })!.scale
    assert.ok(Math.abs(large / small - 4) < 1e-9)
    const huge = resolveSmokeSource('mouth', { ...input, mouth: { ...input.mouth, width: 5000 } })!.scale
    assert.equal(huge, 640 * 0.08)
  })

  it('プリセットは仕様どおりの順に強くなる', () => {
    const { natural, cinematic, powerful } = SMOKE_PRESETS
    for (const key of ['amount', 'speed', 'spread', 'density'] as const) {
      assert.ok(natural.style[key] < cinematic.style[key] && cinematic.style[key] < powerful.style[key], key)
    }
  })
})
