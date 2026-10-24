import type * as CV from '@techstark/opencv-js'
import opencvUrl from '@techstark/opencv-js/dist/opencv.js?url'

export type OpenCv = typeof CV

type CvModuleLike = {
  Mat?: unknown
  then?: unknown
  onRuntimeInitialized?: () => void
}

const SCRIPT_ID = 'opencv-js'

let loadingPromise: Promise<OpenCv> | null = null

/**
 * OpenCV.js（WASM 同梱、約 13MB）を一度だけ読み込む。
 * バンドラの CommonJS 変換を通すと export された Promise が壊れるため、
 * アセットとして出力したファイルを classic script で読み込み、グローバルの `cv` を使う。
 */
export function loadOpenCv(): Promise<OpenCv> {
  loadingPromise ??= injectScript()
    .then(() => resolveRuntime((globalThis as { cv?: unknown }).cv))
    .catch((error: unknown) => {
      // 失敗時は再試行できるようにキャッシュを破棄
      loadingPromise = null
      document.getElementById(SCRIPT_ID)?.remove()
      throw error
    })
  return loadingPromise
}

function injectScript(): Promise<void> {
  if ((globalThis as { cv?: unknown }).cv) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.id = SCRIPT_ID
    script.src = opencvUrl
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`${opencvUrl} を読み込めませんでした`))
    document.head.appendChild(script)
  })
}

async function resolveRuntime(exported: unknown): Promise<OpenCv> {
  if (!exported) throw new Error('OpenCV.js のグローバル cv が見つかりません')
  const module = exported as CvModuleLike
  // UMD 版は初期化完了で解決される Promise を cv に入れる
  if (typeof module.then === 'function') {
    return (await (exported as Promise<unknown>)) as OpenCv
  }
  if (!module.Mat) {
    await new Promise<void>((resolve) => {
      module.onRuntimeInitialized = () => resolve()
    })
  }
  return module as unknown as OpenCv
}

/** OpenCV.js は C++ 例外をポインタ（数値）で投げるため、可読なメッセージに変換する */
export function describeCvError(cv: OpenCv, error: unknown): string {
  if (typeof error === 'number') {
    try {
      const exception = cv.exceptionFromPtr(error) as { msg?: string }
      return exception.msg ?? `OpenCV exception (${error})`
    } catch {
      return `OpenCV exception (${error})`
    }
  }
  return error instanceof Error ? error.message : String(error)
}
