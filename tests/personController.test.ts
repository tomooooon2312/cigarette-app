import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { CigaretteOrienter } from '../src/lib/cigaretteOrientation.ts'
import { DEFAULT_CIGARETTE, placeCigarette } from '../src/lib/cigaretteRenderer.ts'
import { FACE_TIMING } from '../src/lib/faceTracks.ts'
import { DEFAULT_FIRE, FireController, type FireCigarette } from '../src/lib/fireController.ts'
import type { Mouth } from '../src/lib/mouthTracker.ts'
import { penFromAxis, type PenDetection } from '../src/lib/penGeometry.ts'
import { DEFAULT_TRACKING, PenTrackingFilter } from '../src/lib/penTracking.ts'
import {
  PersonController,
  SOLO_PERSON_ID,
  type PersonMode,
  type TrackFrame,
} from '../src/lib/personController.ts'
import { DEFAULT_SMOKE } from '../src/lib/smokeEffect.ts'
import { SmokeStateMachine } from '../src/lib/smokeStateMachine.ts'

const FRAME = 33
const W = 640
const H = 480

const realRandom = Math.random
beforeEach(() => {
  let seed = 7
  Math.random = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
})
afterEach(() => {
  Math.random = realRandom
})

function mouth(x: number, y: number, p: Partial<Mouth> = {}): Mouth {
  return { center: { x, y }, width: 40, height: 15, faceScale: 80, facing: 0.5, pucker: 0, funnel: 0, sampleId: 0, detectedAt: 0, debugPoints: [], ...p }
}
/** 端 (x, y) から dx 方向へ伸びる長さ 150 のペン */
function pen(x: number, y: number, dx = 150): PenDetection {
  return penFromAxis(
    { center: { x: x + dx / 2, y }, u: { x: Math.sign(dx), y: 0 }, length: Math.abs(dx), thickness: 12, area: 1800, segments: [], frameWidth: W, frameHeight: H },
    false,
  )
}

type Scene = { mouths: Mouth[]; pens: PenDetection[]; flames?: { x: number; y: number }[] }

/** PenTracker の描画ループと同じ順番で、追跡 → 着火 → 煙 を 1 フレーム進める */
class Harness {
  readonly persons = new PersonController()
  readonly fire = new FireController()
  t = 0
  frame: TrackFrame | null = null

  step(mode: PersonMode, scene: Scene) {
    this.t += FRAME
    const now = this.t
    // 顔の推論は 2 フレームに 1 回（約 15Hz）
    const fresh = Math.round(now / FRAME) % 2 === 0
    const frame = this.persons.track({
      now,
      mode,
      measuredPens: scene.pens,
      mouths: fresh ? scene.mouths : [],
      mouthsFresh: fresh,
      hands: [],
      tracking: DEFAULT_TRACKING,
      cigarette: DEFAULT_CIGARETTE,
      showCigarette: true,
    })
    for (const id of frame.removedPersonIds) this.fire.forget(String(id))
    const cigarettes: FireCigarette[] = frame.persons
      .filter((p) => p.placement)
      .map((p) => ({ key: String(p.id), emberEnd: p.placement!.emberEnd, mouthEnd: p.placement!.mouthEnd, length: p.placement!.length }))
    // 炎は手動の炎として出す（大きさ 10 → 着火判定の位置は指定位置の 4.5px 上）
    for (const f of scene.flames ?? []) this.fire.flames.spawn('manual', { x: f.x, y: f.y + 4.5 }, 10, now)
    this.fire.update({
      now,
      frameWidth: W,
      frameHeight: H,
      hands: [],
      handsFresh: false,
      lighterMeasured: null,
      lighterPressed: false,
      manualFlameRequested: false,
      cigarettes,
      settings: { ...DEFAULT_FIRE, snapEnabled: false, lighterEnabled: false },
    })
    const smoke = this.persons.updateSmoke(frame, {
      now,
      frameWidth: W,
      frameHeight: H,
      settings: DEFAULT_SMOKE,
      isLit: (id) => this.fire.ignition(String(id)).current === 'LIT',
      testBurst: false,
    })
    this.frame = frame
    return { frame, smoke }
  }

  run(mode: PersonMode, frames: number, scene: Scene | ((i: number) => Scene)) {
    let last!: ReturnType<Harness['step']>
    for (let i = 0; i < frames; i++) last = this.step(mode, typeof scene === 'function' ? scene(i) : scene)
    return last
  }
}

// 人物 A（左）と B（右）。それぞれ自分の口元から外側へタバコを伸ばしている
const A_MOUTH = mouth(170, 250)
const B_MOUTH = mouth(470, 250, { facing: -0.5 })
const A_PEN = pen(178, 252, -150) // 吸い口が A の唇、火側は左
const B_PEN = pen(462, 252, 150) // 吸い口が B の唇、火側は右
const TWO: Scene = { mouths: [A_MOUTH, B_MOUTH], pens: [A_PEN, B_PEN] }

const personAt = (frame: TrackFrame, x: number) => frame.persons.find((p) => p.face && Math.abs(p.face.center.x - x) < 60)!

describe('PersonController（複数人）', () => {
  it('2 人の顔と 2 本のペンを認識し、各ペンを正しい人物に割り当てる', () => {
    const h = new Harness()
    const { frame } = h.run(2, 10, TWO)
    assert.equal(frame.facesVisible, 2)
    assert.equal(frame.pens.length, 2)
    const a = personAt(frame, 170)
    const b = personAt(frame, 470)
    assert.notEqual(a.id, b.id)
    assert.ok(a.pen && a.pen.center.x < 320, 'A のペンは左')
    assert.ok(b.pen && b.pen.center.x > 320, 'B のペンは右')
    assert.equal(frame.unassigned.length, 0)
    // タバコのフィルターはそれぞれの人物の口元へ向く
    assert.ok(Math.abs(a.placement!.mouthEnd.x - 178) < 5 && a.placement!.emberEnd.x < a.placement!.mouthEnd.x)
    assert.ok(Math.abs(b.placement!.mouthEnd.x - 462) < 5 && b.placement!.emberEnd.x > b.placement!.mouthEnd.x)
  })

  it('人物 A の着火は人物 B に影響しない（炎は火側が最も近いタバコだけを着火する）', () => {
    const h = new Harness()
    const { frame } = h.run(2, 6, TWO)
    const a = personAt(frame, 170)
    const b = personAt(frame, 470)
    // A の火側の端の少し先に炎
    const flame = { x: a.placement!.emberEnd.x - 10, y: a.placement!.emberEnd.y }
    h.run(2, 12, { ...TWO, flames: [flame] })
    assert.equal(h.fire.ignition(String(a.id)).current, 'LIT')
    assert.equal(h.fire.ignition(String(b.id)).current, 'UNLIT')
  })

  it('FireController.update：1 つの炎で着火するのは最も近いタバコだけ', () => {
    const fire = new FireController()
    const cigarettes: FireCigarette[] = [
      { key: '1', emberEnd: { x: 300, y: 264 }, mouthEnd: { x: 150, y: 264 }, length: 150 },
      { key: '2', emberEnd: { x: 345, y: 264 }, mouthEnd: { x: 495, y: 264 }, length: 150 },
    ]
    const settings = { ...DEFAULT_FIRE, snapEnabled: false, lighterEnabled: false }
    const base = { frameWidth: 640, frameHeight: 480, hands: [], handsFresh: false, lighterMeasured: null, lighterPressed: false, cigarettes, settings }
    // 手動の炎（手が無ければ (320, 264) 付近の画面中央に出る）。炎の胴体は少し上 → タバコ 1 の火側の方が近い
    fire.update({ ...base, now: 0, manualFlameRequested: true })
    let out
    for (let i = 1; i < 15; i++) out = fire.update({ ...base, now: i * FRAME, manualFlameRequested: false })
    const states = [out!.ignitions.get('1')!.state, out!.ignitions.get('2')!.state]
    assert.equal(states.filter((s) => s === 'LIT').length, 1, `1 本だけ着火: ${states}`)
    assert.equal(out!.ignitions.get('1')!.state, 'LIT')
  })

  it('2 人が別々の煙の状態を取れる（A が SMOKING 中に B は EXHALING）', () => {
    const h = new Harness()
    const { frame } = h.run(2, 6, TWO)
    const a = personAt(frame, 170)
    const b = personAt(frame, 470)
    h.fire.ignition(String(a.id)).light()
    h.fire.ignition(String(b.id)).light()
    // 両方くわえて吸う（1 秒以上）
    h.run(2, 40, TWO)
    // B だけタバコを口から離して、口をすぼめる。A はくわえたまま
    const bAway = pen(560, 252, 150)
    const last = h.run(2, 20, { mouths: [A_MOUTH, mouth(470, 250, { facing: -0.5, pucker: 0.9 })], pens: [A_PEN, bAway] })
    const stateOf = (id: number) => last.smoke.find((s) => s.personId === id)!.state.state
    assert.equal(stateOf(a.id), 'SMOKING')
    assert.equal(stateOf(b.id), 'EXHALING')
    // 煙の発生位置も人物ごと：A は火の先、B は B の口元
    const srcA = last.smoke.find((s) => s.personId === a.id)!.source!
    const srcB = last.smoke.find((s) => s.personId === b.id)!.source!
    assert.equal(srcA.kind, 'ember')
    assert.ok(srcA.position.x < 100)
    assert.equal(srcB.kind, 'mouth')
    assert.ok(Math.abs(srcB.position.x - 470) < 10)
  })

  it('1 人が画面外に出ても、もう 1 人の状態（着火・煙）は維持され、出た人の状態と粒子は一定時間後に解放する', () => {
    const h = new Harness()
    const { frame } = h.run(2, 6, TWO)
    const a = personAt(frame, 170)
    const b = personAt(frame, 470)
    h.fire.ignition(String(a.id)).light()
    h.fire.ignition(String(b.id)).light()
    h.run(2, 40, TWO)
    // B が画面外へ（顔もペンも消える）
    let last = h.run(2, 10, { mouths: [A_MOUTH], pens: [A_PEN] })
    assert.equal(last.smoke.find((s) => s.personId === a.id)!.state.state, 'SMOKING')
    assert.equal(h.fire.ignition(String(a.id)).current, 'LIT')
    assert.ok(h.persons.personIds.includes(b.id), '一時的に見えないだけなら B の状態を保持')
    // forgetMs を過ぎたら B の状態を破棄する
    const frames = Math.ceil(FACE_TIMING.forgetMs / FRAME) + 2
    let removed: number[] = []
    for (let i = 0; i < frames; i++) {
      last = h.step(2, { mouths: [A_MOUTH], pens: [A_PEN] })
      removed = removed.concat(last.frame.removedPersonIds)
    }
    assert.deepEqual(removed, [b.id])
    assert.deepEqual(h.persons.personIds, [a.id])
    assert.ok(!h.fire.ignitionKeys.includes(String(b.id)), 'B の着火状態も破棄')
    assert.equal(last.smoke.find((s) => s.personId === a.id)!.state.state, 'SMOKING')
    assert.equal(h.fire.ignition(String(a.id)).current, 'LIT')
  })

  it('2 人が左右を入れ替わっても、人物 ID・ペンの割り当て・着火状態がそれぞれについていく', () => {
    const h = new Harness()
    const { frame } = h.run(2, 6, TWO)
    const a = personAt(frame, 170)
    h.fire.ignition(String(a.id)).light()
    const steps = 50
    const last = h.run(2, steps + 1, (i) => {
      const t = Math.min(i / steps, 1)
      const ax = 170 + 300 * t
      const bx = 470 - 300 * t
      return {
        mouths: [mouth(ax, 240), mouth(bx, 300, { facing: -0.5 })],
        pens: [pen(ax + 8, 242, -150), pen(bx - 8, 302, 150)],
      }
    })
    const nowA = last.frame.persons.find((p) => p.id === a.id)!
    assert.ok(nowA.face!.center.x > 400, 'A は右へ移動した')
    assert.ok(nowA.pen && Math.abs(nowA.pen.center.y - 242) < 3, 'A のペンは A についていく')
    assert.equal(h.fire.ignition(String(a.id)).current, 'LIT')
    const other = last.frame.persons.find((p) => p.id !== a.id && p.face)!
    assert.equal(h.fire.ignition(String(other.id)).current, 'UNLIT')
  })

  it('ペンと人物の対応が曖昧なときは未割当にし、そのタバコは着火・煙の対象にしない', () => {
    const h = new Harness()
    // 2 人のちょうど中間に置かれたペン
    const mid = pen(245, 300, 150)
    const { frame } = h.run(2, 10, { mouths: [A_MOUTH, B_MOUTH], pens: [mid] })
    assert.equal(frame.unassigned.length, 1)
    assert.ok(frame.persons.every((p) => p.pen === null))
    assert.ok(frame.unassigned[0].placement, '未割当のペンにも CG は描く（未着火）')
    // 炎を当てても、誰の着火状態も変わらない
    h.run(2, 12, { mouths: [A_MOUTH, B_MOUTH], pens: [mid], flames: [{ x: 400, y: 300 }] })
    assert.ok(h.fire.ignitionKeys.every((k) => h.fire.ignition(k).current === 'UNLIT'))
  })

  it('人数モードを切り替えたら、追跡と人物の状態をすべて捨てる', () => {
    const h = new Harness()
    h.run(2, 6, TWO)
    assert.equal(h.persons.personIds.length, 2)
    const { frame } = h.run(1, 2, TWO)
    assert.deepEqual(h.persons.personIds, [SOLO_PERSON_ID])
    assert.equal(frame.pens.length, 1)
  })
})

describe('PersonController（1 人モードの互換性）', () => {
  it('1 人モードは STEP 4 までの処理（単独追跡 + 向き補正 + 煙の状態機械）と同じ結果になる', () => {
    const h = new Harness()
    const filter = new PenTrackingFilter()
    const orienter = new CigaretteOrienter()
    const fsm = new SmokeStateMachine()
    h.fire.ignition(String(SOLO_PERSON_ID)).light()
    let compared = 0
    for (let i = 0; i < 160; i++) {
      // 口元へ近づけて吸う → 離して吐く → ペンを見失う → 別の位置で再検出、を含む動き
      const phase = i < 50 ? 'in' : i < 90 ? 'out' : i < 110 ? 'lost' : 'again'
      const x = phase === 'in' ? 178 + (i % 5) : phase === 'out' ? 300 : 420
      const pens = phase === 'lost' ? [] : [pen(x, 252 + (i % 3), -150)]
      const m = mouth(170 + (i % 4), 250, { pucker: phase === 'out' ? 0.9 : 0 })
      const { frame, smoke } = h.step(1, { mouths: [m], pens })
      const view = frame.persons[0]
      assert.equal(frame.persons.length, 1)
      assert.equal(view.id, SOLO_PERSON_ID)
      // 1 人モードでは顔を平滑化しない（推論結果の値そのまま）
      if (view.face && view.face.status === 'measured' && view.face.detectedAt === h.t) {
        assert.deepEqual(view.face.center, m.center)
      }

      // 同じ入力を、STEP 4 までの PenTracker の処理（単独の追跡フィルタ・向き補正・煙の状態機械）で計算する
      const now = h.t
      const detection = filter.update(pens[0] ?? null, now, DEFAULT_TRACKING)
      if (!detection) {
        assert.equal(view.pen, null, `frame ${i}`)
        continue
      }
      const emberDir = orienter.update(detection, view.face)
      const placement = placeCigarette(detection, DEFAULT_CIGARETTE, emberDir)
      assert.deepEqual(view.placement, placement, `frame ${i}`)
      const filterDistance = view.face
        ? Math.hypot(placement.mouthEnd.x - view.face.center.x, placement.mouthEnd.y - view.face.center.y) / view.face.faceScale
        : null
      const legacy = fsm.update(
        {
          now,
          faceSampleId: view.face?.sampleId ?? null,
          penVisible: detection.status === 'measured',
          filterDistance,
          pucker: view.face?.pucker ?? 0,
          funnel: 0,
        },
        DEFAULT_SMOKE,
      )
      assert.deepEqual(smoke[0].state, legacy, `frame ${i}`)
      compared++
    }
    assert.ok(compared > 120)
  })

  it('1 人モードではペンが口元から遠くても、その人物のタバコとして扱う（従来どおり距離で割り当てない）', () => {
    const h = new Harness()
    const { frame } = h.run(1, 5, { mouths: [mouth(100, 100)], pens: [pen(500, 400)] })
    assert.ok(frame.persons[0].pen)
    assert.equal(frame.unassigned.length, 0)
  })
})
