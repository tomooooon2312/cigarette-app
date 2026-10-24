/**
 * MediaPipe Tasks Vision（1.1.1）の利用統計の送信を止める。
 *
 * MediaPipe は Face Landmarker・Hand Landmarker を作るたびに利用統計のロガーを作り、60 秒ごとに
 * `https://odml.pa.googleapis.com/v1/log` へ POST する（タスクの種類・実行モード・OS の種類・ライブラリの版・推論時間の統計。
 * 映像やランドマークは含まない）。無効にするオプションが無いため、この URL への fetch だけを失敗させる。
 * 送信が失敗すると MediaPipe 側でロガーが止まり、再送もしない。認識の動作には影響しない。
 * アプリはオフラインで動かす（iOS アプリ化）方針で、カメラ・認識に関わる通信を外部に出さないため。
 */
export const MEDIAPIPE_TELEMETRY_PREFIX = 'https://odml.pa.googleapis.com/'

let installed = false

type Fetch = typeof globalThis.fetch

/** fetch を包み、MediaPipe の利用統計の送信だけを失敗させる（2 回目以降の呼び出しは何もしない） */
export function blockMediaPipeTelemetry(target: { fetch: Fetch } = globalThis): void {
  if (installed && target === globalThis) return
  const original = target.fetch.bind(target)
  target.fetch = ((input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(MEDIAPIPE_TELEMETRY_PREFIX)) {
      return Promise.reject(new TypeError('MediaPipe の利用統計の送信は無効にしています'))
    }
    return original(input, init)
  }) as Fetch
  if (target === globalThis) installed = true
}
