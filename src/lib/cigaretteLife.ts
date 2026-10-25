import type { Point2 } from './penGeometry'

/**
 * STEP 10：タバコ 1 本の燃焼寿命（NEW → BURNING → BUTT）と灰の長さ、画面外への退出による新品への交換。
 * 状態はタバコのキー（人物 ID。1 人モードは常に同じ）ごとに持つので、ペンの追跡 ID が変わっても状態は変わらない。
 */
export type CigaretteState = 'NEW' | 'BURNING' | 'BUTT'

/** 着火した状態で、画面内に映っている時間の合計がこれに達するとシケモクになる ms */
export const BURN_LIFETIME_MS = 60_000
/** 燃え進む割合の最大（1 = 巻紙がすべて燃える）。シケモクでも巻紙が少し残る */
export const BURN_MAX_FRACTION = 0.88
/** 灰の長さの上限（タバコの全長に対する比率） */
export const ASH_MAX = 0.12
/** 灰を落とした後に先端に残る灰の長さ（全長に対する比率） */
export const ASH_RESIDUAL = 0.015
/** 灰を落としたときに燃焼部分が赤く光る時間 ms */
export const EMBER_FLASH_MS = 350

/**
 * 画面外への退出の推定。
 * - 最後に映った位置の両端が、画面の端からこの距離（画面の短辺に対する比率）以内、または画面の外にある
 *   （直前の動きから EXIT_PREDICT_MS 後の位置で判定する）とき「退出の候補」にする。
 * - 候補のまま EXIT_CONFIRM_MS 見えなかったら退出を確定する。画面の中央で見失ったときは候補にしない（状態を保持する）。
 */
export const EXIT_MARGIN_RATIO = 0.08
export const EXIT_PREDICT_MS = 250
export const EXIT_CONFIRM_MS = 800
/** 1 フレームの時間の上限 ms（タブの非表示からの復帰などで、燃焼時間が急に進まないように） */
const MAX_STEP_MS = 100

export type LifeInputCigarette = {
  key: string
  /** ペンの両端（画面内の位置。退出の推定に使う） */
  ends: [Point2, Point2]
  /** このフレームで実際に検出された（追跡フィルタの保持中ではない） */
  measured: boolean
  /** 着火中 */
  lit: boolean
}

export type LifeView = {
  state: CigaretteState
  /** 燃焼時間の合計 ms */
  burnMs: number
  /** 燃え進んだ割合 0〜1（BURN_LIFETIME_MS で 1） */
  progress: number
  /** 灰の長さ（全長に対する比率） */
  ash: number
  /** 燃焼部分の光の強さ 0〜1（灰を落とした直後） */
  flash: number
  /** 退出の候補になっている */
  exitCandidate: boolean
  /** 退出を確定した（次に映ったら新品） */
  exited: boolean
}

type Life = {
  state: CigaretteState
  burnMs: number
  ash: number
  flashAt: number
  lastSeen: { ends: [Point2, Point2]; time: number; velocity: Point2 } | null
  absentSince: number | null
  exitCandidate: boolean
  exited: boolean
}

export type LifeEvent = { key: string; kind: 'butt' | 'renewed' }

export class CigaretteLifeManager {
  private lives = new Map<string, Life>()
  private lastTime: number | null = null

  private life(key: string): Life {
    let l = this.lives.get(key)
    if (!l) {
      l = { state: 'NEW', burnMs: 0, ash: 0, flashAt: -Infinity, lastSeen: null, absentSince: null, exitCandidate: false, exited: false }
      this.lives.set(key, l)
    }
    return l
  }

  state(key: string): CigaretteState {
    return this.lives.get(key)?.state ?? 'NEW'
  }

  view(key: string, now: number): LifeView {
    const l = this.lives.get(key)
    if (!l) return { state: 'NEW', burnMs: 0, progress: 0, ash: 0, flash: 0, exitCandidate: false, exited: false }
    return {
      state: l.state,
      burnMs: l.burnMs,
      progress: Math.min(l.burnMs / BURN_LIFETIME_MS, 1),
      ash: l.ash,
      flash: Math.max(0, 1 - (now - l.flashAt) / EMBER_FLASH_MS),
      exitCandidate: l.exitCandidate,
      exited: l.exited,
    }
  }

  get keys(): string[] {
    return [...this.lives.keys()]
  }

  /**
   * 毎フレーム呼ぶ。着火中で実際に映っている間だけ燃焼時間と灰を進める。
   * 状態の変化（シケモクになった・新品に戻った）を返す（呼び出し側で着火状態を消す）。
   */
  update(now: number, frameWidth: number, frameHeight: number, cigarettes: LifeInputCigarette[], growthRate: number): LifeEvent[] {
    const dtMs = this.lastTime === null ? 0 : Math.min(Math.max(now - this.lastTime, 0), MAX_STEP_MS)
    this.lastTime = now
    const events: LifeEvent[] = []
    const present = new Map(cigarettes.filter((c) => c.measured).map((c) => [c.key, c]))
    for (const c of cigarettes) this.life(c.key)

    for (const [key, l] of this.lives) {
      const c = present.get(key)
      if (c) {
        if (l.exited && l.state === 'BUTT') {
          // 画面外に出したシケモクが戻ってきた：新しいタバコに交換する
          Object.assign(l, { state: 'NEW', burnMs: 0, ash: 0, flashAt: -Infinity })
          events.push({ key, kind: 'renewed' })
        }
        l.exited = false
        l.exitCandidate = false
        l.absentSince = null
        // 動き（退出の向きの推定に使う）
        const center = mid(c.ends)
        let velocity = { x: 0, y: 0 }
        if (l.lastSeen && now > l.lastSeen.time) {
          const prev = mid(l.lastSeen.ends)
          const dt = (now - l.lastSeen.time) / 1000
          const v = { x: (center.x - prev.x) / dt, y: (center.y - prev.y) / dt }
          velocity = { x: l.lastSeen.velocity.x * 0.6 + v.x * 0.4, y: l.lastSeen.velocity.y * 0.6 + v.y * 0.4 }
        }
        l.lastSeen = { ends: c.ends, time: now, velocity }
        if (c.lit && l.state !== 'BUTT') {
          if (l.state === 'NEW') l.state = 'BURNING'
          l.burnMs += dtMs
          l.ash = Math.min(ASH_MAX, l.ash + (growthRate * dtMs) / 1000)
          if (l.burnMs >= BURN_LIFETIME_MS) {
            l.burnMs = BURN_LIFETIME_MS
            l.state = 'BUTT'
            events.push({ key, kind: 'butt' })
          }
        }
      } else if (l.lastSeen) {
        // 見えない：時間は止める。画面の端で消えたなら退出の候補
        if (l.absentSince === null) {
          l.absentSince = now
          l.exitCandidate = nearBorder(l.lastSeen, frameWidth, frameHeight)
        }
        if (l.exitCandidate && now - l.absentSince >= EXIT_CONFIRM_MS) l.exited = true
      }
    }
    return events
  }

  /** 灰を落とした：先端に少しだけ残し、燃焼部分を光らせる */
  dropAsh(key: string, now: number): number {
    const l = this.life(key)
    const dropped = Math.max(0, l.ash - ASH_RESIDUAL)
    l.ash = Math.min(l.ash, ASH_RESIDUAL)
    l.flashAt = now
    return dropped
  }

  /** デバッグ：シケモクにする */
  forceButt(key: string): void {
    const l = this.life(key)
    l.state = 'BUTT'
    l.burnMs = BURN_LIFETIME_MS
  }

  /** デバッグ：新品に戻す（退出の判定に失敗したとき用） */
  renew(key: string): void {
    const l = this.life(key)
    Object.assign(l, { state: 'NEW', burnMs: 0, ash: 0, flashAt: -Infinity, exitCandidate: false, exited: false, absentSince: null })
  }

  /** 人物の追跡データを破棄したとき */
  forget(key: string): void {
    this.lives.delete(key)
  }

  /**
   * カメラの切り替え・左右反転・カメラの停止：座標系が変わるので、位置の記録（退出の推定）だけを捨てる。
   * 状態・燃焼時間は残す（これらの操作でシケモクが新品にならない）。
   */
  resetTracking(): void {
    for (const l of this.lives.values()) {
      l.lastSeen = null
      l.absentSince = null
      l.exitCandidate = false
      l.exited = false
    }
    this.lastTime = null
  }
}

function mid([a, b]: [Point2, Point2]): Point2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** 最後に映った位置（直前の動きで少し先まで進めた位置）の両端が、画面の端の近くか外にあるか */
export function nearBorder(seen: { ends: [Point2, Point2]; velocity: Point2 }, width: number, height: number): boolean {
  const margin = EXIT_MARGIN_RATIO * Math.min(width, height)
  const k = EXIT_PREDICT_MS / 1000
  const atEdge = (p: Point2) => {
    const q = { x: p.x + seen.velocity.x * k, y: p.y + seen.velocity.y * k }
    const edge = Math.min(q.x, q.y, width - q.x, height - q.y)
    return edge <= margin
  }
  return atEdge(seen.ends[0]) && atEdge(seen.ends[1])
}
