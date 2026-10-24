import type { Point2 } from './penGeometry'

/** 対応付けに使う人物（顔）の情報 */
export type AssignPerson = {
  id: number
  /** 唇の中心 */
  mouth: Point2
  /** 顔の大きさ px（両目の外側の端の距離）。距離の正規化に使う */
  faceScale: number
  /** 唇の中心の移動速度 px/ms */
  velocity: Point2
}

export type AssignPen = {
  id: number
  endpoints: [Point2, Point2]
  thickness: number
  /** 中心の移動速度 px/ms */
  velocity: Point2
}

export type AssignHand = {
  /** 手のランドマーク（表示座標 px） */
  points: Point2[]
  wrist: Point2
  /** 手の大きさ px（手首〜中指の付け根） */
  scale: number
}

export type AssignSettings = {
  /** ペンの近い方の端と唇の中心の距離（顔の大きさで正規化）がこれを超える人物には割り当てない */
  maxDistance: number
  /** 1 位と 2 位の人物のコスト差がこれ未満なら「曖昧」とみなす */
  ambiguityMargin: number
}

export const DEFAULT_ASSIGN: AssignSettings = {
  maxDistance: 3,
  ambiguityMargin: 0.35,
}

export const ASSIGN_WEIGHTS = {
  /** 直前と同じ人物への割り当てのコストを下げる（持ち主がころころ変わらないように） */
  stickyBonus: 0.4,
  /** ペンを握っている手が、その人物の手と推定できるときにコストを下げる */
  handBonus: 0.6,
  /** ペンが口元の近く（顔の大きさ × この値以内）にあるときだけ、移動方向の連続性を見る */
  motionNear: 1.5,
  /** 顔とペンの相対速度（顔の大きさ / 秒）に対するコストの重みと、その上限 */
  motionWeight: 0.1,
  motionCap: 0.4,
  /** 手がペンに触れているとみなす距離（手の大きさ × この値、ペンの太さ以上） */
  handTouch: 0.35,
  /** 持ち主の顔が見えない間は、別の人物の唇にこの距離（顔の大きさで正規化）以内まで近づいたときだけ持ち替える */
  handoffDistance: 1,
  /** 手首と唇の中心の距離（顔の大きさで正規化）がこれ以下の人物を、その手の持ち主の候補にする */
  handOwnerMaxDistance: 5,
  /** 手の持ち主の 1 位と 2 位の距離差がこれ未満なら、手の情報は使わない */
  handOwnerMargin: 0.8,
} as const

export const ASSIGN_TIMING = {
  /** 別の人物への持ち替えは、この時間続けて別の人物が最適だったときだけ行う ms */
  switchMs: 300,
} as const

export type PenOwnership = {
  penId: number
  /** 割り当てた人物 ID。曖昧・遠すぎるときは null（未割当） */
  personId: number | null
  /** 割り当てた人物の唇とペンの近い方の端の距離（顔の大きさで正規化） */
  distance: number | null
  /** 曖昧なため直前の対応を保持した、または未割当にした */
  ambiguous: boolean
  /** ペンを握っている手から推定した持ち主（使えなければ null） */
  handOwner: number | null
}

const dist = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y)

/** 点 p と線分 ab の距離 */
function segmentDistance(p: Point2, a: Point2, b: Point2): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const len2 = abx * abx + aby * aby
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)) : 0
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t))
}

/** ペンの近い方の端と唇の中心の距離（顔の大きさで正規化） */
export function penMouthDistance(pen: AssignPen, person: AssignPerson): number {
  const scale = Math.max(person.faceScale, 1)
  return Math.min(dist(pen.endpoints[0], person.mouth), dist(pen.endpoints[1], person.mouth)) / scale
}

/** 手の持ち主（最も近い顔）。2 位との差が小さいときは null */
function handOwner(hand: AssignHand, persons: AssignPerson[]): number | null {
  const ranked = persons
    .map((p) => ({ id: p.id, d: dist(hand.wrist, p.mouth) / Math.max(p.faceScale, 1) }))
    .filter((r) => r.d <= ASSIGN_WEIGHTS.handOwnerMaxDistance)
    .sort((a, b) => a.d - b.d)
  if (ranked.length === 0) return null
  if (ranked.length > 1 && ranked[1].d - ranked[0].d < ASSIGN_WEIGHTS.handOwnerMargin) return null
  return ranked[0].id
}

/** ペンを握っている手の持ち主（触れている手が無い、または持ち主が曖昧なら null） */
function penHandOwner(pen: AssignPen, hands: AssignHand[], persons: AssignPerson[]): number | null {
  let owner: number | null = null
  for (const hand of hands) {
    const touch = Math.max(hand.scale * ASSIGN_WEIGHTS.handTouch, pen.thickness)
    const touching = hand.points.some((p) => segmentDistance(p, pen.endpoints[0], pen.endpoints[1]) <= touch)
    if (!touching) continue
    const o = handOwner(hand, persons)
    // 2 人の手が同じペンに触れていて持ち主が食い違うときは、手の情報を使わない
    if (o === null || (owner !== null && owner !== o)) return null
    owner = o
  }
  return owner
}

/**
 * ペンと人物の一対一の対応付け（STEP 5）。
 *
 * コスト = ペンの近い方の端と唇の距離（顔の大きさで正規化）
 *        − 直前と同じ人物なら stickyBonus − ペンを握る手がその人物の手なら handBonus
 *        + 口元の近くで顔とペンの動きが食い違う分（移動方向の連続性）
 * 1. 距離が maxDistance 以内の組だけを候補にし、割り当て数が最大でコストの合計が最小になる組み合わせを全探索で求める
 *    （ペン・人物とも最大 3 程度なので全探索で十分速い）。
 * 2. 1 位と 2 位の人物のコスト差が ambiguityMargin 未満なら曖昧とみなし、直前の持ち主がいればそれを保持、いなければ未割当。
 * 3. 別の人物への持ち替えは switchMs 続いたときだけ行う。直前の持ち主の顔が一時的に見えないだけなら割り当てを保持する。
 * 4. 最後に、同じ人物に 2 本以上が割り当てられていないことを保証する（コストの小さいペンを優先）。
 */
export class PenAssigner {
  private owners = new Map<number, number>()
  private pending = new Map<number, { personId: number | null; since: number }>()

  reset(): void {
    this.owners.clear()
    this.pending.clear()
  }

  /** 人物の追跡データが破棄されたときに、その人物への割り当てを解除する */
  forgetPerson(personId: number): void {
    for (const [penId, owner] of this.owners) if (owner === personId) this.owners.delete(penId)
  }

  /**
   * persons は口元が有効な人物、rememberedIds は見失い中を含めて追跡データが残っている人物。
   */
  update(
    pens: AssignPen[],
    persons: AssignPerson[],
    hands: AssignHand[],
    rememberedIds: number[],
    now: number,
    s: AssignSettings = DEFAULT_ASSIGN,
  ): PenOwnership[] {
    const penIds = new Set(pens.map((p) => p.id))
    for (const id of [...this.owners.keys()]) if (!penIds.has(id)) this.owners.delete(id)
    for (const id of [...this.pending.keys()]) if (!penIds.has(id)) this.pending.delete(id)
    const remembered = new Set(rememberedIds)
    for (const [penId, owner] of this.owners) if (!remembered.has(owner)) this.owners.delete(penId)

    // コスト表（ゲート外は null）
    const handOwners = pens.map((pen) => penHandOwner(pen, hands, persons))
    const cost = pens.map((pen, i) =>
      persons.map((person) => {
        const d = penMouthDistance(pen, person)
        if (d > s.maxDistance) return null
        let c = d
        if (this.owners.get(pen.id) === person.id) c -= ASSIGN_WEIGHTS.stickyBonus
        if (handOwners[i] === person.id) c -= ASSIGN_WEIGHTS.handBonus
        if (d <= ASSIGN_WEIGHTS.motionNear) {
          const rel = Math.hypot(pen.velocity.x - person.velocity.x, pen.velocity.y - person.velocity.y)
          const relPerSec = (rel * 1000) / Math.max(person.faceScale, 1)
          c += Math.min(relPerSec * ASSIGN_WEIGHTS.motionWeight, ASSIGN_WEIGHTS.motionCap)
        }
        return c
      }),
    )
    const proposal = optimalAssignment(cost)

    const result: PenOwnership[] = pens.map((pen, i) => {
      const current = this.owners.get(pen.id) ?? null
      let proposed = proposal[i] === null ? null : persons[proposal[i]!].id
      let ambiguous = false
      if (proposed !== null) {
        const mine = cost[i][proposal[i]!]!
        const others = cost[i].filter((c, j): c is number => c !== null && j !== proposal[i])
        const second = others.length ? Math.min(...others) : Infinity
        if (second - mine < s.ambiguityMargin) {
          ambiguous = true
          // 曖昧なとき：直前の持ち主を保持する（いなければ未割当）。誤った人物へ割り当てない
          proposed = current
        }
      }

      let personId: number | null
      if (proposed === current) {
        this.pending.delete(pen.id)
        personId = current
      } else if (current === null) {
        this.pending.delete(pen.id)
        personId = proposed
      } else {
        const currentVisible = persons.find((p) => p.id === current)
        const handoff =
          proposed !== null &&
          penMouthDistance(pen, persons.find((p) => p.id === proposed)!) <= ASSIGN_WEIGHTS.handoffDistance
        if (
          (proposed === null && (!currentVisible || penMouthDistance(pen, currentVisible) <= s.maxDistance)) ||
          (!currentVisible && !handoff)
        ) {
          // 持ち主の顔が一時的に見えない・他の候補が無いだけなら保持する（別の人がくわえたときだけ持ち替える）
          this.pending.delete(pen.id)
          personId = current
        } else {
          const p = this.pending.get(pen.id)
          if (!p || p.personId !== proposed) {
            this.pending.set(pen.id, { personId: proposed, since: now })
            personId = current
          } else if (now - p.since >= ASSIGN_TIMING.switchMs) {
            this.pending.delete(pen.id)
            personId = proposed
          } else {
            personId = current
          }
        }
      }
      const owner = personId === null ? undefined : persons.find((p) => p.id === personId)
      return {
        penId: pen.id,
        personId,
        distance: owner ? penMouthDistance(pen, owner) : null,
        ambiguous,
        handOwner: handOwners[i],
      }
    })

    // 一対一の保証：同じ人物に複数のペンが割り当てられたら、距離の近いペンだけを残す
    const byPerson = new Map<number, PenOwnership>()
    for (const r of result) {
      if (r.personId === null) continue
      const other = byPerson.get(r.personId)
      if (!other) {
        byPerson.set(r.personId, r)
        continue
      }
      const keepOther = (other.distance ?? Infinity) <= (r.distance ?? Infinity)
      const loser = keepOther ? r : other
      loser.personId = null
      loser.distance = null
      if (!keepOther) byPerson.set(r.personId, r)
    }

    this.owners.clear()
    for (const r of result) if (r.personId !== null) this.owners.set(r.penId, r.personId)
    return result
  }
}

/**
 * 割り当て数が最大で、その中でコスト合計が最小の一対一の組み合わせ（行 = ペン、列 = 人物、null は不可）。
 * 戻り値はペンごとの人物の列番号（割り当てなしは null）。
 */
export function optimalAssignment(cost: (number | null)[][]): (number | null)[] {
  const rows = cost.length
  let best: { count: number; total: number; pick: (number | null)[] } = {
    count: 0,
    total: 0,
    pick: new Array(rows).fill(null),
  }
  const pick: (number | null)[] = new Array(rows).fill(null)
  const usedCols = new Set<number>()
  const search = (row: number, count: number, total: number) => {
    if (row === rows) {
      if (count > best.count || (count === best.count && total < best.total)) {
        best = { count, total, pick: [...pick] }
      }
      return
    }
    pick[row] = null
    search(row + 1, count, total)
    cost[row].forEach((c, col) => {
      if (c === null || usedCols.has(col)) return
      usedCols.add(col)
      pick[row] = col
      search(row + 1, count + 1, total + c)
      usedCols.delete(col)
      pick[row] = null
    })
  }
  search(0, 0, 0)
  return best.pick
}
