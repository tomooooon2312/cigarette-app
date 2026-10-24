/**
 * 煙エフェクトの状態機械（IDLE / SMOKING / EXHALING）。
 * 入力は毎フレームの観測値で、状態と「どこから新しい煙を出すか」を一元的に返す。
 * DOM・MediaPipe に依存しない純粋なロジックとして単体テストできるようにしている。
 */

export type SmokeState = 'IDLE' | 'SMOKING' | 'EXHALING'

/** 新しい煙の発生源。状態ごとに必ずどれか 1 つ（口とタバコから同時には出さない） */
export type SmokeEmitter = 'none' | 'ember' | 'mouth'

export type SmokeFsmSettings = {
  /** 吸い口と唇の中心の距離（顔の大きさで正規化）がこれ以下で「くわえた」とみなす */
  enterDistance: number
  /** 同じ距離がこれを超えたら「離した」とみなす（enterDistance より大きくする） */
  leaveDistance: number
  /** mouthPucker / mouthFunnel のどちらかがしきい値以上で「口をすぼめた」とみなす */
  puckerThreshold: number
  funnelThreshold: number
}

export const DEFAULT_FSM_SETTINGS: SmokeFsmSettings = {
  enterDistance: 0.35,
  leaveDistance: 0.6,
  puckerThreshold: 0.5,
  funnelThreshold: 0.35,
}

export const FSM_TIMING = {
  /** 条件がこの回数の推論結果で連続したら状態を切り替える */
  confirmSamples: 3,
  /** SMOKING がこの時間続いたら、吐く演出を許可する ms */
  minInhaleMs: 800,
  /** 離してから口をすぼめるまでの猶予 ms（過ぎたら吐く権利を失う） */
  exhaleWindowMs: 4000,
  /** EXHALING の最大継続時間 ms */
  maxExhaleMs: 3000,
  /** 顔・ペンをこの時間見失ったら SMOKING / EXHALING を終了する ms */
  lostTimeoutMs: 500,
  /** すぼめ解除のしきい値（すぼめ判定しきい値に対する倍率、ヒステリシス） */
  releaseRatio: 0.8,
} as const

export type SmokeFsmInput = {
  now: number
  /** 顔推論のサンプル番号。顔が無効なら null */
  faceSampleId: number | null
  /** タバコ CG（ペン）が表示されているか */
  penVisible: boolean
  /** 吸い口と唇の中心の距離（顔の大きさで正規化）。顔かペンが無ければ null */
  filterDistance: number | null
  pucker: number
  funnel: number
}

export type SmokeFsmOutput = {
  state: SmokeState
  emitter: SmokeEmitter
  /** 吐く演出が許可されているか（十分に吸った後、まだ吐いていない） */
  exhaleReady: boolean
  /** 現在の SMOKING の継続時間 ms */
  inhaleMs: number
}

export class SmokeStateMachine {
  private state: SmokeState = 'IDLE'
  private enteredAt = 0
  private exhaleReady = false
  private exhaleReadyAt = 0
  private lastSampleId: number | null = null
  private lastFaceAt = -Infinity
  private lastPenAt = -Infinity
  private nearCount = 0
  private farCount = 0
  private puckerCount = 0
  private releaseCount = 0

  get current(): SmokeState {
    return this.state
  }

  reset(): void {
    this.state = 'IDLE'
    this.exhaleReady = false
    this.lastSampleId = null
    this.lastFaceAt = -Infinity
    this.lastPenAt = -Infinity
    this.resetCounters()
  }

  update(input: SmokeFsmInput, s: SmokeFsmSettings): SmokeFsmOutput {
    const { now } = input
    const faceVisible = input.faceSampleId !== null
    if (faceVisible) this.lastFaceAt = now
    if (input.penVisible) this.lastPenAt = now
    const puckered =
      faceVisible && (input.pucker >= s.puckerThreshold || input.funnel >= s.funnelThreshold)
    // 吐いている間は、解除しきい値を下回るまで口から煙を出し続ける（ヒステリシス）
    const stillPuckered =
      faceVisible &&
      (input.pucker >= s.puckerThreshold * FSM_TIMING.releaseRatio ||
        input.funnel >= s.funnelThreshold * FSM_TIMING.releaseRatio)

    // 連続判定は「新しい推論結果」ごとに数える（描画フレームが多い端末でも判定時間が変わらない）
    if (faceVisible && input.faceSampleId !== this.lastSampleId) {
      this.lastSampleId = input.faceSampleId
      const d = input.filterDistance
      const near = input.penVisible && d !== null && d <= s.enterDistance
      const far = !input.penVisible || d === null || d > Math.max(s.leaveDistance, s.enterDistance)
      const released =
        input.pucker < s.puckerThreshold * FSM_TIMING.releaseRatio &&
        input.funnel < s.funnelThreshold * FSM_TIMING.releaseRatio
      this.nearCount = near ? this.nearCount + 1 : 0
      this.farCount = far ? this.farCount + 1 : 0
      this.puckerCount = puckered ? this.puckerCount + 1 : 0
      this.releaseCount = released ? this.releaseCount + 1 : 0
    }
    const confirmed = (count: number) => count >= FSM_TIMING.confirmSamples
    const faceLost = now - this.lastFaceAt > FSM_TIMING.lostTimeoutMs
    const penLost = now - this.lastPenAt > FSM_TIMING.lostTimeoutMs

    switch (this.state) {
      case 'IDLE': {
        if (this.exhaleReady && now - this.exhaleReadyAt > FSM_TIMING.exhaleWindowMs) {
          this.exhaleReady = false
        }
        if (confirmed(this.nearCount)) {
          this.enter('SMOKING', now)
        } else if (this.exhaleReady && confirmed(this.puckerCount)) {
          this.exhaleReady = false // 1 回の吸う動作につき吐く演出は 1 回まで
          this.enter('EXHALING', now)
        }
        break
      }
      case 'SMOKING': {
        const inhaled = now - this.enteredAt >= FSM_TIMING.minInhaleMs
        if (faceLost || penLost) {
          // 見失ったまま煙を出し続けない。十分に吸っていれば、戻ってきた後に吐ける
          this.markExhaleReady(inhaled, now)
          this.enter('IDLE', now)
        } else if (confirmed(this.farCount)) {
          this.markExhaleReady(inhaled, now)
          if (inhaled && confirmed(this.puckerCount)) {
            this.exhaleReady = false
            this.enter('EXHALING', now)
          } else {
            this.enter('IDLE', now)
          }
        }
        break
      }
      case 'EXHALING': {
        if (
          confirmed(this.releaseCount) ||
          now - this.enteredAt > FSM_TIMING.maxExhaleMs ||
          faceLost
        ) {
          this.enter('IDLE', now)
        }
        break
      }
    }

    return {
      state: this.state,
      emitter: this.emitterFor(input, stillPuckered),
      exhaleReady:
        this.exhaleReady ||
        (this.state === 'SMOKING' && now - this.enteredAt >= FSM_TIMING.minInhaleMs),
      inhaleMs: this.state === 'SMOKING' ? now - this.enteredAt : 0,
    }
  }

  /** 状態から新しい煙の発生源を決める（ここ以外で発生源を決めない） */
  private emitterFor(input: SmokeFsmInput, stillPuckered: boolean): SmokeEmitter {
    switch (this.state) {
      case 'SMOKING':
        return input.penVisible ? 'ember' : 'none'
      case 'EXHALING':
        return stillPuckered ? 'mouth' : 'none'
      default:
        return 'none'
    }
  }

  private markExhaleReady(inhaled: boolean, now: number): void {
    this.exhaleReady = inhaled
    if (inhaled) this.exhaleReadyAt = now
  }

  private enter(state: SmokeState, now: number): void {
    this.state = state
    this.enteredAt = now
    this.resetCounters()
  }

  private resetCounters(): void {
    this.nearCount = 0
    this.farCount = 0
    this.puckerCount = 0
    this.releaseCount = 0
  }
}
