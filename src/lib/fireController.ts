import { AshEffect } from './ashEffect'
import { AshTapDetector, DEFAULT_ASH, TAP_TIMING, type AshSettings, type AshTapEvent, type TapTarget } from './ashTap'
import { CigaretteLifeManager, type LifeEvent, type LifeView } from './cigaretteLife'
import { FlameEffect, type ActiveFlame } from './flameEffect'
import { HandHoldEstimator, type HoldPen, type HoldView } from './handHold'
import type { TrackedHand } from './handTracker'
import {
  DEFAULT_IGNITION,
  IgnitionStateMachine,
  nearestOnFlame,
  type FlameShape,
  type IgnitionOutput,
  type IgnitionSettings,
} from './ignition'
import { DEFAULT_LIGHTER, lighterNozzle, type LighterSettings } from './lighterDetector'
import type { PenDetection, Point2 } from './penGeometry'
import { PenTrackingFilter, type TrackedPen } from './penTracking'
import { SnapBurstEffect } from './snapBurst'
import { WaveDetector } from './waveDetector'
import { DEFAULT_SNAP, SnapDetector, type SnapEvent, type SnapSettings } from './snapDetector'

export type FireSettings = {
  /** 指パッチン認識（MediaPipe Hand Landmarker）を使う */
  snapEnabled: boolean
  /** 長方形の小物をライターとして認識する */
  lighterEnabled: boolean
  /** 手の推論間隔 ms（0 = カメラのフレームごと） */
  handIntervalMs: number
  snap: SnapSettings
  ignition: IgnitionSettings
  lighter: LighterSettings
  /** STEP 10：灰落とし（タップの判定と灰の成長） */
  ash: AshSettings
  /** STEP 13：手を振ると、その手の指先の炎が消える */
  waveExtinguish: boolean
}

export const DEFAULT_FIRE: FireSettings = {
  snapEnabled: true,
  lighterEnabled: true,
  handIntervalMs: 0,
  snap: DEFAULT_SNAP,
  ignition: DEFAULT_IGNITION,
  lighter: DEFAULT_LIGHTER,
  ash: DEFAULT_ASH,
  waveExtinguish: true,
}

/** STEP 9：炎を出した手を見失ってから、その位置で炎を保持する時間 ms（その後フェードアウト） */
export const FLAME_LOST_HOLD_MS = 300
/** STEP 9：指先が 1 フレームで手の大きさ × この値より動いたら、別の手に入れ替わったとみなして追従しない */
export const FLAME_MAX_JUMP = 1.5

/** ライターの検出結果の平滑化・短時間の保持（ペンと同じ追跡フィルタを再利用。長さ補完は使わない） */
const LIGHTER_TRACKING = { smoothing: 0.5, holdMs: 250, lengthCompletion: false }

export type FireFrameInput = {
  now: number
  frameWidth: number
  frameHeight: number
  hands: TrackedHand[]
  /** 今フレームで手の推論結果が新しく出たか */
  handsFresh: boolean
  /** ライター検出器の今フレームの結果（無効なら null） */
  lighterMeasured: PenDetection | null
  /** 「ライター着火」ボタンを押している */
  lighterPressed: boolean
  /** 「指先に炎を出す」ボタンが押された（このフレームで 1 回だけ true） */
  manualFlameRequested: boolean
  /** タバコ CG の端点と全長（表示していなければ null）。1 人モード用（キーは SOLO_CIGARETTE） */
  cigarette?: FireCigarette | null
  /** STEP 5：複数のタバコ（キーは人物 ID）。指定すると cigarette より優先する */
  cigarettes?: FireCigarette[]
  settings: FireSettings
  /**
   * STEP 10：手の持ち主（手のキー → タバコのキー。持ち主が曖昧なら null）。
   * 指定すると、その手はその人のタバコの灰だけを落とせる（複数人で別の人の指で灰が落ちない）。省略すると制限なし（1 人モード）
   */
  handOwners?: Map<string, string | null>
  /**
   * STEP 12：手が持っているかを調べるペン（人物に対応付けていないペンも含める）。
   * 省略すると cigarettes から作る（吸い口 → 火側の端、持ち主はタバコのキー）
   */
  holdPens?: HoldPen[]
}

/** STEP 12：手ごとの、持っているかの推定と着火ジェスチャーを止めた理由（デバッグ表示） */
export type HandFireView = HoldView & {
  /** 着火ジェスチャーを止めた理由（止めていなければ null） */
  blockedReason: string | null
}

/** 着火判定の対象となるタバコ 1 本 */
export type FireCigarette = {
  /** 着火状態を持つ単位（人物 ID）。cigarette で渡した場合は SOLO_CIGARETTE */
  key?: string
  emberEnd: Point2
  mouthEnd: Point2
  length: number
  /** STEP 10：タバコ CG の太さ px（灰・タップの判定。省略時は全長の 8%） */
  thickness?: number
  /** STEP 10：ペンの両端（画面外への退出の推定。省略時は CG の両端） */
  ends?: [Point2, Point2]
  /** STEP 10：このフレームで実際に検出された（追跡フィルタの保持中でない）。省略時は true */
  measured?: boolean
  /** STEP 10：灰を付ける CG か（パイプは false）。省略時は true */
  hasAsh?: boolean
}

/** cigarette（1 本）で渡したタバコの着火状態のキー */
export const SOLO_CIGARETTE = 'solo'

export type FireFrame = {
  lighter: TrackedPen | null
  /** ライターの火口（ライターを検出していれば） */
  lighterNozzle: Point2 | null
  /** 最初のタバコ（1 人モードではそのタバコ）の着火状態 */
  ignition: IgnitionOutput
  /** STEP 5：タバコ（キー）ごとの着火状態。今フレームでタバコが無いキーも、着火状態を覚えていれば含む */
  ignitions: Map<string, IgnitionOutput>
  flames: ActiveFlame[]
  snapEvent: SnapEvent | null
  /** STEP 10：タバコごとの燃焼の状態・灰（キーは ignitions と同じ） */
  lives: Map<string, LifeView>
  /** STEP 10：このフレームで灰を落としたか */
  ashEvent: AshTapEvent | null
  /** STEP 10：このフレームの燃焼の状態の変化（シケモクになった・新品に戻った） */
  lifeEvents: LifeEvent[]
  /** STEP 13：このフレームで手を振って炎を消した手（無ければ null） */
  waveEvent: { handKey: string; time: number } | null
  /** STEP 12：手ごとの FREE / HOLDING / UNKNOWN と、着火ジェスチャーを止めた理由 */
  handViews: Map<string, HandFireView>
}

/**
 * 炎とタバコの着火をまとめて管理する。
 * - 着火ジェスチャー（SnapDetector。STEP 10 から親指と人差し指）→ 人差し指の先端に炎（STEP 10 から 5 秒、その手に追従）
 * - ライター（検出 + 追跡フィルタ）→ ボタンを押している間、火口に炎
 * - 手動ボタン → 指先（手が無ければ画面中央）に炎
 * - 炎とタバコの火側の端の距離 → 着火状態（UNLIT / LIT）
 *
 * STEP 5：着火状態をタバコ（人物）ごとに持つ。1 つの炎は、火側の端が最も近い 1 本のタバコだけを着火の対象にする
 * （隣の人のタバコを同時に、または代わりに着火しない）。タバコが 1 本なら STEP 4 と同じ判定になる。
 *
 * STEP 10：タバコごとの燃焼寿命（NEW / BURNING / BUTT）と灰（CigaretteLifeManager）、灰落としのタップ（AshTapDetector）、
 * 落ちる灰（AshEffect）も管理する。シケモク（BUTT）は着火できない。
 */
export class FireController {
  readonly flames = new FlameEffect()
  readonly snap = new SnapDetector()
  private readonly ignitions = new Map<string, IgnitionStateMachine>()
  private readonly lighterFilter = new PenTrackingFilter()
  readonly life = new CigaretteLifeManager()
  readonly taps = new AshTapDetector()
  readonly ash = new AshEffect()
  /** STEP 11：着火ジェスチャーの成功時の「SNAP!」 */
  readonly bursts = new SnapBurstEffect()
  /** STEP 13：手を振る動き */
  readonly waves = new WaveDetector()
  /** STEP 12：手がタバコを持っているかの推定 */
  readonly holds = new HandHoldEstimator()
  private handViews = new Map<string, HandFireView>()
  private ashDropRequested = false

  /** キーの着火状態（無ければ UNLIT で作る） */
  ignition(key: string = SOLO_CIGARETTE): IgnitionStateMachine {
    let fsm = this.ignitions.get(key)
    if (!fsm) {
      fsm = new IgnitionStateMachine()
      this.ignitions.set(key, fsm)
    }
    return fsm
  }

  /** 全員の手動着火・消火（1 人モードの「手動着火」「消火」ボタン） */
  lightAll(keys: string[]): void {
    // シケモクは着火できない（新品に戻すまで）
    for (const key of keys) if (this.life.state(key) !== 'BUTT') this.ignition(key).light()
  }

  /** STEP 10（デバッグ）：次のフレームで、着火中のタバコの灰を落とす */
  requestAshDrop(): void {
    this.ashDropRequested = true
  }

  /** STEP 10（デバッグ）：シケモクにする（火も消える） */
  forceButt(keys: string[]): void {
    for (const key of keys) {
      this.life.forceButt(key)
      this.ignition(key).extinguish()
    }
  }

  /** STEP 10（デバッグ）：新品に戻す（未着火・燃焼時間 0・灰なし） */
  renew(keys: string[]): void {
    for (const key of keys) {
      this.life.renew(key)
      this.ignition(key).extinguish()
      this.taps.forgetTarget(key)
    }
  }

  extinguishAll(): void {
    for (const fsm of this.ignitions.values()) fsm.extinguish()
  }

  /** 人物の追跡データを破棄したときに、その着火状態も捨てる */
  forget(key: string): void {
    this.ignitions.delete(key)
    this.life.forget(key)
    this.taps.forgetTarget(key)
  }

  /** 着火状態を覚えているキー */
  get ignitionKeys(): string[] {
    return [...this.ignitions.keys()]
  }

  update(input: FireFrameInput): FireFrame {
    const { now, settings } = input
    let snapEvent: SnapEvent | null = null
    const cigarettes: FireCigarette[] =
      input.cigarettes ?? (input.cigarette ? [{ ...input.cigarette, key: SOLO_CIGARETTE }] : [])
    const snappedHands = new Set<string>()

    // STEP 12：手がタバコを持っているか（FREE / HOLDING / UNKNOWN）。新しい推論結果ごとに更新する
    if (input.handsFresh) {
      const holdPens =
        input.holdPens ??
        cigarettes.map((c) => ({
          key: c.key ?? SOLO_CIGARETTE,
          owner: c.key ?? SOLO_CIGARETTE,
          a: c.mouthEnd,
          b: c.emberEnd,
          emberKnown: true,
          measured: c.measured ?? true,
        }))
      const holds = this.holds.update(now, input.hands, holdPens, input.handOwners)
      this.handViews = new Map([...holds].map(([key, v]) => [key, { ...v, blockedReason: null }]))
    }

    // 着火ジェスチャー：新しい推論結果ごとに判定し、炎はその手の人差し指の先端に追従させる
    if (settings.snapEnabled) {
      for (const hand of input.hands) {
        const view = this.handViews.get(hand.key)
        if (input.handsFresh && view?.state === 'HOLDING') {
          // STEP 12：タバコを持っている手では着火ジェスチャーを判定しない（灰落としは判定する）。UNKNOWN の手は判定を続ける
          view.blockedReason = `タバコを持っている手（${view.penKey ?? '—'}）`
          this.snap.block(hand.key, hand.sample, settings.snap, view.blockedReason)
        } else if (input.handsFresh) {
          // STEP 10：親指と人差し指でタバコ（ペン）をつまんでいる接触は、着火ジェスチャーにしない
          const event = this.snap.update(hand.key, hand.sample, settings.snap, { holdingPen: pinchOnCigarette(hand, cigarettes) })
          if (event) {
            snapEvent = event
            snappedHands.add(hand.key)
            this.flames.spawn('snap', event.position, flameSizeForHand(hand), now, hand.key)
            // STEP 11：同じ成功イベントで、その手の人差し指の先端の上に「SNAP!」
            this.bursts.spawn(event.position, hand.sample.scale, now, hand.key)
          }
        }
        const tip = fingerTip(hand)
        const prev = this.flames.positionOf(hand.key)
        // 別の手の指先へ炎が飛び移らないよう、急に遠くへ動いたときは追従しない（見失ったときと同じく保持 → フェードアウト）
        if (!prev || Math.hypot(tip.x - prev.x, tip.y - prev.y) <= Math.max(hand.sample.scale, 1) * FLAME_MAX_JUMP) {
          this.flames.follow(hand.key, tip, now)
        }
      }
    }
    this.flames.releaseLostHands(now, FLAME_LOST_HOLD_MS)
    // STEP 13：手を振ったら、その手の指先の炎を消す（タバコの火・ライターの炎は消さない）
    let waveEvent: { handKey: string; time: number } | null = null
    if (input.handsFresh) {
      for (const hand of input.hands) {
        const waved = this.waves.update(hand.key, hand.sample)
        if (waved && settings.waveExtinguish && !snappedHands.has(hand.key) && this.flames.douse(hand.key, now)) {
          waveEvent = { handKey: hand.key, time: now }
        }
      }
    }
    // STEP 11：完全に見失った手の途中経過を捨てる
    this.snap.prune(now)

    // STEP 10：灰落とし（着火中・シケモクでない・灰を付ける CG のタバコを、人差し指で 2 回叩く）
    let ashEvent: AshTapEvent | null = null
    const tapTargets: TapTarget[] = settings.ash.enabled
      ? cigarettes.flatMap((c) => {
          const key = c.key ?? SOLO_CIGARETTE
          if (c.hasAsh === false || this.ignition(key).current !== 'LIT' || this.life.state(key) === 'BUTT') return []
          return [tapTarget(c, key)]
        })
      : []
    if (input.handsFresh) {
      for (const hand of input.hands) {
        const owner = input.handOwners?.get(hand.key)
        const blocked =
          snappedHands.has(hand.key) ||
          this.snap.isGesturing(hand.key) ||
          hand.sample.time - this.snap.lastSuccessAt(hand.key) < TAP_TIMING.snapBlockMs
        const event = this.taps.update(hand.key, hand.sample, tapTargets, settings.ash, {
          allowedKeys: input.handOwners ? new Set(owner ? [owner] : []) : null,
          blocked,
        })
        if (event && !ashEvent) ashEvent = event
      }
    }
    if (this.ashDropRequested) {
      this.ashDropRequested = false
      for (const t of tapTargets) this.dropAsh(t, now)
    }
    if (ashEvent) {
      const t = tapTargets.find((c) => c.key === ashEvent!.cigaretteKey)
      if (t) this.dropAsh(t, now)
    }

    if (input.manualFlameRequested) {
      // 手動の炎も、着火ジェスチャーと同じ表示時間（FLAME_DURATION_MS）
      // STEP 11：手が無ければ、最初のタバコの火側の端（炎の胴体が火側の端に重なる位置）。タバコも無ければ画面中央
      const hand = input.hands[0]
      const c0 = cigarettes[0]
      const size = hand ? flameSizeForHand(hand) : c0 ? Math.max(c0.length * 0.35, 14) : input.frameWidth * 0.08
      const position = hand
        ? fingerTip(hand)
        : c0
          ? { x: c0.emberEnd.x, y: c0.emberEnd.y + size * 0.3 }
          : { x: input.frameWidth / 2, y: input.frameHeight * 0.55 }
      this.flames.spawn('manual', position, size, now, hand?.key ?? null)
    }

    // ライター：平滑化した検出結果の火口に、ボタンを押している間だけ炎を出す
    const lighter = settings.lighterEnabled
      ? this.lighterFilter.update(input.lighterMeasured, now, LIGHTER_TRACKING)
      : null
    if (!settings.lighterEnabled) this.lighterFilter.reset()
    const nozzle = lighter ? lighterNozzle(lighter) : null
    this.flames.setLighter(
      input.lighterPressed && nozzle ? nozzle.flameBase : null,
      lighter ? Math.max(lighter.thickness * 1.5, 12) : 0,
      now,
    )

    this.flames.update(now)
    this.bursts.update(now)
    const flames = this.flames.active(now)
    // 炎ごとに、火側の端が最も近いタバコを 1 本だけ選ぶ（STEP 11：距離は表示している炎の根元〜先端の線分から測る）
    const flamesFor = new Map<string, FlameShape[]>()
    for (const f of flames) {
      const shape: FlameShape = { base: f.base, tip: f.tip }
      const distanceTo = (c: FireCigarette) => {
        const q = nearestOnFlame(c.emberEnd, shape)
        return Math.hypot(q.x - c.emberEnd.x, q.y - c.emberEnd.y) / Math.max(c.length, 1)
      }
      let target: string | null = null
      let best = Infinity
      for (const c of cigarettes) {
        const d = distanceTo(c)
        if (d < best) {
          best = d
          target = c.key ?? SOLO_CIGARETTE
        }
      }
      // STEP 11：複数人では、炎を出した手の持ち主のタバコが着火距離内にあれば、そちらを優先する
      const owner = f.handKey !== null ? input.handOwners?.get(f.handKey) : undefined
      const own = owner ? cigarettes.find((c) => (c.key ?? SOLO_CIGARETTE) === owner) : undefined
      if (own && distanceTo(own) <= settings.ignition.igniteDistance) target = owner!
      if (target !== null) flamesFor.set(target, [...(flamesFor.get(target) ?? []), shape])
    }
    const ignitions = new Map<string, IgnitionOutput>()
    for (const c of cigarettes) {
      const key = c.key ?? SOLO_CIGARETTE
      // STEP 10：シケモクは着火しない（炎を当てても無視する）
      const butt = this.life.state(key) === 'BUTT'
      if (butt && this.ignition(key).current === 'LIT') this.ignition(key).extinguish()
      const out = this.ignition(key).update(
        {
          now,
          emberEnd: c.emberEnd,
          mouthEnd: c.mouthEnd,
          cigaretteLength: c.length,
          flames: butt ? [] : (flamesFor.get(key) ?? []),
        },
        settings.ignition,
      )
      ignitions.set(key, butt ? { ...out, reason: 'シケモクは着火しない（新品に戻すまで）' } : out)
    }
    // タバコが今フレーム無いキー：接触の途中経過だけを捨て、着火状態は保持する
    for (const [key, fsm] of this.ignitions) {
      if (ignitions.has(key)) continue
      ignitions.set(
        key,
        fsm.update({ now, emberEnd: null, mouthEnd: null, cigaretteLength: 0, flames: [] }, settings.ignition),
      )
    }

    // STEP 10：燃焼時間と灰（着火中で実際に映っている間だけ進む）。シケモクになったら火を消す
    const lifeEvents = this.life.update(
      now,
      input.frameWidth,
      input.frameHeight,
      cigarettes.map((c) => {
        const key = c.key ?? SOLO_CIGARETTE
        return { key, ends: c.ends ?? [c.mouthEnd, c.emberEnd], measured: c.measured ?? true, lit: ignitions.get(key)?.state === 'LIT' }
      }),
      settings.ash.enabled ? settings.ash.growthRate : 0,
    )
    for (const e of lifeEvents) {
      this.ignition(e.key).extinguish()
      if (e.kind === 'renewed') this.taps.forgetTarget(e.key)
      const out = ignitions.get(e.key)
      if (out) ignitions.set(e.key, { ...out, state: 'UNLIT' })
    }
    const lives = new Map<string, LifeView>()
    for (const key of new Set([...ignitions.keys(), ...this.life.keys])) lives.set(key, this.life.view(key, now))
    this.ash.setFrame(input.frameHeight)
    this.ash.update(now)

    const firstKey = cigarettes[0]?.key ?? SOLO_CIGARETTE
    const ignition =
      ignitions.get(firstKey) ??
      this.ignition(firstKey).update({ now, emberEnd: null, mouthEnd: null, cigaretteLength: 0, flames: [] }, settings.ignition)
    return {
      lighter,
      lighterNozzle: nozzle?.nozzle ?? null,
      ignition,
      ignitions,
      flames,
      snapEvent,
      lives,
      ashEvent,
      lifeEvents,
      waveEvent,
      handViews: this.handViews,
    }
  }

  /** 灰を落とす：先端に少し残して、落ちる灰の粒子を出す */
  private dropAsh(t: TapTarget, now: number): void {
    const ash = this.life.view(t.key, now).ash
    const dropped = this.life.dropAsh(t.key, now)
    if (dropped <= 0 && ash <= 0) return
    const ashLength = Math.max(dropped, 0.02) * t.length
    // 灰は火側の端（燃えている部分）から先に伸びている
    const tip = { x: t.center.x + t.dir.x * t.length * 0.5, y: t.center.y + t.dir.y * t.length * 0.5 }
    this.ash.drop({
      position: { x: tip.x + t.dir.x * ashLength * 0.5, y: tip.y + t.dir.y * ashLength * 0.5 },
      dir: t.dir,
      ashLength,
      thickness: t.thickness,
    })
  }

  /** 炎と落ちる灰を描く（タバコ CG の後） */
  draw(ctx: CanvasRenderingContext2D, now: number): void {
    this.ash.draw(ctx)
    this.flames.draw(ctx, now)
    // STEP 11：「SNAP!」は炎の上に重ねる（写真にも AR の canvas ごと写る）
    this.bursts.draw(ctx, now)
  }

  /** カメラ停止・座標系の変更時に、炎・手の途中経過・ライターの追跡を捨てる（着火状態は残す） */
  resetTracking(): void {
    this.flames.clear()
    this.bursts.clear()
    this.waves.reset()
    this.snap.reset()
    // STEP 12：座標系が変わるので、持っているかの推定もやり直す
    this.holds.reset()
    this.handViews = new Map()
    this.lighterFilter.reset()
    // STEP 10：タップの途中経過・落ちる灰・退出の推定に使う位置を捨てる（燃焼の状態・時間・灰の長さは残す）
    this.taps.reset()
    this.ash.clear()
    this.life.resetTracking()
  }
}

/** STEP 9：炎を出す指先（人差し指の先端。古い形式のデータでランドマーク 8 が無ければ親指の先端） */
function fingerTip(hand: TrackedHand): Point2 {
  return hand.sample.indexTip ?? hand.sample.thumbTip
}

/**
 * STEP 10：タップの対象。center・dir は「火側の端（燃えている部分）」を基準にする：
 * TapTarget の center + dir × length/2 が火側の端になるよう、吸い口〜火側の端の線分から作る。
 */
function tapTarget(c: FireCigarette, key: string): TapTarget {
  const dx = c.emberEnd.x - c.mouthEnd.x
  const dy = c.emberEnd.y - c.mouthEnd.y
  const len = Math.hypot(dx, dy) || 1
  return {
    key,
    center: { x: (c.emberEnd.x + c.mouthEnd.x) / 2, y: (c.emberEnd.y + c.mouthEnd.y) / 2 },
    dir: { x: dx / len, y: dy / len },
    length: len,
    thickness: c.thickness ?? c.length * 0.08,
  }
}

/**
 * STEP 10：親指と人差し指の先端の中点が、タバコの軸の近くにある（ペンをつまんでいる）。
 * STEP 11：火側の端の近く（吸い口 → 火側の端の HOLD_ALONG_MAX より先）は除く。もう一方の手で火側の端のそばで
 * 着火ジェスチャーをしたときに「つまんでいる」と誤って判定し、炎が出なかったため。軸からの距離の上限も狭めた
 * （太さ × 1.5 または 手の大きさ × 0.25 → 太さ × 1.2 または 手の大きさ × 0.18）。
 */
export function pinchOnCigarette(hand: TrackedHand, cigarettes: FireCigarette[]): boolean {
  const s = hand.sample
  if (!s.indexTip) return false
  const m = { x: (s.thumbTip.x + s.indexTip.x) / 2, y: (s.thumbTip.y + s.indexTip.y) / 2 }
  for (const c of cigarettes) {
    const a = c.mouthEnd
    const b = c.emberEnd
    const vx = b.x - a.x
    const vy = b.y - a.y
    const len2 = vx * vx + vy * vy || 1
    const t = ((m.x - a.x) * vx + (m.y - a.y) * vy) / len2
    if (t < -HOLD_ALONG_MARGIN || t > HOLD_ALONG_MAX) continue
    const limit = Math.max((c.thickness ?? c.length * 0.08) * 1.2, s.scale * 0.18)
    if (segmentDistance(m, a, b) <= limit) return true
  }
  return false
}

/** STEP 11：つまんでいるとみなす軸方向の範囲（吸い口 0 → 火側の端 1。吸い口の少し外から、火側の端の手前まで） */
const HOLD_ALONG_MARGIN = 0.1
const HOLD_ALONG_MAX = 0.8

function segmentDistance(p: Point2, a: Point2, b: Point2): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const len2 = vx * vx + vy * vy || 1
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2))
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t))
}

/** 指パッチンの炎の大きさ：手の大きさ（手首〜中指の付け根）の 0.9 倍 */
function flameSizeForHand(hand: TrackedHand): number {
  return Math.max(hand.sample.scale * 0.9, 14)
}
