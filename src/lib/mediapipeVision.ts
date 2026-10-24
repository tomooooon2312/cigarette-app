import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'
import noSimdLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.js?url'
import noSimdBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.wasm?url'

type VisionModule = typeof import('@mediapipe/tasks-vision')
type WasmFileset = { wasmLoaderPath: string; wasmBinaryPath: string }

let loading: Promise<{ vision: VisionModule; fileset: WasmFileset }> | null = null

/**
 * MediaPipe Tasks Vision のモジュールと WASM の場所を 1 回だけ解決する（顔・手の両方で共用）。
 * WASM はパッケージ同梱のファイルを Vite のアセットとして配信し、CDN は使わない。
 */
export function loadVision(): Promise<{ vision: VisionModule; fileset: WasmFileset }> {
  loading ??= (async () => {
    const vision = await import('@mediapipe/tasks-vision')
    const simd = await vision.FilesetResolver.isSimdSupported()
    const fileset = simd
      ? { wasmLoaderPath: wasmLoaderUrl, wasmBinaryPath: wasmBinaryUrl }
      : { wasmLoaderPath: noSimdLoaderUrl, wasmBinaryPath: noSimdBinaryUrl }
    return { vision, fileset }
  })().catch((error: unknown) => {
    loading = null
    throw error
  })
  return loading
}

/** 公式配布のモデル（public/models に同梱） */
export const modelUrl = (name: string) => `${import.meta.env.BASE_URL}models/${name}`
