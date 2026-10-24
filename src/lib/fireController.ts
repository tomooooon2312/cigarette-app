import { FlameEffect, type ActiveFlame } from './flameEffect'
import type { TrackedHand } from './handTracker'
import {
  DEFAULT_IGNITION,
  IgnitionStateMachine,
  type IgnitionOutput,
  type IgnitionSettings,
} from './ignition'
import { DEFAULT_LIGHTER, lighterNozzle, type LighterSettings } from './lighterDetector'
import type { PenDetection, Point2 } from './penGeometry'
import { PenTrackingFilter, type TrackedPen } from './penTracking'
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
}

export const DEFAULT_FIRE: FireSettings = {
  snapEnabled: true,
  lighterEnabled: true,
  handIntervalMs: 0,
  snap: DEFAULT_SNAP,
  ignition: DEFAULT_IGNITION,
  lighter: DEFAULT_LIGHTER,
}

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
}

/** 着火判定の対象となるタバコ 1 本 */
export type FireCigarette = {
  /** 着火状態を持つ単位（人物 ID）。cigarette で渡した場合は SOLO_CIGARETTE */
  key?: string
  emberEnd: Point2
  mouthEnd: Point2
  length: number
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
}

/**
 * 炎とタバコの着火をまとめて管理する。
 * - 指パッチン（SnapDetector）→ 親指の先端に炎（2.5 秒、その手に追従）
 * - ライター（検出 + 追跡フィルタ）→ ボタンを押している間、火口に炎
 * - 手動ボタン → 指先（手が無ければ画面中央）に炎
 * - 炎とタバコの火側の端の距離 → 着火状態（UNLIT / LIT）
 *
 * STEP 5：着火状態をタバコ（人物）ごとに持つ。1 つの炎は、火側の端が最も近い 1 本のタバコだけを着火の対象にする
 * （隣の人のタバコを同時に、または代わりに着火しない）。タバコが 1 本なら STEP 4 と同じ判定になる。
 */
export class FireController {
  readonly flames = new FlameEffect()
  readonly snap = new SnapDetector()
  private readonly ignitions = new Map<string, IgnitionStateMachine>()
  private readonly lighterFilter = new PenTrackingFilter()

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
    for (const key of keys) this.ignition(key).light()
  }

  extinguishAll(): void {
    for (const fsm of this.ignitions.values()) fsm.extinguish()
  }

  /** 人物の追跡データを破棄したときに、その着火状態も捨てる */
  forget(key: string): void {
    this.ignitions.delete(key)
  }

  /** 着火状態を覚えているキー */
  get ignitionKeys(): string[] {
    return [...this.ignitions.keys()]
  }

  update(input: FireFrameInput): FireFrame {
    const { now, settings } = input
    let snapEvent: SnapEvent | null = null

    // 指パッチン：新しい推論結果ごとに判定し、炎はその手の親指の先端に追従させる
    if (settings.snapEnabled) {
      for (const hand of input.hands) {
        if (input.handsFresh) {
          const event = this.snap.update(hand.key, hand.sample, settings.snap)
          if (event) {
            snapEvent = event
            this.flames.spawn('snap', event.position, flameSizeForHand(hand), now, hand.key)
          }
        }
        this.flames.follow(hand.key, hand.sample.thumbTip)
      }
    }

    if (input.manualFlameRequested) {
      const hand = input.hands[0]
      const position = hand?.sample.thumbTip ?? { x: input.frameWidth / 2, y: input.frameHeight * 0.55 }
      this.flames.spawn(
        'manual',
        position,
        hand ? flameSizeForHand(hand) : input.frameWidth * 0.08,
        now,
        hand?.key ?? null,
      )
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
    const flames = this.flames.active(now)
    const cigarettes: FireCigarette[] =
      input.cigarettes ?? (input.cigarette ? [{ ...input.cigarette, key: SOLO_CIGARETTE }] : [])
    // 炎ごとに、火側の端が最も近いタバコを 1 本だけ選ぶ
    const flamesFor = new Map<string, Point2[]>()
    for (const f of flames) {
      let target: string | null = null
      let best = Infinity
      for (const c of cigarettes) {
        const d = Math.hypot(f.position.x - c.emberEnd.x, f.position.y - c.emberEnd.y) / Math.max(c.length, 1)
        if (d < best) {
          best = d
          target = c.key ?? SOLO_CIGARETTE
        }
      }
      if (target !== null) flamesFor.set(target, [...(flamesFor.get(target) ?? []), f.position])
    }
    const ignitions = new Map<string, IgnitionOutput>()
    for (const c of cigarettes) {
      const key = c.key ?? SOLO_CIGARETTE
      ignitions.set(
        key,
        this.ignition(key).update(
          {
            now,
            emberEnd: c.emberEnd,
            mouthEnd: c.mouthEnd,
            cigaretteLength: c.length,
            flames: flamesFor.get(key) ?? [],
          },
          settings.ignition,
        ),
      )
    }
    // タバコが今フレーム無いキー：接触の途中経過だけを捨て、着火状態は保持する
    for (const [key, fsm] of this.ignitions) {
      if (ignitions.has(key)) continue
      ignitions.set(
        key,
        fsm.update({ now, emberEnd: null, mouthEnd: null, cigaretteLength: 0, flames: [] }, settings.ignition),
      )
    }
    const firstKey = cigarettes[0]?.key ?? SOLO_CIGARETTE
    const ignition =
      ignitions.get(firstKey) ??
      this.ignition(firstKey).update({ now, emberEnd: null, mouthEnd: null, cigaretteLength: 0, flames: [] }, settings.ignition)
    return { lighter, lighterNozzle: nozzle?.nozzle ?? null, ignition, ignitions, flames, snapEvent }
  }

  draw(ctx: CanvasRenderingContext2D, now: number): void {
    this.flames.draw(ctx, now)
  }

  /** カメラ停止・座標系の変更時に、炎・手の途中経過・ライターの追跡を捨てる（着火状態は残す） */
  resetTracking(): void {
    this.flames.clear()
    this.snap.reset()
    this.lighterFilter.reset()
  }
}

/** 指パッチンの炎の大きさ：手の大きさ（手首〜中指の付け根）の 0.9 倍 */
function flameSizeForHand(hand: TrackedHand): number {
  return Math.max(hand.sample.scale * 0.9, 14)
}
