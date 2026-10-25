import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { DEFAULT_FIRE, FireController, SOLO_CIGARETTE, type FireCigarette, type FireFrame, type FireFrameInput } from '../src/lib/fireController.ts'
import { HOLD_ENTER_MS, HOLD_EXIT_MS, HandHoldEstimator, PEN_LOST_GRACE_MS, holdScore, type HoldPen } from '../src/lib/handHold.ts'
import type { TrackedHand } from '../src/lib/handTracker.ts'
import type { HandSample } from '../src/lib/snapDetector.ts'

const FRAME = 33
const realRandom = Math.random
beforeEach(() => {
  let seed = 9
  Math.random = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
})
afterEach(() => {
  Math.random = realRandom
})

type P = { x: number; y: number }
/**
 * 21 点の手（手首を原点、指先が上。手首〜中指の付け根 100px）。MediaPipe のランドマーク番号の順。
 * 親指 1〜4、人差し指 5〜8、中指 9〜12、薬指 13〜16、小指 17〜20。
 */
const OPEN: P[] = [
  { x: 0, y: 0 },
  { x: -30, y: -20 }, { x: -50, y: -45 }, { x: -65, y: -70 }, { x: -75, y: -95 },
  { x: -25, y: -95 }, { x: -30, y: -135 }, { x: -32, y: -160 }, { x: -34, y: -182 },
  { x: 0, y: -100 }, { x: 0, y: -145 }, { x: 0, y: -172 }, { x: 0, y: -195 },
  { x: 22, y: -95 }, { x: 25, y: -135 }, { x: 27, y: -160 }, { x: 28, y: -180 },
  { x: 42, y: -82 }, { x: 48, y: -112 }, { x: 52, y: -132 }, { x: 55, y: -150 },
]
/** 親指と人差し指の先をくっつけた形（手首からの相対位置） */
const CONTACT: Record<number, P> = { 6: { x: -40, y: -120 }, 7: { x: -58, y: -105 }, 8: { x: -70, y: -98 } }

/** ランドマーク（表示座標）から TrackedHand を作る */
function fromLandmarks(key: string, lm: P[], time: number, side: TrackedHand['side'] = 'right'): TrackedHand {
  const sample: HandSample = {
    time,
    thumbTip: lm[4],
    middleTip: lm[12],
    wrist: lm[0],
    indexMcp: lm[5],
    pinkyMcp: lm[17],
    indexTip: lm[8],
    indexPip: lm[6],
    scale: Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y),
  }
  return { key, side, landmarks: lm, sample, sampleId: 0 }
}

/** 手首の位置・回転・左右の反転で置いた手。overrides は手首からの相対位置（回転前） */
function freeHand(key: string, wrist: P, time: number, pose: 'open' | 'contact', o: { angle?: number; mirror?: boolean; side?: TrackedHand['side'] } = {}): TrackedHand {
  const a = ((o.angle ?? 0) * Math.PI) / 180
  const lm = OPEN.map((p, i) => {
    const q = pose === 'contact' && CONTACT[i] ? CONTACT[i] : p
    const x = o.mirror ? -q.x : q.x
    return { x: wrist.x + x * Math.cos(a) - q.y * Math.sin(a), y: wrist.y + x * Math.sin(a) + q.y * Math.cos(a) }
  })
  return fromLandmarks(key, lm, time, o.side ?? 'right')
}

/**
 * タバコ（吸い口 (100,300) → 火側 (300,300)、軸 y = 300）を握っている右手。手首 (230,420)。
 * absolute は表示座標での指の位置の上書き。
 */
const GRIP: Record<number, P> = {
  3: { x: 160, y: 312 }, 4: { x: 172, y: 306 },
  6: { x: 165, y: 285 }, 7: { x: 172, y: 290 }, 8: { x: 178, y: 295 },
  10: { x: 185, y: 290 }, 11: { x: 190, y: 296 }, 12: { x: 192, y: 303 },
}
function holdingHand(time: number, absolute: Record<number, P> = {}, key = 'right', jitter = 0): TrackedHand {
  const wrist = { x: 230, y: 420 }
  const lm = OPEN.map((p, i) => {
    const q = absolute[i] ?? GRIP[i] ?? { x: wrist.x + p.x, y: wrist.y + p.y }
    return { x: q.x + jitter * Math.sin(time / 40 + i), y: q.y + jitter * Math.cos(time / 55 + i) }
  })
  return fromLandmarks(key, lm, time)
}
/** 握ったまま、軸から 30px 上で親指と人差し指の先をくっつける（親指の第 1 関節・人差し指の第 2 関節・中指は軸のそば） */
const OFF_AXIS_PINCH: Record<number, P> = { 3: { x: 165, y: 302 }, 4: { x: 178, y: 272 }, 6: { x: 170, y: 292 }, 7: { x: 176, y: 280 }, 8: { x: 182, y: 268 } }
/** 上の形から人差し指だけを素早く離す */
const OFF_AXIS_RELEASE: Record<number, P> = { ...OFF_AXIS_PINCH, 7: { x: 185, y: 230 }, 8: { x: 195, y: 200 } }

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

/** 握った手だけを durationMs 流す */
function hold(fire: FireController, t: number, durationMs: number, p: Partial<FireFrameInput> = {}, jitter = 0) {
  const outs: FireFrame[] = []
  const end = t + durationMs
  while (t < end) outs.push(fire.update(input((t += FRAME), { hands: [holdingHand(t, {}, 'right', jitter)], ...p })))
  return { outs, t }
}

/** 空いた手（キー left、手首 (520,300)）の指パッチン。others は同時に映っている手 */
function freeSnap(fire: FireController, t: number, others: (time: number) => TrackedHand[] = () => [], o: Parameters<typeof freeHand>[4] = {}, p: Partial<FireFrameInput> = {}) {
  const wrist = { x: 520, y: 330 }
  const outs: FireFrame[] = []
  for (let i = 0; i < 2; i++) outs.push(fire.update(input((t += FRAME), { hands: [...others(t), freeHand('left', wrist, t, 'open', { side: 'left', ...o })], ...p })))
  for (let i = 0; i < 3; i++) outs.push(fire.update(input((t += FRAME), { hands: [...others(t), freeHand('left', wrist, t, 'contact', { side: 'left', ...o })], ...p })))
  for (let i = 0; i < 2; i++) outs.push(fire.update(input((t += FRAME), { hands: [...others(t), freeHand('left', wrist, t, 'open', { side: 'left', ...o })], ...p })))
  return { outs, t, event: outs.find((x) => x.snapEvent)?.snapEvent ?? null }
}

const PEN: HoldPen = { key: 'P1', owner: SOLO_CIGARETTE, a: { x: 100, y: 300 }, b: { x: 300, y: 300 }, emberKnown: true, measured: true }

describe('STEP 12：手がタバコを持っているかの推定（HandHoldEstimator）', () => {
  it('握りのスコア：親指と人差し指・中指が軸に沿うと高く、親指だけ・遠い手・火側の端のそばは低い', () => {
    assert.ok(holdScore(holdingHand(0), PEN) > 0.9)
    // 親指だけが軸のそば
    const thumbOnly = holdingHand(0, { 6: { x: 165, y: 230 }, 7: { x: 172, y: 220 }, 8: { x: 178, y: 210 }, 10: { x: 185, y: 220 }, 11: { x: 190, y: 210 }, 12: { x: 192, y: 200 } })
    assert.ok(holdScore(thumbOnly, PEN) <= 0.45 + 1e-9)
    assert.equal(holdScore(freeHand('x', { x: 520, y: 330 }, 0, 'open'), PEN), 0)
    // 同じ握りでも、火側の端の先（吸い口 → 火側の 85% より先）なら持っているとみなさない
    const atEmber = holdingHand(0, Object.fromEntries(Object.entries(GRIP).map(([k, p]) => [k, { x: p.x + 130, y: p.y }])))
    assert.equal(holdScore(atEmber, PEN), 0)
    // 手首だけがペンの中心に近くても、指が軸に沿っていなければ持っていない
    const wristOnPen = freeHand('x', { x: 200, y: 305 }, 0, 'open', { angle: 180 })
    assert.ok(holdScore(wristOnPen, PEN) < 0.3, `${holdScore(wristOnPen, PEN)}`)
  })

  it('一定時間（HOLD_ENTER_MS）続いたら HOLDING。それまでは UNKNOWN', () => {
    const est = new HandHoldEstimator()
    assert.equal(est.update(0, [holdingHand(0)], [PEN]).get('right')!.state, 'UNKNOWN')
    assert.equal(est.update(HOLD_ENTER_MS - 10, [holdingHand(HOLD_ENTER_MS - 10)], [PEN]).get('right')!.state, 'UNKNOWN')
    const v = est.update(HOLD_ENTER_MS, [holdingHand(HOLD_ENTER_MS)], [PEN]).get('right')!
    assert.equal(v.state, 'HOLDING')
    assert.equal(v.penKey, 'P1')
  })
})

describe('STEP 12：タバコを持つ手の誤着火の防止', () => {
  it('1. ペンを持っているだけ（手が小さく揺れる）では炎が出ない', () => {
    const fire = new FireController()
    const { outs } = hold(fire, 0, 3000, {}, 2)
    assert.ok(outs.every((o) => o.snapEvent === null && o.flames.length === 0))
    assert.equal(outs.at(-1)!.handViews.get('right')!.state, 'HOLDING')
    assert.equal(fire.snap.successes, 0)
  })

  it('2. ペンを持ち直しても（指を素早く開いてすぐ握り直す）炎が出ない', () => {
    const fire = new FireController()
    let { t } = hold(fire, 0, 400)
    const opened = { 3: { x: 158, y: 330 }, 4: { x: 165, y: 340 }, 6: { x: 170, y: 270 }, 7: { x: 176, y: 255 }, 8: { x: 180, y: 240 } }
    let snaps = 0
    for (let k = 0; k < 4; k++) {
      for (let i = 0; i < 3; i++) if (fire.update(input((t += FRAME), { hands: [holdingHand(t, opened)] })).snapEvent) snaps++
      for (let i = 0; i < 6; i++) if (fire.update(input((t += FRAME), { hands: [holdingHand(t)] })).snapEvent) snaps++
    }
    assert.equal(snaps, 0)
    assert.equal(fire.holds.view('right').state, 'HOLDING')
  })

  it('3. ペンを持っていない手で指パッチンすると炎が出る（もう一方の手はペンを持ったまま）', () => {
    const fire = new FireController()
    const { t } = hold(fire, 0, 400)
    const { event, outs } = freeSnap(fire, t, (time) => [holdingHand(time)])
    assert.ok(event, '空いた手で成功')
    assert.equal(event!.handKey, 'left')
    const last = outs.at(-1)!
    assert.equal(last.handViews.get('left')!.state, 'FREE')
    assert.equal(last.handViews.get('right')!.state, 'HOLDING')
  })

  it('2b. 持ち直しの途中（指がペンから一瞬離れている間）に、指をくっつけて素早く離しても炎が出ない（解除のヒステリシス）', () => {
    const fire = new FireController()
    let { t } = hold(fire, 0, 400)
    // 指をペンから離して開く → 軸から 60px 上でくっつける → 離す（合計 約 300ms、HOLD_EXIT_MS 未満）→ 握り直す
    const away = (pinch: boolean): Record<number, P> => ({
      3: { x: 150, y: 250 },
      4: { x: 160, y: 240 },
      6: { x: 175, y: 230 },
      7: { x: 172, y: pinch ? 236 : 200 },
      8: { x: pinch ? 164 : 185, y: pinch ? 238 : 170 },
      10: { x: 200, y: 230 },
      11: { x: 205, y: 215 },
      12: { x: 208, y: 200 },
    })
    let snaps = 0
    for (const pose of [away(false), away(false), away(false), away(true), away(true), away(true), away(false), away(false)]) {
      const out = fire.update(input((t += FRAME), { hands: [holdingHand(t, pose)] }))
      if (out.snapEvent) snaps++
      assert.equal(out.handViews.get('right')!.state, 'HOLDING')
    }
    for (let i = 0; i < 6; i++) if (fire.update(input((t += FRAME), { hands: [holdingHand(t)] })).snapEvent) snaps++
    assert.equal(snaps, 0)
  })

  it('4. HOLDING の手で、軸から離れた位置で親指と人差し指をくっつけて素早く離しても炎が出ない（止めた理由を残す）', () => {
    const fire = new FireController()
    let { t } = hold(fire, 0, 400)
    const outs: FireFrame[] = []
    for (let i = 0; i < 3; i++) outs.push(fire.update(input((t += FRAME), { hands: [holdingHand(t, OFF_AXIS_PINCH)] })))
    for (let i = 0; i < 3; i++) outs.push(fire.update(input((t += FRAME), { hands: [holdingHand(t, OFF_AXIS_RELEASE)] })))
    assert.ok(outs.every((o) => o.snapEvent === null))
    assert.equal(outs.at(-1)!.handViews.get('right')!.state, 'HOLDING')
    assert.match(outs.at(-1)!.handViews.get('right')!.blockedReason ?? '', /タバコを持っている手/)
    assert.equal(fire.snap.debug('right')!.status, 'blocked')

    // 同じ指の動きを、ペンを持っていない（ペンが無い）ときにすれば成功する（判定が厳しすぎないこと）
    const free = new FireController()
    let t2 = 0
    for (let i = 0; i < 3; i++) free.update(input((t2 += FRAME), { hands: [holdingHand(t2, OFF_AXIS_RELEASE)], cigarettes: [] }))
    let ok = 0
    for (let i = 0; i < 3; i++) if (free.update(input((t2 += FRAME), { hands: [holdingHand(t2, OFF_AXIS_PINCH)], cigarettes: [] })).snapEvent) ok++
    for (let i = 0; i < 3; i++) if (free.update(input((t2 += FRAME), { hands: [holdingHand(t2, OFF_AXIS_RELEASE)], cigarettes: [] })).snapEvent) ok++
    assert.equal(ok, 1)
  })

  it('5. HOLDING の手でも、人差し指のトントンで灰は落ちる（着火ジェスチャーは出ない）', () => {
    const fire = new FireController()
    fire.lightAll([SOLO_CIGARETTE])
    let { t } = hold(fire, 0, 5000)
    let ash = 0
    let snaps = 0
    const far = { 6: { x: 215, y: 275 }, 7: { x: 224, y: 265 }, 8: { x: 230, y: 255 } }
    const near = { 6: { x: 215, y: 280 }, 7: { x: 224, y: 290 }, 8: { x: 230, y: 296 } }
    for (let k = 0; k < 2; k++) {
      for (const pose of [far, far, near, far]) {
        const out = fire.update(input((t += FRAME), { hands: [holdingHand(t, pose)] }))
        if (out.ashEvent) ash++
        if (out.snapEvent) snaps++
        assert.equal(out.handViews.get('right')!.state, 'HOLDING', '叩いている間も HOLDING')
      }
    }
    assert.equal(ash, 1)
    assert.equal(snaps, 0)
  })

  it('6. 手の向き（回転・左右の手）が変わっても、FREE の手の指パッチンは成功する', () => {
    for (const angle of [0, 45, 90, 180, 270]) {
      for (const mirror of [false, true]) {
        const fire = new FireController()
        const { t } = hold(fire, 0, 300)
        const { event, outs } = freeSnap(fire, t, (time) => [holdingHand(time)], { angle, mirror })
        assert.ok(event, `${angle}° ${mirror ? '左手' : '右手'}`)
        assert.notEqual(outs.at(-1)!.handViews.get('left')!.state, 'HOLDING')
      }
    }
  })

  it('7. 複数人：他の人のペンのそばで指パッチンしても、その手をブロックしない（持ち主の違うペン）', () => {
    const A = cig({ key: 'A' })
    const B = cig({ key: 'B', mouthEnd: { x: 400, y: 120 }, emberEnd: { x: 600, y: 120 } })
    const owners = new Map([['right', 'A'], ['left', 'B']])
    // B の手：親指と人差し指の先を、A のペンの軸から 22px 上でくっつけて 200ms 保ち、素早く離す（中指は離れている）
    const bHand = (time: number, pose: 'contact' | 'open') => {
      const lm = OPEN.map((p) => ({ x: 250 + p.x, y: 560 + p.y }))
      lm[4] = { x: 240, y: 278 }
      lm[3] = { x: 232, y: 300 - 60 }
      if (pose === 'contact') {
        lm[8] = { x: 244, y: 278 }
        lm[7] = { x: 250, y: 255 }
        lm[6] = { x: 252, y: 235 }
      } else {
        lm[8] = { x: 260, y: 180 }
        lm[7] = { x: 258, y: 200 }
        lm[6] = { x: 255, y: 220 }
      }
      return fromLandmarks('left', lm, time, 'left')
    }
    const run = (withOwners: boolean) => {
      const fire = new FireController()
      const p = { cigarettes: [A, B], ...(withOwners ? { handOwners: owners } : {}) }
      let t = hold(fire, 0, 300, p).t
      let event = null
      let last: FireFrame | null = null
      for (let i = 0; i < 7; i++) last = fire.update(input((t += FRAME), { hands: [holdingHand(t), bHand(t, 'contact')], ...p }))
      for (let i = 0; i < 2; i++) {
        last = fire.update(input((t += FRAME), { hands: [holdingHand(t), bHand(t, 'open')], ...p }))
        event ??= last.snapEvent
      }
      return { event, last: last! }
    }
    const multi = run(true)
    assert.ok(multi.event, '他の人の手はブロックしない')
    assert.equal(multi.event!.handKey, 'left')
    assert.equal(multi.last.handViews.get('right')!.state, 'HOLDING', 'A の手はペンを持っている')
    // 持ち主が分からない（1 人モード）と、同じ形は A のペンを握っているとみなされる（持ち主の対応が効いていることの確認）
    assert.equal(run(false).event, null)
  })

  it('8. 一瞬のペン認識ロスト（画面から消える・追跡フィルタの保持中）では HOLDING を解除しない', () => {
    const fire = new FireController()
    let { t } = hold(fire, 0, 400)
    // 約 700ms 消える（指が離れたときの解除の時間 HOLD_EXIT_MS より長く、PEN_LOST_GRACE_MS より短い）
    for (let i = 0; i < 21; i++) fire.update(input((t += FRAME), { hands: [holdingHand(t)], cigarettes: [] }))
    assert.equal(fire.holds.view('right').state, 'HOLDING', '700ms 消えても保持')
    for (let i = 0; i < 18; i++) fire.update(input((t += FRAME), { hands: [holdingHand(t)], cigarettes: [cig({ measured: false })] }))
    assert.equal(fire.holds.view('right').state, 'HOLDING', '追跡フィルタの保持中（600ms）も保持')
    for (let i = 0; i < 6; i++) fire.update(input((t += FRAME), { hands: [holdingHand(t)] }))
    // 長く消えたら解除する
    const until = t + PEN_LOST_GRACE_MS + HOLD_EXIT_MS + 200
    while (t < until) fire.update(input((t += FRAME), { hands: [holdingHand(t)], cigarettes: [] }))
    assert.equal(fire.holds.view('right').state, 'FREE')
  })

  it('9. カメラの切り替え（resetTracking）の後も、持っている手の判定と空いた手の指パッチンが正常に動く', () => {
    const fire = new FireController()
    let { t } = hold(fire, 0, 400)
    fire.resetTracking()
    assert.equal(fire.holds.view('right').state, 'FREE', '推定をやり直す')
    const again = hold(fire, t, 300)
    t = again.t
    assert.equal(again.outs.at(-1)!.handViews.get('right')!.state, 'HOLDING')
    const { event } = freeSnap(fire, t, (time) => [holdingHand(time)])
    assert.ok(event)
  })

  it('10. SNAP! と炎は同じ成功イベントで出る（空いた手にだけ）', () => {
    const fire = new FireController()
    const snap = freeSnap(fire, hold(fire, 0, 400).t, (time) => [holdingHand(time)])
    const outs = snap.outs
    const hit = outs.findIndex((o) => o.snapEvent)
    const at = snap.t - (outs.length - 1 - hit) * FRAME
    assert.equal(outs[hit].flames.length, 1)
    const bursts = fire.bursts.active(at)
    assert.equal(bursts.length, 1)
    assert.equal(bursts[0].handKey, 'left')
    assert.ok(outs.slice(0, hit).every((o) => o.flames.length === 0), '成功の前は炎も SNAP! も無い')
  })
})

describe('STEP 12：HOLDING → FREE の切り替わりと UNKNOWN', () => {
  it('持つのをやめた直後の「つまんだ指を離す」動きは着火ジェスチャーにしない（指を一度開いてから判定を再開）', () => {
    const fire = new FireController()
    let { t } = hold(fire, 0, 400)
    // ペンが画面から消え、指はつまんだまま（HOLDING → FREE）
    const until = t + PEN_LOST_GRACE_MS + HOLD_EXIT_MS + 200
    while (t < until) fire.update(input((t += FRAME), { hands: [holdingHand(t)], cigarettes: [] }))
    assert.equal(fire.holds.view('right').state, 'FREE')
    assert.equal(fire.snap.debug('right')!.status, 'waitOpen')
    // 素早く開いても炎は出ない
    let snaps = 0
    for (let i = 0; i < 4; i++) if (fire.update(input((t += FRAME), { hands: [holdingHand(t, OFF_AXIS_RELEASE)], cigarettes: [] })).snapEvent) snaps++
    assert.equal(snaps, 0)
    // 新しい接触 → 離すなら成功
    for (let i = 0; i < 3; i++) fire.update(input((t += FRAME), { hands: [holdingHand(t, OFF_AXIS_PINCH)], cigarettes: [] }))
    for (let i = 0; i < 3; i++) if (fire.update(input((t += FRAME), { hands: [holdingHand(t, OFF_AXIS_RELEASE)], cigarettes: [] })).snapEvent) snaps++
    assert.equal(snaps, 1)
  })

  it('UNKNOWN（ペンのそばだが握っているとは言えない）の手では、着火ジェスチャーを止めない', () => {
    const fire = new FireController()
    // 親指の先だけがペンの軸のそば。人差し指と中指は離れている
    const nearOnly = (time: number, pose: 'contact' | 'open') => {
      const lm = OPEN.map((p) => ({ x: 250 + p.x, y: 560 + p.y }))
      lm[4] = { x: 200, y: 278 }
      lm[3] = { x: 205, y: 330 }
      lm[8] = pose === 'contact' ? { x: 204, y: 268 } : { x: 230, y: 200 }
      lm[7] = pose === 'contact' ? { x: 212, y: 262 } : { x: 232, y: 222 }
      lm[6] = pose === 'contact' ? { x: 218, y: 245 } : { x: 234, y: 245 }
      return fromLandmarks('right', lm, time)
    }
    let t = 0
    let out: FireFrame | null = null
    for (let i = 0; i < 6; i++) out = fire.update(input((t += FRAME), { hands: [nearOnly(t, 'open')] }))
    assert.equal(out!.handViews.get('right')!.state, 'UNKNOWN')
    for (let i = 0; i < 3; i++) fire.update(input((t += FRAME), { hands: [nearOnly(t, 'contact')] }))
    let ok = 0
    for (let i = 0; i < 2; i++) if (fire.update(input((t += FRAME), { hands: [nearOnly(t, 'open')] })).snapEvent) ok++
    assert.equal(ok, 1)
  })
})
