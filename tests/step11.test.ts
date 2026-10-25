import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { DEFAULT_CIGARETTE, burnLayout, drawBurning, placeCigarette, type CigaretteLook } from '../src/lib/cigaretteRenderer.ts'
import { BURN_LIFETIME_MS } from '../src/lib/cigaretteLife.ts'
import { DEFAULT_FIRE, FireController, SOLO_CIGARETTE, pinchOnCigarette, type FireCigarette, type FireFrameInput } from '../src/lib/fireController.ts'
import { FLAME_DURATION_MS } from '../src/lib/flameEffect.ts'
import { assignHandKeys, toDisplayPoint } from '../src/lib/handKeys.ts'
import type { TrackedHand } from '../src/lib/handTracker.ts'
import { DEFAULT_IGNITION } from '../src/lib/ignition.ts'
import { penFromAxis } from '../src/lib/penGeometry.ts'
import { DEFAULT_TRACKING, PenTrackingFilter } from '../src/lib/penTracking.ts'
import { composePhoto, videoTransform } from '../src/lib/photoCapture.ts'
import { SNAP_TEXT_MS, SNAP_TEXT_OFFSET, snapAlpha, snapScale } from '../src/lib/snapBurst.ts'
import {
  CONTACT_DISTANCE_THRESHOLD,
  CONTACT_EXIT_DISTANCE,
  DEFAULT_SNAP,
  MAX_RELEASE_DURATION_MS,
  MIN_CONTACT_DURATION_MS,
  MIN_RELEASE_SPEED,
  RELEASE_DISTANCE_THRESHOLD,
  SNAP_COOLDOWN_MS,
  SnapDetector,
  type HandSample,
} from '../src/lib/snapDetector.ts'

const FRAME = 33
const realRandom = Math.random
beforeEach(() => {
  let seed = 5
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
 * 2D の手（手の大きさ 100px）：親指の先端 at、人差し指の先端は at から d × 100px 上。
 * d は親指と人差し指の正規化距離そのもの。offset で手全体を動かす。
 */
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
function hand2(at: P, d: number, time: number, key = 'right', side: TrackedHand['side'] = 'right'): TrackedHand {
  return { key, side, landmarks: [], sample: sample2(at, d, time), sampleId: 0 }
}

/** 全長 200・太さ 16 のタバコ：吸い口 (100,300)、火側 (300,300) */
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

/** タバコから離れた位置で、接触 contactFrames 回 → 離す（距離 0.8）を 1 回。成功したフレームの出力を返す */
const AWAY: P = { x: 500, y: 150 }
function snapOnce(fire: FireController, t: number, p: { at?: P; key?: string; frame?: number; contactFrames?: number; extra?: Partial<FireFrameInput> } = {}) {
  const at = p.at ?? AWAY
  const frame = p.frame ?? FRAME
  const key = p.key ?? 'right'
  for (let i = 0; i < (p.contactFrames ?? 3); i++) fire.update(input((t += frame), { hands: [hand2(at, 0.15, t, key)], ...p.extra }))
  const out = fire.update(input((t += frame), { hands: [hand2(at, 0.8, t, key)], ...p.extra }))
  return { out, t }
}

/** 検出器だけで「接触 → 離す」を流す（distances を順に、間隔 frame で） */
function playDistances(d: SnapDetector, distances: number[], frame = FRAME, start = 0, at: (i: number) => P = () => AWAY, key = 'right') {
  let t = start
  const events = distances.map((dist, i) => d.update(key, sample2(at(i), dist, (t += frame)), DEFAULT_SNAP)).filter(Boolean)
  return { events, t }
}

describe('STEP 11：着火ジェスチャーのしきい値', () => {
  it('しきい値はすべて定数で、既定値に使う（接触 < 解除 < 離脱）', () => {
    assert.equal(DEFAULT_SNAP.contactDistance, CONTACT_DISTANCE_THRESHOLD)
    assert.equal(DEFAULT_SNAP.contactExitDistance, CONTACT_EXIT_DISTANCE)
    assert.equal(DEFAULT_SNAP.releaseDistance, RELEASE_DISTANCE_THRESHOLD)
    assert.ok(CONTACT_DISTANCE_THRESHOLD < CONTACT_EXIT_DISTANCE && CONTACT_EXIT_DISTANCE < RELEASE_DISTANCE_THRESHOLD)
    assert.deepEqual(
      [CONTACT_DISTANCE_THRESHOLD, CONTACT_EXIT_DISTANCE, RELEASE_DISTANCE_THRESHOLD, MIN_CONTACT_DURATION_MS, MAX_RELEASE_DURATION_MS, MIN_RELEASE_SPEED, SNAP_COOLDOWN_MS],
      [0.32, 0.42, 0.5, 50, 350, 1.0, 600],
    )
  })
})

describe('STEP 11：着火ジェスチャーの成功率', () => {
  it('1. 接触後に素早く離すと成功する（推論 30 回/秒）', () => {
    const d = new SnapDetector()
    assert.equal(playDistances(d, [0.8, 0.15, 0.15, 0.15, 0.8]).events.length, 1)
  })

  it('1b. 推論 15 回/秒では、接触の推論結果が 1 回だけの軽いタップでも成功する（接触の時間 = 推論の間隔 1 回分）', () => {
    const d = new SnapDetector()
    // 間隔を推定するための開いた手 → 1 回だけ接触 → 離す
    const { events } = playDistances(d, [0.8, 0.8, 0.8, 0.15, 0.8], 66)
    assert.equal(events.length, 1)
  })

  it('1c. 指を軽く開くだけ（距離 0.58 まで、推論 2 回分の 133ms）でも成功する。STEP 10 の離れる距離 0.6 では失敗していた', () => {
    const light = [0.8, 0.8, 0.15, 0.15, 0.45, 0.55, 0.58, 0.58, 0.58, 0.58, 0.58]
    const d = new SnapDetector()
    assert.equal(playDistances(d, light, 66).events.length, 1)
    const old = new SnapDetector()
    let t = 0
    let n = 0
    for (const dist of light) {
      if (old.update('right', sample2(AWAY, dist, (t += 66)), { ...DEFAULT_SNAP, contactDistance: 0.3, releaseDistance: 0.6, minSpeed: 1.8, minContactMs: 60, maxReleaseMs: 300, cooldownMs: 900 })) n++
    }
    assert.equal(n, 0, 'STEP 10 のしきい値では失敗する')
  })

  it('2. ゆっくり離した場合は失敗する（理由が記録される）', () => {
    const d = new SnapDetector()
    const slow = [0.8, 0.15, 0.15, 0.15, ...Array.from({ length: 25 }, (_, i) => 0.15 + ((i + 1) / 25) * 0.7)]
    assert.equal(playDistances(d, slow).events.length, 0)
    assert.ok(d.recentAttempts.some((a) => !a.ok && a.reasons.some((r) => /ゆっくり|遅い|速さが足りない/.test(r))))
  })

  it('3. 手を横に動かすだけでは成功しない（指の距離が変わらない）', () => {
    const d = new SnapDetector()
    const move = (i: number) => ({ x: 100 + i * 20, y: 200 })
    assert.equal(playDistances(d, Array(20).fill(0.8), FRAME, 0, move).events.length, 0)
    assert.equal(playDistances(d, Array(20).fill(0.15), FRAME, 1000, move).events.length, 0)
    assert.equal(d.successes, 0)
  })

  it('4. 左右どちらの手でも動作する（手ごとに判定する）', () => {
    for (const side of ['left', 'right'] as const) {
      const fire = new FireController()
      let t = 0
      for (let i = 0; i < 3; i++) fire.update(input((t += FRAME), { hands: [hand2(AWAY, 0.15, t, side, side)] }))
      const out = fire.update(input((t += FRAME), { hands: [hand2(AWAY, 0.8, t, side, side)] }))
      assert.ok(out.snapEvent, side)
      assert.equal(out.snapEvent!.handKey, side)
    }
  })

  // 5. 手の甲側・斜め・横向きのランドマーク（3D の姿勢を回転させたもの）は tests/snapDetector.test.ts の
  //    「23・24. 右手・左手 × 6 方向」で、STEP 11 のしきい値でも成功することを確かめている

  it('6. 成功時に人差し指の先端から炎が出る（同じフレームで SNAP! も出る）', () => {
    const fire = new FireController()
    const { out, t } = snapOnce(fire, 0)
    assert.ok(out.snapEvent)
    assert.equal(out.flames.length, 1)
    const tip = { x: AWAY.x, y: AWAY.y - 80 }
    assert.deepEqual(out.flames[0].base, tip, '炎の根元は人差し指の先端')
    const bursts = fire.bursts.active(t)
    assert.equal(bursts.length, 1)
    assert.equal(bursts[0].handKey, 'right')
  })

  it('7. タバコの火側の端を炎に近づけると着火する（炎が表示されている間は毎フレーム判定する）', () => {
    const fire = new FireController()
    let { t } = snapOnce(fire, 0)
    // 手を少しずつ動かして、人差し指の先端（炎の根元）を火側の端の 20px 下へ
    let lit = false
    const target = { x: 300, y: 400 } // 親指の先端。人差し指の先端は (300, 320)
    for (let i = 1; i <= 6; i++) {
      const at = { x: AWAY.x + ((target.x - AWAY.x) * i) / 6, y: AWAY.y + ((target.y - AWAY.y) * i) / 6 }
      const out = fire.update(input((t += FRAME), { hands: [hand2(at, 0.8, t)] }))
      if (out.ignition.state === 'LIT') lit = true
    }
    assert.ok(lit, '着火した')
    assert.equal(fire.ignition(SOLO_CIGARETTE).current, 'LIT')
  })

  it('7b. 炎の表示時間（5 秒）の終わり近くでも着火できる。表示が消えたら着火しない', () => {
    const fire = new FireController()
    let { t } = snapOnce(fire, 0)
    const start = t
    // 炎を出したまま（指先は離れた位置）4.5 秒待つ
    while (t < start + FLAME_DURATION_MS - 500) fire.update(input((t += FRAME), { hands: [hand2(AWAY, 0.8, t)] }))
    const near = { x: 300, y: 400 }
    // 1 フレームで手を大きく動かすと炎は追従しない（別の手とみなす）ので、手の大きさの 1.5 倍以内ずつ動かす
    for (let i = 1; i <= 4; i++) {
      const at = { x: AWAY.x + ((near.x - AWAY.x) * i) / 4, y: AWAY.y + ((near.y - AWAY.y) * i) / 4 }
      fire.update(input((t += FRAME), { hands: [hand2(at, 0.8, t)] }))
    }
    assert.equal(fire.ignition(SOLO_CIGARETTE).current, 'LIT')

    const late = new FireController()
    let t2 = snapOnce(late, 0).t
    const start2 = t2
    while (t2 < start2 + FLAME_DURATION_MS + 100) late.update(input((t2 += FRAME), { hands: [hand2(AWAY, 0.8, t2)] }))
    for (let i = 1; i <= 4; i++) {
      const at = { x: AWAY.x + ((near.x - AWAY.x) * i) / 4, y: AWAY.y + ((near.y - AWAY.y) * i) / 4 }
      late.update(input((t2 += FRAME), { hands: [hand2(at, 0.8, t2)] }))
    }
    assert.equal(late.ignition(SOLO_CIGARETTE).current, 'UNLIT')
  })

  it('7c. 表示している炎の先端だけが火側の端に届いても着火する（判定は炎の根元〜先端の線分。炎の中心だけでは届かない）', () => {
    const fire = new FireController()
    // 手の大きさ 200px（炎の高さ 180px）。人差し指の先端（炎の根元）は火側の端の 160px 下
    const big = (at: P, d: number, time: number): TrackedHand => {
      const h = hand2(at, d, time)
      return { ...h, sample: { ...h.sample, scale: 200 } }
    }
    const at = { x: 300, y: 580 }
    let t = 0
    for (let i = 0; i < 3; i++) fire.update(input((t += FRAME), { hands: [big(at, 0.15, t)] }))
    const out = fire.update(input((t += FRAME), { hands: [big(at, 1.2, t)] }))
    assert.ok(out.snapEvent)
    const f = out.flames[0]
    assert.ok(Math.hypot(f.position.x - 300, f.position.y - 300) / 200 > DEFAULT_IGNITION.igniteDistance, '炎の中心は着火距離の外')
    for (let i = 0; i < 4; i++) fire.update(input((t += FRAME), { hands: [big(at, 1.2, t)] }))
    assert.equal(fire.ignition(SOLO_CIGARETTE).current, 'LIT')
  })

  it('8. カメラの左右反転：手のランドマークの変換は、映像（ペンの検出元）の描画と同じ変換（表示座標で一致する）', () => {
    const W = 640
    const H = 480
    for (const mirror of [true, false]) {
      const [a, b, c, d, e, f] = videoTransform(W, mirror)
      for (const p of [{ x: 0.1, y: 0.2 }, { x: 0.75, y: 0.9 }]) {
        // 映像の画素 (p.x × W, p.y × H) が表示される位置
        const vx = a * p.x * W + c * p.y * H + e
        const vy = b * p.x * W + d * p.y * H + f
        const q = toDisplayPoint(p, W, H, mirror)
        assert.ok(Math.abs(q.x - vx) < 1e-9 && Math.abs(q.y - vy) < 1e-9, `${mirror}`)
      }
    }
    // 反転を切り替えたら（座標系が変わる）、炎・SNAP!・途中経過を捨てる。着火状態は残す
    const fire = new FireController()
    const { t } = snapOnce(fire, 0)
    fire.lightAll([SOLO_CIGARETTE])
    fire.resetTracking()
    assert.equal(fire.flames.active(t).length, 0)
    assert.equal(fire.bursts.active(t).length, 0)
    assert.equal(fire.ignition(SOLO_CIGARETTE).current, 'LIT')
  })

  it('9. 灰落とし（人差し指で 2 回叩く）と同時に発火しない（SNAP! も出ない）', () => {
    const fire = new FireController()
    fire.lightAll([SOLO_CIGARETTE])
    let t = 0
    for (let i = 0; i < 150; i++) fire.update(input((t += FRAME)))
    const thumb = (index: P) => ({ x: index.x + 90, y: index.y + 70 })
    const tapHand = (index: P, time: number): TrackedHand => ({
      key: 'right',
      side: 'right',
      landmarks: [],
      sample: { time, thumbTip: thumb(index), indexTip: index, wrist: { x: 560, y: 460 }, indexMcp: { x: 520, y: 380 }, pinkyMcp: { x: 570, y: 385 }, scale: 100 },
    })
    let ash = 0
    let snaps = 0
    for (let k = 0; k < 2; k++) {
      for (const at of [{ x: 260, y: 240 }, { x: 260, y: 240 }, { x: 260, y: 291 }, { x: 260, y: 240 }]) {
        const out = fire.update(input((t += FRAME), { hands: [tapHand(at, t)] }))
        if (out.ashEvent) ash++
        if (out.snapEvent) snaps++
      }
    }
    assert.equal(ash, 1)
    assert.equal(snaps, 0)
    assert.equal(fire.bursts.active(t).length, 0)
  })

  it('10. クールダウンが維持される（600ms 以内の 2 回目は失敗、その後は成功）', () => {
    const fire = new FireController()
    let { out, t } = snapOnce(fire, 0)
    assert.ok(out.snapEvent)
    const firstAt = t
    ;({ out, t } = snapOnce(fire, t, { contactFrames: 2 }))
    assert.equal(out.snapEvent, null)
    assert.ok(fire.snap.recentAttempts[0].reasons.includes('クールダウン中'))
    assert.ok(t - firstAt < SNAP_COOLDOWN_MS)
    assert.equal(fire.bursts.active(t).filter((b) => b.ageMs < 50).length, 0, 'クールダウン中は SNAP! を出さない')
    while (t < firstAt + SNAP_COOLDOWN_MS) fire.update(input((t += FRAME), { hands: [hand2(AWAY, 0.8, t)] }))
    ;({ out, t } = snapOnce(fire, t))
    assert.ok(out.snapEvent, 'クールダウン後は成功')
  })
})

describe('STEP 11：認識の欠落・取り違えへの対策', () => {
  it('接触中に推論結果が一瞬（300ms 未満）来なくても状態を捨てない。完全に見失ったら捨てる', () => {
    const d = new SnapDetector()
    let t = 0
    for (const dist of [0.8, 0.15, 0.15]) d.update('right', sample2(AWAY, dist, (t += FRAME)), DEFAULT_SNAP)
    // 150ms 欠落 → 離した手
    assert.ok(d.update('right', sample2(AWAY, 0.8, (t += 150)), DEFAULT_SNAP), '欠落の後でも成功')
    const lost = new SnapDetector()
    t = 0
    for (const dist of [0.8, 0.15, 0.15]) lost.update('right', sample2(AWAY, dist, (t += FRAME)), DEFAULT_SNAP)
    lost.prune(t + 400)
    assert.equal(lost.debug('right'), null, '見失った手の途中経過を捨てる')
    assert.equal(lost.update('right', sample2(AWAY, 0.8, t + 400), DEFAULT_SNAP), null)
  })

  it('左右の推定が一瞬入れ替わっても、同じ位置の手には同じキーを引き継ぐ（途中経過を失わない）', () => {
    const prev = [{ key: 'right', side: 'right' as const, wrist: { x: 300, y: 300 } }]
    assert.deepEqual(assignHandKeys([{ side: 'left', wrist: { x: 310, y: 305 }, scale: 100 }], prev), ['right'])
    // 2 本の手：それぞれ同じ側の近い手を優先する
    const two = [
      { key: 'right', side: 'right' as const, wrist: { x: 100, y: 300 } },
      { key: 'left', side: 'left' as const, wrist: { x: 500, y: 300 } },
    ]
    assert.deepEqual(
      assignHandKeys(
        [
          { side: 'left', wrist: { x: 505, y: 300 }, scale: 100 },
          { side: 'left', wrist: { x: 110, y: 300 }, scale: 100 },
        ],
        two,
      ),
      ['left', 'right'],
    )
    // 遠くに現れた手は新しいキー
    assert.deepEqual(
      assignHandKeys(
        [
          { side: 'right', wrist: { x: 305, y: 300 }, scale: 100 },
          { side: 'right', wrist: { x: 600, y: 50 }, scale: 50 },
        ],
        prev,
      ),
      ['right', 'right-1'],
    )
  })

  it('火側の端のそばで着火ジェスチャーをしても「ペンをつまんでいる」にしない（つまむのは吸い口〜胴体）', () => {
    const c = [cig()]
    const at = (thumb: P): TrackedHand => ({ ...hand2(thumb, 0.1, 0), sample: { ...sample2(thumb, 0.1, 0), indexTip: { x: thumb.x + 4, y: thumb.y - 4 } } })
    assert.equal(pinchOnCigarette(at({ x: 180, y: 302 }), c), true, '胴体をつまむ')
    assert.equal(pinchOnCigarette(at({ x: 292, y: 302 }), c), false, '火側の端のそば')
    assert.equal(pinchOnCigarette(at({ x: 330, y: 302 }), c), false, '火側の端の先')
  })

  it('複数人：炎を出した手の持ち主のタバコが着火距離内なら、そちらを優先する', () => {
    const fire = new FireController()
    // A：火側の端が炎の先端の真上 10px。B：炎から 60px（全長 200 の 0.3、着火距離内）
    const a = cig({ key: 'A', emberEnd: { x: 300, y: 200 }, mouthEnd: { x: 100, y: 200 } })
    const b = cig({ key: 'B', emberEnd: { x: 360, y: 260 }, mouthEnd: { x: 560, y: 260 } })
    const owners = new Map([['right', 'B']])
    const extra = { cigarettes: [a, b], handOwners: owners }
    // 人差し指の先端を (300, 290) に置く：炎の先端は 290 − 90 × 0.9 ≒ 209
    let t = snapOnce(fire, 0, { at: { x: 300, y: 370 }, extra }).t
    for (let i = 0; i < 6; i++) fire.update(input((t += FRAME), { hands: [hand2({ x: 300, y: 370 }, 0.8, t)], ...extra }))
    assert.equal(fire.ignition('B').current, 'LIT')
    assert.equal(fire.ignition('A').current, 'UNLIT')
  })
})

describe('STEP 11：デモ向けのフォールバック', () => {
  it('手が無いときの「炎を出す」は、タバコの火側の端に炎を出す（着火判定まで確かめられる）', () => {
    const fire = new FireController()
    let t = 0
    fire.update(input((t += FRAME), { manualFlameRequested: true }))
    for (let i = 0; i < 4; i++) fire.update(input((t += FRAME)))
    assert.equal(fire.ignition(SOLO_CIGARETTE).current, 'LIT')
    assert.equal(fire.bursts.active(t).length, 0, '手動の炎では SNAP! を出さない')
  })

  it('「タバコを着火」は炎なしで着火する。シケモクは着火しない', () => {
    const fire = new FireController()
    fire.lightAll([SOLO_CIGARETTE])
    assert.equal(fire.ignition(SOLO_CIGARETTE).current, 'LIT')
    fire.forceButt([SOLO_CIGARETTE])
    fire.lightAll([SOLO_CIGARETTE])
    assert.equal(fire.ignition(SOLO_CIGARETTE).current, 'UNLIT')
  })
})

describe('STEP 11：SNAP! の演出', () => {
  it('6. 成功時に 1 回だけ表示し、7. 約 600ms で消える', () => {
    const fire = new FireController()
    let { out, t } = snapOnce(fire, 0)
    const at = t
    assert.ok(out.snapEvent)
    assert.equal(fire.bursts.active(t).length, 1)
    // 開いたままの手が続いても増えない
    while (t < at + SNAP_TEXT_MS - FRAME) {
      out = fire.update(input((t += FRAME), { hands: [hand2(AWAY, 0.8, t)] }))
      assert.ok(fire.bursts.active(t).length <= 1)
    }
    assert.equal(fire.bursts.active(at + SNAP_TEXT_MS - 1).length, 1)
    fire.update(input(at + SNAP_TEXT_MS, { hands: [hand2(AWAY, 0.8, at + SNAP_TEXT_MS)] }))
    assert.equal(fire.bursts.active(at + SNAP_TEXT_MS).length, 0)
    assert.equal(SNAP_TEXT_MS, 600)
  })

  it('小さく出現して勢いよく拡大し、フェードアウトする', () => {
    assert.ok(snapScale(0) < 0.5)
    assert.ok(snapScale(100) > 1.2, '行き過ぎるほど拡大')
    assert.ok(snapScale(500) >= snapScale(200), 'その後はゆっくり大きくなる')
    assert.equal(snapAlpha(100), 1)
    assert.ok(snapAlpha(500) > 0 && snapAlpha(500) < 1)
    assert.equal(snapAlpha(SNAP_TEXT_MS), 0)
  })

  it('8. 炎と同じ成功イベントで出し、人差し指の先端の少し上（手の大きさ × SNAP_TEXT_OFFSET）に置く', () => {
    const fire = new FireController()
    const { out, t } = snapOnce(fire, 0)
    const b = fire.bursts.active(t)[0]
    assert.equal(out.flames.length, 1)
    assert.deepEqual(b.center, { x: out.snapEvent!.position.x, y: out.snapEvent!.position.y - 100 * SNAP_TEXT_OFFSET })
    assert.ok(b.center.y < out.flames[0].tip.y, '炎の先端より上（炎を隠さない）')
  })

  it('複数の手：成功した手にだけ表示する', () => {
    const fire = new FireController()
    let t = 0
    const other = { x: 120, y: 120 }
    for (let i = 0; i < 3; i++) fire.update(input((t += FRAME), { hands: [hand2(AWAY, 0.15, t), hand2(other, 0.8, t, 'left', 'left')] }))
    fire.update(input((t += FRAME), { hands: [hand2(AWAY, 0.8, t), hand2(other, 0.8, t, 'left', 'left')] }))
    const bursts = fire.bursts.active(t)
    assert.equal(bursts.length, 1)
    assert.equal(bursts[0].handKey, 'right')
  })

  it('10. 写真：SNAP! は AR の canvas（炎と同じ層）に描くので、写真の合成（AR を最後に重ねる）に写る', () => {
    const fire = new FireController()
    const { t } = snapOnce(fire, 0)
    const rec = recorder()
    fire.draw(rec.ctx, t + 100)
    assert.ok(rec.calls.some((c) => c.name === 'fillText' && c.args[0] === 'SNAP!'))
    const log: string[] = []
    const photoCtx = { save() {}, restore() {}, setTransform() {}, drawImage: (src: { name?: string }) => log.push(src.name ?? 'src'), fillRect() {}, createRadialGradient: () => ({ addColorStop() {} }), getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {}, translate() {}, scale() {} }
    composePhoto({
      video: { name: 'video', videoWidth: 640, videoHeight: 480 } as unknown as HTMLVideoElement,
      overlay: { name: 'overlay', width: 640, height: 480 } as unknown as HTMLCanvasElement,
      mirror: true,
      filter: 'normal',
      createCanvas: () => ({ width: 0, height: 0, getContext: () => photoCtx }) as unknown as HTMLCanvasElement,
    })
    assert.equal(log.at(-1), 'overlay')
  })
})

describe('STEP 11：タバコ CG の全長の固定', () => {
  const trackedPen = (length: number) =>
    new PenTrackingFilter().update(
      penFromAxis({ center: { x: 320, y: 240 }, u: { x: 1, y: 0 }, length, thickness: 12, area: length * 12, segments: [], frameWidth: 640, frameHeight: 480 }, false),
      0,
      DEFAULT_TRACKING,
    )!
  const looks: Record<string, CigaretteLook> = {
    NEW: { progress: 0, ash: 0, flash: 0, butt: false },
    BURNING: { progress: 0.5, ash: 0.06, flash: 0, butt: false },
    BUTT: { progress: 1, ash: 0.015, flash: 0, butt: true },
  }

  it('1・2. 新品・燃焼中・シケモクで、同じペンに対する CG の全長と火側の端は変わらない（本体は常に 0〜1）', () => {
    const p = placeCigarette(trackedPen(200), DEFAULT_CIGARETTE, { x: 1, y: 0 })
    assert.equal(p.length, 200)
    assert.deepEqual(p.emberEnd, { x: 420, y: 240 })
    for (const kind of ['cigarette', 'cigar'] as const) {
      for (let k = 0; k <= 10; k++) {
        const l = burnLayout(kind, { progress: k / 10, ash: 0.05, flash: 0, butt: false }, true)
        assert.deepEqual([l.bodyFrom, l.bodyTo], [0, 1], `${kind} ${k}`)
      }
      for (const [name, look] of Object.entries(looks)) {
        const l = burnLayout(kind, look, name === 'BURNING')
        assert.deepEqual([l.bodyFrom, l.bodyTo], [0, 1], `${kind} ${name}`)
      }
    }
    // 燃えるほど焦げが吸い口側へ広がる（長さではなく見た目で表す）
    const char = [0, 0.5, 1].map((p) => burnLayout('cigarette', { progress: p, ash: 0, flash: 0, butt: false }, true).charFrom)
    assert.ok(char[0] > char[1] && char[1] > char[2])
  })

  it('3. 灰を落としても CG の全長は変わらない（灰は本体の外側で、長さは本体と独立）', () => {
    const fire = new FireController()
    fire.lightAll([SOLO_CIGARETTE])
    let t = 0
    for (let i = 0; i < 300; i++) fire.update(input((t += FRAME)))
    const before = fire.life.view(SOLO_CIGARETTE, t)
    fire.requestAshDrop()
    fire.update(input((t += FRAME)))
    const after = fire.life.view(SOLO_CIGARETTE, t)
    assert.ok(after.ash < before.ash, '灰が落ちた')
    const lb = burnLayout('cigarette', { ...before, butt: false }, true)
    const la = burnLayout('cigarette', { ...after, butt: false }, true)
    assert.deepEqual([la.bodyFrom, la.bodyTo], [lb.bodyFrom, lb.bodyTo])
    assert.ok(la.ashOutside < lb.ashOutside)
    // 描画：本体は灰の長さによらず全長
    for (const look of [{ ...before, butt: false }, { ...after, butt: false }]) {
      const rec = recorder()
      drawBurning(rec.ctx, { width: 640, height: 64 } as never, 'cigarette', 200, 14, true, look, t)
      const body = rec.calls.find((c) => c.name === 'drawImage')!
      assert.deepEqual(body.args.slice(5), [-100, -7, 200, 14])
    }
  })

  it('4. シケモクでもペンが露出しない：本体を全長で描き、焦げは不透明な色を本体の形の中に重ねる（透明にする処理が無い）', () => {
    for (const kind of ['cigarette', 'cigar'] as const) {
      const rec = recorder()
      drawBurning(rec.ctx, { width: 640, height: 64 } as never, kind, 200, 14, false, looks.BUTT, 0)
      const body = rec.calls.find((c) => c.name === 'drawImage')!
      assert.deepEqual(body.args.slice(5), [-100, -7, 200, 14], '本体は全長')
      assert.ok(!rec.calls.some((c) => c.name === 'clearRect'))
      assert.ok(!rec.composites.includes('destination-out'), '切り抜き（透明化）をしない')
      const charFill = rec.calls.find((c) => c.name === 'fillRect' && c.composite === 'source-atop')
      assert.ok(charFill, '焦げは source-atop（本体の上だけ）')
      // 焦げの範囲はフィルターの端（吸い口から 27%、葉巻は帯の端 26%）から火側の端まで
      const [x, , w] = charFill!.args as number[]
      assert.ok(x <= -100 + 200 * 0.27 + 1e-9 && Math.abs(x + w - 100) < 1e-9, `${x} ${w}`)
      // 焦げの色は不透明（rgb）で、火側ほど暗い
      const g = rec.gradients[0].stops
      assert.ok(g.every((s) => s.startsWith('rgb(')), g.join(','))
      const lum = (s: string) => s.match(/\d+/g)!.slice(0, 3).reduce((a, b) => a + Number(b), 0)
      assert.ok(lum(g[0]) > lum(g[g.length - 1]))
      assert.ok(lum(g[g.length - 1]) < 60, '先端は黒っぽい')
      const l = burnLayout(kind, looks.BUTT, false)
      assert.ok(l.ashOutside > 0 && l.crust > 0 && !l.ember, '灰は残り、火は消える')
    }
  })

  it('5. ペンの映像上の長さが変わった場合は、CG も追従して伸び縮みする', () => {
    for (const len of [120, 200, 320]) {
      const p = placeCigarette(trackedPen(len), DEFAULT_CIGARETTE, { x: 1, y: 0 })
      assert.equal(p.length, len)
      assert.ok(Math.abs(p.emberEnd.x - (320 + len / 2)) < 1e-9)
    }
  })

  it('60 秒でシケモクになる仕様は維持（着火判定の火側の端も短くならない）', () => {
    const fire = new FireController()
    fire.lightAll([SOLO_CIGARETTE])
    let t = 0
    while (t < BURN_LIFETIME_MS + 500) fire.update(input((t += 50)))
    assert.equal(fire.life.state(SOLO_CIGARETTE), 'BUTT')
    assert.equal(fire.ignition(SOLO_CIGARETTE).current, 'UNLIT')
    assert.ok(DEFAULT_IGNITION.igniteDistance > 0)
  })
})

type Call = { name: string; args: unknown[]; composite: string }
/** 描画の呼び出しを記録する偽の CanvasRenderingContext2D（save / restore で合成方法を戻す） */
function recorder() {
  const calls: Call[] = []
  const composites: string[] = []
  const gradients: { stops: string[] }[] = []
  const stack: string[] = []
  const state: Record<string, unknown> = { globalCompositeOperation: 'source-over', fillStyle: '', strokeStyle: '', globalAlpha: 1 }
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      return (...args: unknown[]) => {
        calls.push({ name: prop, args, composite: String(target.globalCompositeOperation) })
        if (prop === 'save') stack.push(String(target.globalCompositeOperation))
        if (prop === 'restore') target.globalCompositeOperation = stack.pop() ?? 'source-over'
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
          const g = { stops: [] as string[], addColorStop: (_o: number, c: string) => g.stops.push(c) }
          gradients.push(g)
          return g
        }
        return undefined
      }
    },
    set(target, prop: string, value) {
      target[prop] = value
      if (prop === 'globalCompositeOperation') composites.push(String(value))
      return true
    },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, calls, composites, gradients }
}
