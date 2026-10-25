import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CONTACT_DISTANCE_THRESHOLD,
  DEFAULT_SNAP,
  MAX_RELEASE_DURATION_MS,
  MIN_CONTACT_DURATION_MS,
  MIN_RELEASE_SPEED,
  RELEASE_DISTANCE_THRESHOLD,
  SNAP_COOLDOWN_MS,
  SnapDetector,
  type HandSample,
  type Point3,
} from '../src/lib/snapDetector.ts'

/**
 * STEP 10：親指と人差し指の着火ジェスチャー。
 * 手の 3D の姿勢（メートル、右手、手のひらの座標系。MediaPipe のワールドランドマークに相当）。
 * contact：親指と人差し指の先端をくっつけた状態 / open：人差し指を離した状態。half は途中。
 */
type Phase = 'contact' | 'half' | 'open' | number
const CONTACT_TIP = { x: -0.032, y: 0.112, z: 0.026 }
const OPEN_TIP = { x: -0.04, y: 0.18, z: 0 }
function localPose(phase: Phase, middle: Point3 = { x: -0.02, y: 0.17, z: 0 }) {
  // 数値は contact（0）→ open（1）の間の位置
  const k = typeof phase === 'number' ? phase : { contact: 0, half: 0.45, open: 1 }[phase]
  const indexTip = {
    x: CONTACT_TIP.x + (OPEN_TIP.x - CONTACT_TIP.x) * k,
    y: CONTACT_TIP.y + (OPEN_TIP.y - CONTACT_TIP.y) * k,
    z: CONTACT_TIP.z + (OPEN_TIP.z - CONTACT_TIP.z) * k,
  }
  return {
    wrist: { x: 0, y: 0, z: 0 },
    indexMcp: { x: -0.025, y: 0.085, z: 0 },
    middleMcp: { x: 0, y: 0.09, z: 0 },
    pinkyMcp: { x: 0.035, y: 0.075, z: 0 },
    thumbTip: { x: -0.03, y: 0.11, z: 0.03 },
    indexTip,
    middleTip: middle,
  }
}

type Mat3 = number[]
const rotX = (a: number): Mat3 => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)]
const rotY = (a: number): Mat3 => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)]
const rotZ = (a: number): Mat3 => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1]
const mul = (a: Mat3, b: Mat3): Mat3 => {
  const m = new Array(9).fill(0)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) m[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c]
  return m
}
const apply = (m: Mat3, p: Point3): Point3 => ({
  x: m[0] * p.x + m[1] * p.y + m[2] * p.z,
  y: m[3] * p.x + m[4] * p.y + m[5] * p.z,
  z: m[6] * p.x + m[7] * p.y + m[8] * p.z,
})
const deg = (d: number) => (d * Math.PI) / 180

/** カメラに対する手の向き */
const ORIENTATIONS: Record<string, Mat3> = {
  '手のひら側': rotZ(0),
  '手の甲側': rotY(deg(180)),
  '横向き（小指側がカメラ向き）': rotY(deg(90)),
  '斜め（45° 傾けて少し倒す）': mul(rotZ(deg(45)), rotX(deg(30))),
  '指先が下（逆さ）': rotZ(deg(180)),
  '横に寝かせる（指先が横）': rotZ(deg(90)),
}

type Opts = {
  left?: boolean
  offset?: { x: number; y: number }
  with3d?: boolean
  confidence?: number
  /** 1m あたりの画素数（手の大きさ・カメラからの距離） */
  px?: number
  middle?: Point3 | null
}

/** 姿勢を回転・左右（左手は x を反転）・画面上の位置に置いて HandSample を作る（正射影） */
function sample(phase: Phase, rot: Mat3, time: number, opts: Opts = {}): HandSample {
  const p = localPose(phase, opts.middle ?? undefined)
  const pts = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, apply(rot, opts.left ? { ...v, x: -v.x } : v)])) as Record<keyof typeof p, Point3>
  const o = opts.offset ?? { x: 0, y: 0 }
  const px = opts.px ?? 1500
  const img = (q: Point3) => ({ x: 320 + o.x + q.x * px, y: 240 + o.y + q.y * px })
  return {
    time,
    thumbTip: img(pts.thumbTip),
    middleTip: opts.middle === null ? undefined : img(pts.middleTip),
    wrist: img(pts.wrist),
    indexMcp: img(pts.indexMcp),
    pinkyMcp: img(pts.pinkyMcp),
    indexTip: img(pts.indexTip),
    scale: Math.max(Math.hypot(img(pts.wrist).x - img(pts.middleMcp).x, img(pts.wrist).y - img(pts.middleMcp).y), 1),
    world:
      opts.with3d === false
        ? undefined
        : { thumbTip: pts.thumbTip, middleTip: pts.middleTip, wrist: pts.wrist, indexMcp: pts.indexMcp, pinkyMcp: pts.pinkyMcp, middleMcp: pts.middleMcp, indexTip: pts.indexTip },
    confidence: opts.confidence,
  }
}

const FRAME = 33
/** 接触 contactFrames 回 → 離す → 開いたまま 5 回 を流し、判定の結果を返す */
function play(d: SnapDetector, rot: Mat3 = ORIENTATIONS['手のひら側'], opts: Opts = {}, start = 0, contactFrames = 4, frame = FRAME, key = 'right', settings = DEFAULT_SNAP) {
  let t = start
  const events = []
  for (let i = 0; i < contactFrames; i++) {
    const e = d.update(key, sample('contact', rot, (t += frame), opts), settings)
    if (e) events.push(e)
  }
  for (let i = 0; i < 6; i++) {
    const e = d.update(key, sample('open', rot, (t += frame), opts), settings)
    if (e) events.push(e)
  }
  return { events, end: t }
}

describe('SnapDetector（STEP 10：親指と人差し指の着火ジェスチャー）', () => {
  it('しきい値の定数（単位：手の大きさに対する比率・ms・手の大きさ / 秒）', () => {
    assert.ok(CONTACT_DISTANCE_THRESHOLD < RELEASE_DISTANCE_THRESHOLD)
    assert.equal(DEFAULT_SNAP.contactDistance, CONTACT_DISTANCE_THRESHOLD)
    assert.equal(DEFAULT_SNAP.releaseDistance, RELEASE_DISTANCE_THRESHOLD)
    assert.equal(DEFAULT_SNAP.minContactMs, MIN_CONTACT_DURATION_MS)
    assert.equal(DEFAULT_SNAP.maxReleaseMs, MAX_RELEASE_DURATION_MS)
    assert.equal(DEFAULT_SNAP.minSpeed, MIN_RELEASE_SPEED)
    assert.equal(DEFAULT_SNAP.cooldownMs, SNAP_COOLDOWN_MS)
  })

  it('19. 親指と人差し指を一定時間くっつけてから素早く離すと成功し、炎は人差し指の先端に出る', () => {
    const d = new SnapDetector()
    const { events } = play(d)
    assert.equal(events.length, 1)
    const tip = sample('open', ORIENTATIONS['手のひら側'], 0).indexTip!
    assert.ok(Math.hypot(events[0].position.x - tip.x, events[0].position.y - tip.y) < 1e-6)
  })

  it('20. ゆっくり離した場合は失敗する（理由が記録される）', () => {
    const d = new SnapDetector()
    const rot = ORIENTATIONS['手のひら側']
    let t = 0
    for (let i = 0; i < 4; i++) assert.equal(d.update('right', sample('contact', rot, (t += FRAME)), DEFAULT_SNAP), null)
    // 0.8 秒かけて少しずつ開く
    for (let i = 1; i <= 24; i++) assert.equal(d.update('right', sample(i / 24, rot, (t += FRAME)), DEFAULT_SNAP), null)
    for (let i = 0; i < 4; i++) assert.equal(d.update('right', sample('open', rot, (t += FRAME)), DEFAULT_SNAP), null)
    assert.equal(d.successes, 0)
    assert.ok(d.recentAttempts.some((a) => !a.ok && a.reasons.some((r) => r.includes('ゆっくり') || r.includes('遅い') || r.includes('速さが足りない'))))
  })

  it('21. 接触時間が短すぎる場合は失敗する', () => {
    const d = new SnapDetector()
    const { events } = play(d, undefined, {}, 0, 1)
    assert.equal(events.length, 0)
    assert.ok(d.recentAttempts[0].reasons.includes('接触が短い'))
  })

  it('22. 単に手を移動させただけ（指の距離が変わらない）では成功しない', () => {
    const d = new SnapDetector()
    const rot = ORIENTATIONS['手のひら側']
    let t = 0
    for (let i = 0; i < 20; i++) {
      // 開いたまま、くっつけたまま、それぞれ手を大きく動かす
      assert.equal(d.update('right', sample('open', rot, (t += FRAME), { offset: { x: i * 40, y: -i * 25 } }), DEFAULT_SNAP), null)
    }
    for (let i = 0; i < 20; i++) {
      assert.equal(d.update('right', sample('contact', rot, (t += FRAME), { offset: { x: -i * 40, y: i * 25 } }), DEFAULT_SNAP), null)
    }
    assert.equal(d.successes, 0)
  })

  it('22b. 手を大きく振りながら指を離しても成功しない（手首の速さの制限）', () => {
    const d = new SnapDetector()
    const rot = ORIENTATIONS['手のひら側']
    let t = 0
    for (let i = 0; i < 4; i++) d.update('right', sample('contact', rot, (t += FRAME)), DEFAULT_SNAP)
    const e = d.update('right', sample('open', rot, (t += FRAME), { offset: { x: 400, y: 0 } }), DEFAULT_SNAP)
    assert.equal(e, null)
    assert.ok(d.recentAttempts[0].reasons.some((r) => r.includes('手全体')))
  })

  for (const left of [false, true]) {
    for (const [name, rot] of Object.entries(ORIENTATIONS)) {
      it(`23・24. ${left ? '左手' : '右手'}・${name}でも 1 回だけ成功する`, () => {
        const d = new SnapDetector()
        assert.equal(play(d, rot, { left }).events.length, 1)
      })
    }
  }

  it('23b. 3D のワールドランドマークが無くても（2D だけで）、手のひら側・手の甲側・斜めで成功する', () => {
    for (const name of ['手のひら側', '手の甲側', '斜め（45° 傾けて少し倒す）', '横に寝かせる（指先が横）']) {
      const d = new SnapDetector()
      assert.equal(play(d, ORIENTATIONS[name], { with3d: false }).events.length, 1, name)
    }
  })

  it('25. 手の大きさ・カメラからの距離が変わっても同じ判定（2.5 倍・0.4 倍）', () => {
    for (const px of [3750, 600]) {
      for (const with3d of [true, false]) {
        const d = new SnapDetector()
        assert.equal(play(d, undefined, { px, with3d }).events.length, 1, `px=${px} 3d=${with3d}`)
      }
    }
  })

  it('26. 中指の位置・動きは必須条件ではない（中指が無い・ばらばらに動いても成功する）', () => {
    const d1 = new SnapDetector()
    assert.equal(play(d1, undefined, { middle: null }).events.length, 1)
    // 中指が手のひらから遠ざかる（STEP 9 までは失敗の条件）
    const d2 = new SnapDetector()
    assert.equal(play(d2, undefined, { middle: { x: 0.02, y: 0.2, z: -0.05 } }).events.length, 1)
  })

  it('27. クールダウン中は再発火せず、クールダウン後は成功する（手ごと）', () => {
    const d = new SnapDetector()
    const first = play(d)
    assert.equal(first.events.length, 1)
    // 直後にもう一度（クールダウン 900ms 以内）
    const second = play(d, undefined, {}, first.end)
    assert.equal(second.events.length, 0)
    assert.ok(d.recentAttempts[0].reasons.includes('クールダウン中'))
    // 別の手はクールダウンの影響を受けない
    assert.equal(play(d, undefined, {}, first.end, 4, FRAME, 'left').events.length, 1)
    const third = play(d, undefined, {}, second.end + SNAP_COOLDOWN_MS)
    assert.equal(third.events.length, 1)
  })

  it('28. 1 回のジェスチャーで 1 回だけ（離した後に開いたままでも、距離が揺れても増えない）', () => {
    const d = new SnapDetector()
    const rot = ORIENTATIONS['手のひら側']
    let t = 0
    let n = 0
    for (let i = 0; i < 4; i++) if (d.update('right', sample('contact', rot, (t += FRAME)), DEFAULT_SNAP)) n++
    for (let i = 0; i < 30; i++) if (d.update('right', sample(i % 2 ? 'open' : 'half', rot, (t += FRAME)), DEFAULT_SNAP)) n++
    assert.equal(n, 1)
  })

  it('しきい値付近で距離が揺れても、接触・離脱が交互に切り替わらない（ヒステリシス）', () => {
    const d = new SnapDetector()
    const base = sample('contact', ORIENTATIONS['手のひら側'], 0, { with3d: false })
    const scale = Math.max(base.scale, Math.hypot(base.indexMcp.x - base.pinkyMcp.x, base.indexMcp.y - base.pinkyMcp.y) * 1.3)
    let t = 0
    const phases: string[] = []
    for (let i = 0; i < 20; i++) {
      // 接触の距離 0.3 の前後（0.27 / 0.36）を交互に
      const r = (i % 2 ? 0.36 : 0.27) * scale
      const s = { ...base, time: (t += FRAME), indexTip: { x: base.thumbTip.x + r, y: base.thumbTip.y } }
      d.update('right', s, DEFAULT_SNAP)
      phases.push(d.debug('right')!.phase)
    }
    assert.ok(phases.slice(1).every((p) => p === 'contact' || p === 'armed'), phases.join(','))
    assert.equal(d.successes, 0)
  })

  it('推論が 15fps でも成功する', () => {
    const d = new SnapDetector()
    assert.equal(play(d, undefined, {}, 0, 3, 67).events.length, 1)
  })

  it('ペンをつまんでいる接触は着火ジェスチャーにしない', () => {
    const d = new SnapDetector()
    const rot = ORIENTATIONS['手のひら側']
    let t = 0
    let n = 0
    for (let i = 0; i < 4; i++) if (d.update('right', sample('contact', rot, (t += FRAME)), DEFAULT_SNAP, { holdingPen: true })) n++
    assert.equal(d.isGesturing('right'), false)
    for (let i = 0; i < 4; i++) if (d.update('right', sample('open', rot, (t += FRAME)), DEFAULT_SNAP)) n++
    assert.equal(n, 0)
  })

  it('信頼度が低い推論結果は使わない。見失った手の途中経過は捨てる', () => {
    const d = new SnapDetector()
    const rot = ORIENTATIONS['手のひら側']
    assert.equal(play(d, rot, { confidence: 0.2 }).events.length, 0)
    assert.equal(d.debug('right')!.unreliable, true)
    const d2 = new SnapDetector()
    let t = 0
    for (let i = 0; i < 4; i++) d2.update('right', sample('contact', rot, (t += FRAME)), DEFAULT_SNAP)
    // 400ms 見失った後に開いた手が来ても判定しない
    assert.equal(d2.update('right', sample('open', rot, t + 400), DEFAULT_SNAP), null)
  })

  it('デバッグ：段階・接触時間・離れる速さ・クールダウンの残り', () => {
    const d = new SnapDetector()
    const rot = ORIENTATIONS['手のひら側']
    let t = 0
    d.update('right', sample('contact', rot, (t += FRAME)), DEFAULT_SNAP)
    assert.equal(d.debug('right')!.phase, 'contact')
    d.update('right', sample('contact', rot, (t += FRAME)), DEFAULT_SNAP)
    d.update('right', sample('contact', rot, (t += FRAME)), DEFAULT_SNAP)
    assert.equal(d.debug('right')!.phase, 'armed')
    // STEP 11：接触の時間は、最初〜最後の接触の推論結果 + 推論の間隔 1 回分
    assert.ok(Math.abs(d.debug('right')!.contactMs - (2 * FRAME + d.debug('right')!.intervalMs)) < 1e-9)
    assert.equal(d.debug('right')!.status, 'contact')
    assert.ok(d.update('right', sample('open', rot, (t += FRAME)), DEFAULT_SNAP))
    const dbg = d.debug('right')!
    assert.equal(dbg.phase, 'open')
    assert.ok(dbg.releaseSpeed > MIN_RELEASE_SPEED)
    assert.equal(dbg.cooldownMs, SNAP_COOLDOWN_MS)
    assert.equal(dbg.status, 'success')
    // 成功の表示（600ms）→ クールダウンの表示 → 離れている
    const long = { ...DEFAULT_SNAP, cooldownMs: 2000 }
    const statusAt = (det: SnapDetector, from: number, until: number, settings = DEFAULT_SNAP) => {
      let s = ''
      for (let u = from + 100; u <= until; u += 100) {
        det.update('right', sample('open', rot, u), settings)
        s = det.debug('right')!.status
      }
      return s
    }
    assert.equal(statusAt(d, t, t + 300), 'success')
    assert.equal(statusAt(d, t + 300, t + 700), 'open', '成功の表示もクールダウン（600ms）も終わった')
    const d2 = new SnapDetector()
    const end = play(d2, rot, {}, 0, 4, FRAME, 'right', long).end
    assert.equal(statusAt(d2, end, end + 900, long), 'cooldown')
  })
})
