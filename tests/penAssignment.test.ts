import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ASSIGN_TIMING,
  PenAssigner,
  optimalAssignment,
  type AssignHand,
  type AssignPen,
  type AssignPerson,
} from '../src/lib/penAssignment.ts'

const FRAME = 33
const still = { x: 0, y: 0 }
const person = (id: number, x: number, y: number, faceScale = 80): AssignPerson => ({
  id,
  mouth: { x, y },
  faceScale,
  velocity: still,
})
/** 吸い口側の端 (x, y) から右へ伸びる長さ 150 のペン */
const pen = (id: number, x: number, y: number, dx = 150, dy = 0): AssignPen => ({
  id,
  endpoints: [{ x, y }, { x: x + dx, y: y + dy }],
  thickness: 12,
  velocity: still,
})
/** 手首 wrist、指先がペンの (px, py) に触れている手 */
const hand = (wrist: { x: number; y: number }, px: number, py: number): AssignHand => ({
  points: [wrist, { x: (wrist.x + px) / 2, y: (wrist.y + py) / 2 }, { x: px, y: py }],
  wrist,
  scale: 70,
})

function run(assigner: PenAssigner, frames: number, pens: AssignPen[], persons: AssignPerson[], start = 0, hands: AssignHand[] = [], remembered?: number[]) {
  let out = assigner.update(pens, persons, hands, remembered ?? persons.map((p) => p.id), start)
  for (let i = 1; i < frames; i++) {
    out = assigner.update(pens, persons, hands, remembered ?? persons.map((p) => p.id), start + i * FRAME)
  }
  return out
}
const ownerOf = (out: { penId: number; personId: number | null }[], penId: number) =>
  out.find((o) => o.penId === penId)!.personId

describe('PenAssigner（ペンと人物の対応付け）', () => {
  const A = person(1, 150, 250)
  const B = person(2, 480, 250)

  it('各ペンを、端が口元に近い人物に割り当てる', () => {
    // 配列の順番を人物と逆にしても同じ結果
    const out = run(new PenAssigner(), 3, [pen(11, 470, 255), pen(10, 160, 255)], [B, A])
    assert.equal(ownerOf(out, 10), 1)
    assert.equal(ownerOf(out, 11), 2)
    assert.ok(out.every((o) => o.distance !== null && o.distance < 0.2))
  })

  it('同じペンを複数人に割り当てず、同じ人物に 2 本を割り当てない（一対一）', () => {
    // 2 本とも A の口元の近く。B は遠い（maxDistance 外）
    const far = person(2, 620, 60)
    const out = run(new PenAssigner(), 5, [pen(10, 155, 250), pen(11, 170, 290)], [A, far])
    const owners = out.map((o) => o.personId)
    assert.equal(owners.filter((o) => o === 1).length, 1, 'A には 1 本だけ')
    assert.equal(ownerOf(out, 10), 1, '近い方のペンを A に')
    assert.equal(ownerOf(out, 11), null, 'もう 1 本は未割当（遠い B には割り当てない）')
    // 人物の数よりペンが多くても、1 本のペンが 2 人に割り当てられることはない
    const ids = out.filter((o) => o.personId !== null).map((o) => o.penId)
    assert.equal(new Set(ids).size, ids.length)
  })

  it('2 人の中間にあって距離だけで決められないペンは、未割当にする', () => {
    const out = run(new PenAssigner(), 5, [pen(10, 315 - 75, 330)], [A, B])
    assert.equal(ownerOf(out, 10), null)
    assert.equal(out[0].ambiguous, true)
  })

  it('曖昧な位置へ移動したペンは、直前の持ち主を保持する', () => {
    const assigner = new PenAssigner()
    run(assigner, 5, [pen(10, 160, 255)], [A, B])
    const out = run(assigner, 10, [pen(10, 315 - 75, 330)], [A, B], 500)
    assert.equal(ownerOf(out, 10), 1)
  })

  it('手の情報：中間のペンを B の手が握っていれば B に割り当てる', () => {
    const p = pen(10, 315 - 75, 330)
    const bHand = hand({ x: 470, y: 420 }, 380, 332)
    const out = run(new PenAssigner(), 3, [p], [A, B], 0, [bHand])
    assert.equal(ownerOf(out, 10), 2)
    assert.equal(out[0].handOwner, 2)
  })

  it('別の人物への持ち替えは一定時間続いたときだけ（一瞬の誤対応で持ち主を変えない）', () => {
    const assigner = new PenAssigner()
    run(assigner, 5, [pen(10, 160, 255)], [A, B])
    // B の口元へ 1 フレームだけ → 変わらない
    let out = assigner.update([pen(10, 470, 255)], [A, B], [], [1, 2], 1000)
    assert.equal(ownerOf(out, 10), 1)
    out = assigner.update([pen(10, 160, 255)], [A, B], [], [1, 2], 1033)
    assert.equal(ownerOf(out, 10), 1)
    // B の口元へ持ち替え続ける → switchMs 後に B
    let t = 2000
    for (; t < 2000 + ASSIGN_TIMING.switchMs - FRAME; t += FRAME) {
      out = assigner.update([pen(10, 470, 255)], [A, B], [], [1, 2], t)
      assert.equal(ownerOf(out, 10), 1)
    }
    out = run(assigner, 3, [pen(10, 470, 255)], [A, B], t)
    assert.equal(ownerOf(out, 10), 2)
  })

  it('持ち主の顔が一時的に見えない間は、近くの別人に割り当てを移さない', () => {
    const assigner = new PenAssigner()
    // A がくわえたペン（A の口元から左へ伸びる）
    const held = pen(10, 160, 255, -150)
    run(assigner, 5, [held], [A, B])
    // A の顔が隠れた（追跡データは残っている）。ペンは A の口元付近のまま、B からは約 2 顔幅（maxDistance 以内）
    const nearB = person(2, 330, 250)
    let out = run(assigner, 30, [held], [nearB], 1000, [], [1, 2])
    assert.equal(ownerOf(out, 10), 1)
    // B が実際にくわえた（B の口元に端が来た）ときだけ持ち替える
    out = run(assigner, 20, [pen(10, 335, 252)], [nearB], 3000, [], [1, 2])
    assert.equal(ownerOf(out, 10), 2)
    // A の追跡データが破棄されたら、割り当ても解除される
    const fresh = new PenAssigner()
    run(fresh, 5, [pen(10, 160, 255)], [A])
    out = fresh.update([pen(10, 160, 255)], [], [], [], 500)
    assert.equal(ownerOf(out, 10), null)
  })

  it('2 本のペンを持った 2 人が入れ替わっても、それぞれのペンが持ち主についていく', () => {
    const assigner = new PenAssigner()
    const steps = 30
    let out = run(assigner, 3, [pen(10, 160, 255), pen(11, 490, 315)], [A, person(2, 480, 310)])
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const ax = 150 + 330 * t
      const bx = 480 - 330 * t
      out = assigner.update(
        [pen(10, ax + 10, 255), pen(11, bx + 10, 315)],
        [person(1, ax, 250), person(2, bx, 310)],
        [],
        [1, 2],
        200 + i * FRAME,
      )
      assert.equal(ownerOf(out, 10), 1, `step ${i}`)
      assert.equal(ownerOf(out, 11), 2, `step ${i}`)
    }
  })
})

describe('optimalAssignment', () => {
  it('割り当て数を最大にし、その中でコストの合計を最小にする', () => {
    // 貪欲法だと (0→0) を選んで 1 組しか作れないケース
    assert.deepEqual(optimalAssignment([[0.1, 0.5], [0.2, null]]), [1, 0])
    assert.deepEqual(optimalAssignment([[null, null], [0.3, 0.1]]), [null, 1])
    assert.deepEqual(optimalAssignment([]), [])
  })
})
