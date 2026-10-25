/**
 * STEP 9：インカメラ・アウトカメラの切り替え。getUserMedia を外から渡せる純粋なロジック（単体テストの対象）。
 *
 * - iOS では同時に開けるカメラが 1 つだけなので、今のカメラを止めてから新しいカメラを開く。
 * - 新しいカメラを開けなかったら、元のカメラ（向き）を開き直して復帰する（restored = true）。それも失敗したら例外。
 * - 切り替え中にもう一度呼ばれたら何もしない（null。連打しても二重に開かない）。
 */
export type CameraFacing = 'user' | 'environment'

export const FACING_LABELS: Record<CameraFacing, string> = { user: 'インカメラ', environment: 'アウトカメラ' }

/** カメラごとの左右反転の既定：インカメラは鏡のように反転、アウトカメラは反転しない */
export const defaultMirror = (facing: CameraFacing): boolean => facing === 'user'

/** カメラの要求（STEP 1 からの 1280×720 の希望値と同じ） */
export function cameraConstraints(facing: CameraFacing): MediaStreamConstraints {
  return {
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  }
}

export type SwitchResult = {
  stream: MediaStream
  facing: CameraFacing
  /** 目的のカメラを開けず、元のカメラに戻した */
  restored: boolean
  /** 目的のカメラを開けなかった理由（restored のときだけ） */
  error: unknown
}

type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>

export class CameraSwitcher {
  private readonly getUserMedia: GetUserMedia
  private switching = false

  constructor(getUserMedia: GetUserMedia) {
    this.getUserMedia = getUserMedia
  }

  get busy(): boolean {
    return this.switching
  }

  /**
   * current のカメラを止めて target のカメラを開く。切り替え中なら null（何もしない）。
   * 戻り値の stream は呼び出し側が video に設定し、不要になったら止める。
   */
  async switchTo(target: CameraFacing, current: { stream: MediaStream | null; facing: CameraFacing }): Promise<SwitchResult | null> {
    if (this.switching) return null
    this.switching = true
    try {
      current.stream?.getTracks().forEach((t) => t.stop())
      try {
        const stream = await this.getUserMedia(cameraConstraints(target))
        return { stream, facing: target, restored: false, error: null }
      } catch (error) {
        // 目的のカメラを開けなかった：元のカメラに戻す（これも失敗したら例外を投げ、呼び出し側でカメラを止める）
        const stream = await this.getUserMedia(cameraConstraints(current.facing))
        return { stream, facing: current.facing, restored: true, error }
      }
    } finally {
      this.switching = false
    }
  }
}
