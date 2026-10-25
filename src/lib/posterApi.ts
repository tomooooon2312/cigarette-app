import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { fallbackCopy, sanitizeCopy, type PosterCopy, type PosterStyleId } from './posterCopy'

/**
 * STEP 14：ポスターのコピー生成 API（server/posterServer.ts）の呼び出し。失敗しても例外にせず、定型文を返す。
 * - Web 版：接続先が空なら同じオリジンの /api/poster-copy（開発サーバー）。
 * - iOS アプリ：接続先（http://<Mac の IP>:8787）を設定したときだけ呼ぶ。CORS・混在コンテンツを避けるため、
 *   Capacitor のネイティブ HTTP（CapacitorHttp）で送る。
 */
export const POSTER_API_PATH = '/api/poster-copy'
export const POSTER_API_TIMEOUT_MS = 12_000
/** 接続先を保存する localStorage のキー */
export const POSTER_ENDPOINT_KEY = 'shibugarette.posterEndpoint'

export type CopyResult = {
  copy: PosterCopy
  source: 'gemini' | 'fallback'
  /** 定型文にした理由（利用者向けの日本語） */
  reason: string
}

export type HttpPost = (url: string, body: unknown, timeoutMs: number) => Promise<{ status: number; data: unknown }>

export type PosterApiDeps = {
  isNative: () => boolean
  post: HttpPost
}

const webPost: HttpPost = async (url, body, timeoutMs) => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal })
    let data: unknown = null
    try {
      data = await r.json()
    } catch {
      data = null
    }
    return { status: r.status, data }
  } finally {
    clearTimeout(timer)
  }
}

const nativePost: HttpPost = async (url, body, timeoutMs) => {
  const r = await CapacitorHttp.request({ url, method: 'POST', headers: { 'Content-Type': 'application/json' }, data: body, connectTimeout: timeoutMs, readTimeout: timeoutMs })
  let data: unknown = r.data
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      data = null
    }
  }
  return { status: r.status, data }
}

const isNativeApp = () => Capacitor.isNativePlatform()

const DEFAULT_DEPS: PosterApiDeps = {
  isNative: isNativeApp,
  post: (url, body, timeoutMs) => (isNativeApp() ? nativePost : webPost)(url, body, timeoutMs),
}

/** 接続先（例：http://192.168.1.5:8787）から API の URL を作る。空なら同じオリジン（Web 版のみ） */
export function posterApiUrl(base: string, isNative: boolean): string | null {
  const b = base.trim().replace(/\/+$/, '')
  if (!b) return isNative ? null : POSTER_API_PATH
  if (!/^https?:\/\//i.test(b)) return null
  return b.endsWith(POSTER_API_PATH) ? b : `${b}${POSTER_API_PATH}`
}

const REASONS: Record<string, string> = {
  not_configured: 'サーバーに Gemini の API キーが設定されていないため',
  rate_limited: '生成の回数が多すぎるため（1 分ほど待ってください）',
  upstream_failed: 'Gemini から応答が得られなかったため',
  invalid_style: '作風の指定が正しくないため',
  invalid_body: '送信内容が正しくないため',
}

/** タイトル・キャッチコピーを生成する。失敗したら定型文（例外にしない） */
export async function requestPosterCopy(style: PosterStyleId, hint: string, base: string, deps: PosterApiDeps = DEFAULT_DEPS): Promise<CopyResult> {
  const fallback = (why: string): CopyResult => ({ copy: fallbackCopy(style), source: 'fallback', reason: `${why}、定型文を使いました` })
  const url = posterApiUrl(base, deps.isNative())
  if (!url) return fallback(base.trim() ? 'AI の接続先の形式が正しくないため（http:// から始めてください）' : 'AI の接続先が未設定のため')
  try {
    const { status, data } = await deps.post(url, { style, hint }, POSTER_API_TIMEOUT_MS)
    if (status === 200) {
      const copy = sanitizeCopy((data as { copy?: unknown } | null)?.copy)
      if (copy) return { copy, source: 'gemini', reason: '' }
      return fallback('生成結果の形式が正しくないため')
    }
    const code = (data as { error?: string } | null)?.error ?? ''
    return fallback(REASONS[code] ?? `AI サーバーに接続できないため（${status}）`)
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return fallback(aborted ? 'AI の応答が遅いため' : 'AI サーバーに接続できないため')
  }
}

/** 保存した接続先（無ければ空）。localStorage が使えなくても動く */
export function loadPosterEndpoint(): string {
  try {
    return localStorage.getItem(POSTER_ENDPOINT_KEY) ?? ''
  } catch {
    return ''
  }
}

export function savePosterEndpoint(v: string): void {
  try {
    localStorage.setItem(POSTER_ENDPOINT_KEY, v.trim())
  } catch {
    /* 保存できない環境では、その場だけ使う */
  }
}
