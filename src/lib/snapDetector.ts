import type { Point2 } from './penGeometry'

/** 3D の点（MediaPipe のワールドランドマーク、メートル。手のおおよその中心が原点） */
export type Point3 = { x: number; y: number; z: number }

/** 着火ジェスチャーの判定に使う手のランドマーク（表示座標 px） */
export type HandSample = {
  /** 推論結果の時刻 ms */
  time: number
  /** 親指の先端（ランドマーク 4） */
  thumbTip: Point2
  /** 中指の先端（ランドマーク 12）。STEP 10 から判定には使わない（STEP 4〜9 の中指の判定の名残。無くてもよい） */
  middleTip?: Point2
  wrist: Point2
  indexMcp: Point2
  pinkyMcp: Point2
  /** 人差し指の先端（ランドマーク 8）。STEP 10 の着火ジェスチャーと、炎を出す位置。無ければ親指の先端を使う */
  indexTip?: Point2
  /** STEP 10：人差し指の第 2 関節（ランドマーク 6）。灰落としのタップの判定に使う */
  indexPip?: Point2
  /** 手の大きさ px（手首〜中指の付け根）。距離・速度の正規化に使う */
  scale: number
  /**
   * 3D のワールドランドマーク（STEP 9）。STEP 10 では補助として、親指と人差し指の 3D の距離に使う。
   * 無ければ 2D だけで判定する。
   */
  world?: {
    thumbTip: Point3
    middleTip: Point3
    wrist: Point3
    indexMcp: Point3
    pinkyMcp: Point3
    middleMcp: Point3
    /** STEP 10：人差し指の先端 */
    indexTip?: Point3
  }
  /** 手の検出の信頼度（MediaPipe の handedness のスコア、0〜1）。低いときは判定しない */
  confidence?: number
}

/*
 * STEP 10：親指と人差し指による簡易な着火ジェスチャー（「指パッチン」の代わり）。
 * 距離はすべて「手の大きさ」（手首〜中指の付け根の長さ。手の向きによって縮みにくいよう、手のひらの幅からも推定した大きい方）で割った値。
 * この単位は手の全長（手首〜中指の先端）のおよそ半分（成人で 8〜9cm）。
 * 速さは「手の大きさ / 秒」。時間は推論結果の時刻（timestamp）で測り、フレームレートに依存しない。
 *
 * STEP 11：成功率の改善のため値を見直した（括弧内は STEP 10 の値）。
 * 指示書の候補（手の全長に対して 接触 0.20・離脱 0.35）をこの単位に直すと約 0.42・0.75 になるが、
 * 接触 0.42 は指を軽く曲げただけの手でも接触になり誤発火が増えるため、その間の値にした。
 */
/** 親指と人差し指の先端の距離がこれ以下で「接触」（手の大きさに対する比率。0.3） */
export const CONTACT_DISTANCE_THRESHOLD = 0.32
/** 接触中は、距離がこれを超えるまで接触とみなす（ヒステリシス。しきい値付近での接触・離脱の切り替わりを防ぐ。0.42） */
export const CONTACT_EXIT_DISTANCE = 0.42
/** 離した後、距離がこれ以上になったら「素早く離れた」かを評価する（手の大きさに対する比率。0.6） */
export const RELEASE_DISTANCE_THRESHOLD = 0.5
/**
 * 接触がこの時間以上続いたら準備完了 ms（60）。
 * 接触の時間は「最初の接触の推論結果 〜 最後の接触の推論結果」に推論の間隔 1 回分を足した推定値で測る
 * （推論 15 回/秒なら 1 回の接触の推論結果で足り、30 回/秒なら 2 回必要）。
 */
export const MIN_CONTACT_DURATION_MS = 50
/** 最後の接触から、離れる距離に達するまでの制限時間 ms（これより遅い＝ゆっくり開いた。300） */
export const MAX_RELEASE_DURATION_MS = 350
/** 離れる速さ（距離の増え方）の下限（手の大きさ / 秒）。ゆっくり開いた動きを除く（1.8） */
export const MIN_RELEASE_SPEED = 1.0
/** 判定した後、同じ手で次の判定を受け付けない時間 ms（手ごと。900） */
export const SNAP_COOLDOWN_MS = 600
/** 推論の間隔の推定値の範囲 ms（接触の時間の推定に使う。最初の推論結果では既定値） */
export const SAMPLE_INTERVAL_DEFAULT_MS = 33
export const SAMPLE_INTERVAL_MAX_MS = 120
/** 成功・失敗の表示を残す時間 ms（デバッグ表示） */
export const RESULT_DISPLAY_MS = 600

export type SnapSettings = {
  /** 接触の距離（CONTACT_DISTANCE_THRESHOLD） */
  contactDistance: number
  /** STEP 11：接触の解除の距離（CONTACT_EXIT_DISTANCE）。contactDistance 以上、releaseDistance 未満で使う */
  contactExitDistance: number
  /** 離れる距離（RELEASE_DISTANCE_THRESHOLD） */
  releaseDistance: number
  /** 離れる速さの下限（MIN_RELEASE_SPEED） */
  minSpeed: number
  /** クールダウン ms（SNAP_COOLDOWN_MS） */
  cooldownMs: number
  /** 準備完了までの接触時間 ms（MIN_CONTACT_DURATION_MS） */
  minContactMs: number
  /** 離れるまでの制限時間 ms（MAX_RELEASE_DURATION_MS） */
  maxReleaseMs: number
}

export const DEFAULT_SNAP: SnapSettings = {
  contactDistance: CONTACT_DISTANCE_THRESHOLD,
  contactExitDistance: CONTACT_EXIT_DISTANCE,
  releaseDistance: RELEASE_DISTANCE_THRESHOLD,
  minSpeed: MIN_RELEASE_SPEED,
  cooldownMs: SNAP_COOLDOWN_MS,
  minContactMs: MIN_CONTACT_DURATION_MS,
  maxReleaseMs: MAX_RELEASE_DURATION_MS,
}

export const SNAP_TIMING = {
  /** この時間サンプルが来なければ手を見失ったとみなし、途中経過を捨てる ms */
  lostMs: 300,
  /** 手の検出の信頼度がこれ未満の推論結果は使わない */
  minConfidence: 0.5,
  /** 3D の手の大きさが、直近の値からこの割合以上変わった推論結果では 3D の距離を使わない（2D だけにする） */
  maxScaleChange: 0.35,
  /** 手首がこれより速く動いていたら判定しない（手の大きさ / 秒）。STEP 9 の 3.5 から緩めた（手を大きく振ったときだけ除く） */
  maxWristSpeed: 8,
  /** 手のひらの幅（人差し指〜小指の付け根）から手の大きさを推定するときの倍率 */
  palmWidthRatio: 1.3,
} as const

export type SnapEvent = {
  handKey: string
  /** 炎を出す位置（人差し指の先端。無ければ親指の先端） */
  position: Point2
  time: number
}

/** 判定の段階：open（離れている）/ contact（接触中・準備前）/ armed（準備完了）/ releasing（離している途中） */
export type SnapPhase = 'open' | 'contact' | 'armed' | 'releasing'

/** STEP 11：表示用の状態（接触中／離脱中／成功／失敗／クールダウン） */
export type SnapStatus = 'open' | 'contact' | 'releasing' | 'success' | 'failed' | 'cooldown' | 'blocked' | 'waitOpen'

export type SnapDebug = {
  /** STEP 11：表示用の状態（STEP 12：blocked = タバコを持つ手で判定を止めている、waitOpen = 指を開くまで待っている） */
  status: SnapStatus
  /** STEP 12：判定を止めている理由（止めていなければ null） */
  blocked: string | null
  /** STEP 11：推論の間隔の推定値 ms */
  intervalMs: number
  /** STEP 11：手の検出の信頼度（無ければ null） */
  confidence: number | null
  /** 親指と人差し指の距離（正規化） */
  distance: number
  /** 準備完了または離している途中 */
  armed: boolean
  phase: SnapPhase
  /** 3D の距離も使ったか */
  mode: '3d' | '2d'
  /** 信頼度が低くて使わなかったか */
  unreliable: boolean
  /** 接触している時間 ms（接触中のみ。それ以外は直前の接触の時間） */
  contactMs: number
  /** 直前に評価した離れる速さ（手の大きさ / 秒） */
  releaseSpeed: number
  /** ペンをつまんでいる接触（着火ジェスチャーにしない） */
  holding: boolean
  /** この手のクールダウンの残り ms */
  cooldownMs: number
}

/** 「接触 → 離す」を 1 回評価した結果（デバッグ表示用） */
export type SnapAttempt = {
  handKey: string
  time: number
  ok: boolean
  /** 失敗の理由（成功なら空） */
  reasons: string[]
  /** 離れる速さ（手の大きさ / 秒） */
  speed: number
  /** 接触の時間 ms */
  contactMs: number
  wristSpeed: number
  mode: '3d' | '2d'
}

export type SnapUpdateOptions = {
  /** 親指と人差し指でペン（タバコ）をつまんでいる。接触の開始時に true なら、その接触は着火ジェスチャーにしない */
  holdingPen?: boolean
}

type HandState = {
  phase: SnapPhase
  contactStart: number
  /** 最後に接触していた推論結果 */
  lastContactTime: number
  lastContactDistance: number
  lastContactWrist: Point2
  holding: boolean
  lastTime: number
  /** 3D の手の大きさの移動平均（指が隠れたときの形の崩れを見つける） */
  scale3d: number | null
  /** STEP 11：推論の間隔の推定値 ms（移動平均） */
  interval: number
  /** STEP 11：直前の評価の結果と時刻（表示用） */
  lastResult: { ok: boolean; time: number } | null
  /**
   * STEP 12：判定を止めていた手（タバコを持っていた手）は、親指と人差し指が一度開く（接触の解除距離以上）まで、
   * 接触を数えない。持つのをやめた瞬間の「つまんだ指を離す」動きを着火ジェスチャーにしないため。
   */
  waitOpen: boolean
  debug: SnapDebug
}

const dist = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y)
const dist3 = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/**
 * 2D の手の大きさ：手首〜中指の付け根の長さと、手のひらの幅から推定した長さの大きい方。
 * 手を横に向けると手のひらの幅が、手をカメラに向けると手首〜付け根の長さが縮むので、大きい方を使うと向きの影響を受けにくい。
 */
export function handScale2d(s: HandSample): number {
  return Math.max(s.scale, dist(s.indexMcp, s.pinkyMcp) * SNAP_TIMING.palmWidthRatio, 1)
}

/** 親指と人差し指の 2D の距離（正規化）。人差し指の先端が無ければ Infinity（判定しない） */
export function pinchDistance2d(s: HandSample): number {
  return s.indexTip ? dist(s.thumbTip, s.indexTip) / handScale2d(s) : Infinity
}

/** 親指と人差し指の 3D の距離（正規化）。ワールドランドマークが無ければ null */
export function pinchDistance3d(s: HandSample): { distance: number; scale: number } | null {
  const w = s.world
  if (!w?.indexTip) return null
  const scale = Math.max(dist3(w.wrist, w.middleMcp), 1e-4)
  return { distance: dist3(w.thumbTip, w.indexTip) / scale, scale }
}

/**
 * STEP 10：親指と人差し指の簡易な着火ジェスチャーの判定。手ごと（handKey）に状態とクールダウンを持つ。
 *
 * 1. 接近：親指と人差し指の先端の距離（手の大きさで正規化）が接触距離以下になる。
 * 2. 保持：接触（ヒステリシス付き）が MIN_CONTACT_DURATION_MS 以上続くと準備完了。
 * 3. 離脱：準備完了の後、最後の接触から MAX_RELEASE_DURATION_MS 以内に離れる距離に達し、
 *    距離の増え方が MIN_RELEASE_SPEED 以上なら成功。ゆっくり開いたときは失敗。
 * 4. クールダウン：成功した手は SNAP_COOLDOWN_MS の間、次の判定をしない。1 回の「接触 → 離す」は 1 回だけ評価する。
 *
 * 距離は 2D（手の大きさは手のひらの幅も使う）を基本にし、3D のワールドランドマークが安定していれば
 * 3D の距離との小さい方を使う（手の甲側・横向きで 2D の距離が実際より大きく見える場合に、3D で補う）。
 * 中指の位置・動きと、画面上の絶対的な向き（上下左右）は使わない。
 * 手首が大きく動いたとき（手を振った）と、ペンをつまんでいる接触は判定しない。
 */
export class SnapDetector {
  private hands = new Map<string, HandState>()
  private lastSnapAt = new Map<string, number>()
  private attempts: SnapAttempt[] = []
  private successCount = 0

  reset(): void {
    this.hands.clear()
    this.lastSnapAt.clear()
    this.attempts = []
  }

  debug(handKey: string): SnapDebug | null {
    return this.hands.get(handKey)?.debug ?? null
  }

  /** 直近の評価の結果（新しい順、最大 8 件） */
  get recentAttempts(): SnapAttempt[] {
    return this.attempts
  }

  get successes(): number {
    return this.successCount
  }

  /** その手が着火ジェスチャーの途中（接触中・準備完了・離している途中）か。ペンをつまんでいる接触は含めない */
  isGesturing(handKey: string): boolean {
    const h = this.hands.get(handKey)
    return h !== undefined && h.phase !== 'open' && !h.holding
  }

  /** その手が最後に着火ジェスチャーに成功した時刻（無ければ -Infinity） */
  lastSuccessAt(handKey: string): number {
    return this.lastSnapAt.get(handKey) ?? -Infinity
  }

  /**
   * STEP 11：lostMs より長く推論結果が来ていない手の途中経過を捨てる（手を完全に見失った。クールダウンは残す）。
   * 毎フレーム呼んでよい。
   */
  prune(now: number): void {
    for (const [key, h] of this.hands) if (now - h.lastTime > SNAP_TIMING.lostMs) this.hands.delete(key)
  }

  /** 手の状態（見失っていた手は途中経過を捨てて作り直す）。推論の間隔も更新する */
  private stateFor(handKey: string, s: HandSample): HandState {
    let h = this.hands.get(handKey)
    if (!h || s.time - h.lastTime > SNAP_TIMING.lostMs) {
      // 見失っていた手：途中経過を捨てる
      h = {
        phase: 'open',
        contactStart: s.time,
        lastContactTime: s.time,
        lastContactDistance: 0,
        lastContactWrist: s.wrist,
        holding: false,
        lastTime: s.time,
        scale3d: h?.scale3d ?? null,
        interval: h?.interval ?? SAMPLE_INTERVAL_DEFAULT_MS,
        lastResult: null,
        waitOpen: false,
        debug: {
          status: 'open',
          blocked: null,
          intervalMs: h?.interval ?? SAMPLE_INTERVAL_DEFAULT_MS,
          confidence: s.confidence ?? null,
          distance: 0,
          armed: false,
          phase: 'open',
          mode: '2d',
          unreliable: false,
          contactMs: 0,
          releaseSpeed: 0,
          holding: false,
          cooldownMs: 0,
        },
      }
      this.hands.set(handKey, h)
    } else if (s.time > h.lastTime) {
      // 推論の間隔（接触の時間の推定に使う）。一瞬の欠落で間隔が大きく見えないよう上限を付ける
      h.interval = h.interval * 0.7 + Math.min(s.time - h.lastTime, SAMPLE_INTERVAL_MAX_MS) * 0.3
    }
    h.lastTime = s.time
    return h
  }

  /**
   * STEP 12：この推論結果では判定しない（タバコを持っている手）。途中経過を捨て、
   * 判定を再開した後は、親指と人差し指が一度開くまで接触を数えない（waitOpen）。
   */
  block(handKey: string, s: HandSample, settings: SnapSettings, reason: string): void {
    const h = this.stateFor(handKey, s)
    h.phase = 'open'
    h.holding = false
    h.waitOpen = true
    h.debug = {
      ...h.debug,
      status: 'blocked',
      blocked: reason,
      phase: 'open',
      armed: false,
      distance: pinchDistance2d(s),
      holding: false,
      cooldownMs: Math.max(0, this.lastSuccessAt(handKey) + settings.cooldownMs - s.time),
    }
  }

  /** 新しい推論結果ごとに呼ぶ */
  update(handKey: string, s: HandSample, settings: SnapSettings, options: SnapUpdateOptions = {}): SnapEvent | null {
    const h = this.stateFor(handKey, s)
    const cooldownLeft = Math.max(0, this.lastSuccessAt(handKey) + settings.cooldownMs - s.time)

    if (s.confidence !== undefined && s.confidence < SNAP_TIMING.minConfidence) {
      h.debug = { ...h.debug, unreliable: true, cooldownMs: cooldownLeft, confidence: s.confidence }
      return null
    }
    // 距離：2D を基本にし、3D が安定していれば小さい方
    const d2 = pinchDistance2d(s)
    const p3 = pinchDistance3d(s)
    let d = d2
    let mode: '3d' | '2d' = '2d'
    if (p3) {
      const stable = h.scale3d === null || Math.abs(p3.scale - h.scale3d) / h.scale3d <= SNAP_TIMING.maxScaleChange
      h.scale3d = h.scale3d === null ? p3.scale : h.scale3d * 0.8 + p3.scale * 0.2
      if (stable && p3.distance < d) {
        d = p3.distance
        mode = '3d'
      }
    }
    if (!Number.isFinite(d)) {
      h.debug = { ...h.debug, unreliable: true, cooldownMs: cooldownLeft }
      return null
    }

    let event: SnapEvent | null = null
    // 接触の解除の距離は、接触の距離以上・離れる距離未満にする（設定の組み合わせが不正でも判定が止まらない）
    const exit = Math.min(Math.max(settings.contactExitDistance, settings.contactDistance), settings.releaseDistance - 0.01)
    if (h.waitOpen) {
      if (d < exit) {
        h.debug = { ...h.debug, status: 'waitOpen', blocked: null, distance: d, mode, unreliable: false, cooldownMs: cooldownLeft }
        return null
      }
      h.waitOpen = false
    }
    const inContact = d <= (h.phase === 'contact' || h.phase === 'armed' ? exit : settings.contactDistance)
    let releaseSpeed = h.debug.releaseSpeed
    // 接触の時間の推定：最初〜最後の接触の推論結果の間 + 推論の間隔 1 回分
    const contactEstimate = () => h.lastContactTime - h.contactStart + h.interval

    if (inContact) {
      if (h.phase === 'open' || h.phase === 'releasing') {
        h.phase = 'contact'
        h.contactStart = s.time
        h.holding = options.holdingPen === true
      }
      h.lastContactTime = s.time
      h.lastContactDistance = d
      h.lastContactWrist = s.wrist
      if (contactEstimate() >= settings.minContactMs) h.phase = 'armed'
    } else if (h.phase === 'contact') {
      // 準備完了の前に離れた：接触が短い
      if (!h.holding) {
        this.record(handKey, s, false, ['接触が短い'], 0, contactEstimate(), 0, mode)
        h.lastResult = { ok: false, time: s.time }
      }
      h.phase = 'open'
    } else if (h.phase === 'armed' || h.phase === 'releasing') {
      h.phase = 'releasing'
      const elapsed = s.time - h.lastContactTime
      if (h.holding) {
        // ペンをつまんでいた接触：離しても着火ジェスチャーにしない
        if (d >= settings.releaseDistance || elapsed > settings.maxReleaseMs) h.phase = 'open'
      } else if (d >= settings.releaseDistance) {
        const sec = Math.max(elapsed, 1) / 1000
        releaseSpeed = (d - h.lastContactDistance) / sec
        const wristSpeed = dist(s.wrist, h.lastContactWrist) / handScale2d(s) / sec
        const reasons: string[] = []
        if (elapsed > settings.maxReleaseMs) reasons.push(`離すのが遅い（${Math.round(elapsed)}ms）`)
        if (releaseSpeed < settings.minSpeed) reasons.push(`離す速さが足りない（${releaseSpeed.toFixed(1)} < ${settings.minSpeed}）`)
        if (wristSpeed > SNAP_TIMING.maxWristSpeed) reasons.push(`手全体が大きく動いた（${wristSpeed.toFixed(1)}）`)
        if (cooldownLeft > 0) reasons.push('クールダウン中')
        const ok = reasons.length === 0
        if (ok) {
          this.lastSnapAt.set(handKey, s.time)
          this.successCount++
          event = { handKey, position: s.indexTip ?? s.thumbTip, time: s.time }
        }
        this.record(handKey, s, ok, reasons, releaseSpeed, contactEstimate(), wristSpeed, mode)
        h.lastResult = { ok, time: s.time }
        // 成否にかかわらず、1 回の「接触 → 離す」は 1 回だけ評価する
        h.phase = 'open'
      } else if (elapsed > settings.maxReleaseMs) {
        this.record(handKey, s, false, [`ゆっくり開いた（${Math.round(elapsed)}ms で離れる距離に届かない）`], 0, contactEstimate(), 0, mode)
        h.lastResult = { ok: false, time: s.time }
        h.phase = 'open'
      }
    }

    const contactMs = h.phase === 'contact' || h.phase === 'armed' ? s.time - h.contactStart + h.interval : contactEstimate()
    const cooldownMs = event ? settings.cooldownMs : cooldownLeft
    h.debug = {
      status: snapStatus(h, s.time, cooldownMs),
      blocked: null,
      intervalMs: h.interval,
      confidence: s.confidence ?? null,
      distance: d,
      armed: h.phase === 'armed' || h.phase === 'releasing',
      phase: h.phase,
      mode,
      unreliable: false,
      contactMs,
      releaseSpeed,
      holding: h.holding && h.phase !== 'open',
      cooldownMs,
    }
    return event
  }

  private record(handKey: string, s: HandSample, ok: boolean, reasons: string[], speed: number, contactMs: number, wristSpeed: number, mode: '3d' | '2d'): void {
    this.attempts = [{ handKey, time: s.time, ok, reasons, speed, contactMs, wristSpeed, mode }, ...this.attempts].slice(0, 8)
  }
}

/** 表示用の状態：途中経過 > 直前の結果（RESULT_DISPLAY_MS の間）> クールダウン > 離れている */
function snapStatus(h: HandState, now: number, cooldownMs: number): SnapStatus {
  if (h.phase === 'contact' || h.phase === 'armed') return 'contact'
  if (h.phase === 'releasing') return 'releasing'
  if (h.lastResult && now - h.lastResult.time <= RESULT_DISPLAY_MS) return h.lastResult.ok ? 'success' : 'failed'
  return cooldownMs > 0 ? 'cooldown' : 'open'
}
