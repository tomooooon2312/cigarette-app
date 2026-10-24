import type { PersonMode } from './personController'

/**
 * STEP 5：人数に応じた処理負荷の調整（「負荷の自動調整」が ON のとき）。
 * - 顔・手の推論間隔の下限を人数に応じて広げる（UI で設定した間隔の方が長ければそちらを使う）。
 * - 3 人モードでは処理解像度の上限を下げる（OpenCV の色変換・輪郭抽出と Canvas 描画の負荷を下げる）。
 * 1 人モードでは何も変えない（STEP 4 までと同じ）。
 * 値は PC の headless Chrome での計測から決めた暫定値で、スマートフォンの実機では未調整。
 */
export type PerfProfile = {
  /** 処理解像度の上限 px（映像の長い辺。横長の映像では幅） */
  maxProcessWidth: number
  /** 顔の推論間隔の下限 ms */
  minFaceIntervalMs: number
  /** 手の推論間隔の下限 ms */
  minHandIntervalMs: number
}

export const PERF_PROFILES: Record<PersonMode, PerfProfile> = {
  1: { maxProcessWidth: 640, minFaceIntervalMs: 0, minHandIntervalMs: 0 },
  2: { maxProcessWidth: 640, minFaceIntervalMs: 80, minHandIntervalMs: 33 },
  3: { maxProcessWidth: 480, minFaceIntervalMs: 100, minHandIntervalMs: 50 },
}

/** 調整しないときの処理解像度の上限幅（STEP 1 からの値） */
export const DEFAULT_MAX_PROCESS_WIDTH = 640

export function effectivePerf(
  mode: PersonMode,
  auto: boolean,
  faceIntervalMs: number,
  handIntervalMs: number,
): { maxProcessWidth: number; faceIntervalMs: number; handIntervalMs: number } {
  const p = auto ? PERF_PROFILES[mode] : PERF_PROFILES[1]
  return {
    maxProcessWidth: auto ? p.maxProcessWidth : DEFAULT_MAX_PROCESS_WIDTH,
    faceIntervalMs: Math.max(faceIntervalMs, p.minFaceIntervalMs),
    handIntervalMs: Math.max(handIntervalMs, p.minHandIntervalMs),
  }
}

/** 実測 fps からの負荷の目安 */
export function loadLevel(fps: number): 'low' | 'medium' | 'high' {
  if (fps >= 25) return 'low'
  if (fps >= 15) return 'medium'
  return 'high'
}
