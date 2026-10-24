import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FACE_TIMING, FaceTrackManager } from '../src/lib/faceTracks.ts'
import type { Mouth } from '../src/lib/mouthTracker.ts'

const FRAME = 66 // 顔の推論間隔（約 15Hz）

export function mouth(x: number, y: number, p: Partial<Mouth> = {}): Mouth {
  return {
    center: { x, y },
    width: 40,
    height: 15,
    faceScale: 80,
    facing: 0,
    pucker: 0,
    funnel: 0,
    sampleId: 0,
    detectedAt: 0,
    debugPoints: [],
    ...p,
  }
}

describe('FaceTrackManager（顔の追跡 ID）', () => {
  it('2 人の顔を同時に認識し、別々の ID を振る', () => {
    const faces = new FaceTrackManager()
    const out = faces.update([mouth(150, 250), mouth(480, 240)], true, 0, 2)
    assert.equal(out.length, 2)
    assert.notEqual(out[0].id, out[1].id)
  })

  it('推論結果の配列の順番が入れ替わっても、人物ごとの ID を維持する', () => {
    const faces = new FaceTrackManager()
    let leftId = -1
    for (let i = 0; i < 20; i++) {
      const a = mouth(150, 250, { pucker: 0.9 })
      const b = mouth(480, 240, { pucker: 0.1 })
      const out = faces.update(i % 2 ? [a, b] : [b, a], true, i * FRAME, 2)
      const left = out.find((f) => f.center.x < 320)!
      if (i === 0) leftId = left.id
      assert.equal(left.id, leftId)
      // 口の形も人物ごとに保たれる（左の人だけがすぼめている）
      if (i > 5) assert.ok(left.pucker > 0.8 && out.find((f) => f.id !== leftId)!.pucker < 0.2)
    }
  })

  it('2 人が左右を入れ替わっても（すれ違っても）追跡 ID を維持する', () => {
    const faces = new FaceTrackManager()
    const steps = 40
    let ids: { a: number; b: number } | null = null
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      // A は左 → 右、B は右 → 左。少し上下にずれてすれ違う
      const a = mouth(120 + 400 * t, 240)
      const b = mouth(520 - 400 * t, 300)
      const out = faces.update(i % 3 ? [a, b] : [b, a], true, i * FRAME, 2)
      const faceA = out.find((f) => Math.abs(f.center.y - 240) < 25)!
      const faceB = out.find((f) => Math.abs(f.center.y - 300) < 25)!
      if (!ids) ids = { a: faceA.id, b: faceB.id }
      assert.equal(faceA.id, ids.a, `step ${i}`)
      assert.equal(faceB.id, ids.b, `step ${i}`)
    }
    const final = faces.update([mouth(520, 240), mouth(120, 300)], true, (steps + 1) * FRAME, 2)
    assert.equal(final.find((f) => f.center.x > 320)!.id, ids!.a, '入れ替わった後、右にいるのは A')
  })

  it('速く動いてすれ違うときは、前回の位置ではなく速度で予測した位置と対応付ける', () => {
    const faces = new FaceTrackManager()
    // 1 推論ごとに 50px（約 750px/s）で近づき、上下 20px のずれですれ違う
    let ids: { a: number; b: number } | null = null
    for (let i = 0; i <= 8; i++) {
      const a = mouth(145 + 50 * i, 240)
      const b = mouth(525 - 50 * i, 260) // すれ違いが推論の間に起きる（前回の A に今回の B の方が近くなる）
      const out = faces.update([b, a], true, i * FRAME, 2)
      const faceA = out.find((f) => f.center.y < 250)!
      const faceB = out.find((f) => f.center.y > 250)!
      if (!ids) ids = { a: faceA.id, b: faceB.id }
      assert.equal(faceA.id, ids.a, `step ${i}`)
      assert.equal(faceB.id, ids.b, `step ${i}`)
    }
  })

  it('1 人が画面外に出ても、もう 1 人の ID は変わらない。出た人は一定時間後に破棄する', () => {
    const faces = new FaceTrackManager()
    faces.update([mouth(150, 250), mouth(480, 240)], true, 0, 2)
    const [left, right] = faces.update([mouth(150, 250), mouth(480, 240)], true, FRAME, 2)
    let t = FRAME
    // 右の人が画面外へ
    for (let i = 0; i < 5; i++) {
      t += FRAME
      const out = faces.update([mouth(150, 250)], true, t, 2)
      assert.equal(out.find((f) => f.center.x < 320)!.id, left.id)
    }
    assert.ok(faces.rememberedIds.includes(right.id), '一時的に見えないだけなら ID を覚えている')
    t += FACE_TIMING.forgetMs + FRAME
    faces.update([mouth(150, 250)], true, t, 2)
    assert.deepEqual(faces.rememberedIds, [left.id], '一定時間後に破棄')
  })

  it('一時的に隠れた顔は、近くに戻れば同じ ID。破棄後に現れた顔は新しい ID', () => {
    const faces = new FaceTrackManager()
    faces.update([mouth(150, 250), mouth(480, 240)], true, 0, 2)
    const right = faces.update([mouth(150, 250), mouth(480, 240)], true, FRAME, 2).find((f) => f.center.x > 320)!
    // 1 秒隠れる（口元の有効時間 500ms は過ぎるが、追跡データは保持）
    let t = FRAME
    for (; t < 1000; t += FRAME) {
      const out = faces.update([mouth(150, 250)], true, t, 2)
      if (t - FRAME > FACE_TIMING.validMs) assert.equal(out.length, 1, '口元の有効時間を過ぎたら使わない')
    }
    const back = faces.update([mouth(150, 250), mouth(500, 245)], true, t, 2)
    assert.equal(back.find((f) => f.center.x > 320)!.id, right.id)
    // 破棄されるまで隠れてから戻る → 新しい ID
    t += FACE_TIMING.forgetMs + 500
    faces.update([mouth(150, 250)], true, t - 100, 2)
    const again = faces.update([mouth(150, 250), mouth(480, 240)], true, t, 2)
    assert.ok(again.find((f) => f.center.x > 320)!.id > right.id)
  })

  it('推論が無いフレームでは直前の値を返し、有効時間を過ぎたら返さない', () => {
    const faces = new FaceTrackManager()
    faces.update([mouth(150, 250)], true, 0, 2)
    assert.equal(faces.update([], false, 200, 2).length, 1)
    assert.equal(faces.update([], false, FACE_TIMING.validMs + 1, 2).length, 0)
  })

  it('複数人モードでは位置を平滑化してぶれを抑え、1 人モードでは平滑化しない（従来どおり）', () => {
    const jitter = (i: number) => (i % 2 ? 6 : -6)
    const spread = (maxFaces: number) => {
      const faces = new FaceTrackManager()
      const xs: number[] = []
      for (let i = 0; i < 30; i++) {
        const out = faces.update([mouth(300 + jitter(i), 250)], true, i * FRAME, maxFaces)
        if (i > 10) xs.push(out[0].center.x)
      }
      return Math.max(...xs) - Math.min(...xs)
    }
    assert.equal(spread(1), 12)
    assert.ok(spread(2) < 6, `${spread(2)}`)
  })

  it('1 人モードでは、大きく移動した顔も同じ人物として扱う', () => {
    const faces = new FaceTrackManager()
    const [a] = faces.update([mouth(100, 100)], true, 0, 1)
    const [b] = faces.update([mouth(550, 400)], true, FRAME, 1)
    assert.equal(a.id, b.id)
    assert.equal(b.center.x, 550)
  })

  it('推論結果ごとに顔ごとのサンプル番号が増える（煙の状態機械の連続判定用）', () => {
    const faces = new FaceTrackManager()
    const ids: number[] = []
    for (let i = 0; i < 3; i++) ids.push(faces.update([mouth(150, 250)], true, i * FRAME, 2)[0].sampleId)
    ids.push(faces.update([], false, 3 * FRAME, 2)[0].sampleId)
    assert.deepEqual(ids, [1, 2, 3, 3])
  })
})
