/**
 * STEP 14：ポスターのタイトル・キャッチコピーを Gemini で生成する API（API キーはこのサーバーだけが持つ）。
 *
 * - 開発サーバー（npm run dev）では vite.config.ts からミドルウェアとして使う（同じオリジンの /api/poster-copy）。
 * - iPhone のアプリからは、Mac で `npm run poster-server` を起動し、アプリのポスター画面で接続先（http://<Mac の IP>:8787）を設定する。
 * - API キーは環境変数 GEMINI_API_KEY（.env.local に書く。Git には含めない）。アプリ・ブラウザには渡さない。
 * - 写真は受け取らない。作風とお題（任意、40 文字まで）だけを Gemini に送る。
 *
 * POST /api/poster-copy  {"style": "noir", "hint": "..."} → 200 {"copy": {...}, "source": "gemini", "model": "..."}
 *   400 不正な入力 / 429 回数制限 / 502 Gemini の失敗 / 503 API キー未設定
 * GET  /api/poster-copy/health → {"configured": true|false, "model": "..."}
 */
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { pathToFileURL } from 'node:url'
import { COPY_RESPONSE_SCHEMA, buildCopyPrompt, cleanHint, isPosterStyle, parseGeminiResponse } from '../src/lib/posterCopy.ts'

export const POSTER_API_PATH = '/api/poster-copy'
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'
export const DEFAULT_PORT = 8787
/** Gemini の応答を待つ時間 ms */
export const GEMINI_TIMEOUT_MS = 10_000
/** 送信元ごとの回数制限（API キーの使いすぎを防ぐ） */
export const RATE_LIMIT = { max: 20, windowMs: 60_000 } as const
const MAX_BODY_BYTES = 2048

export type PosterServerOptions = {
  apiKey?: string
  model?: string
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

/** CORS で許可する送信元：iOS アプリ（Capacitor）と、localhost・LAN 内の開発サーバー */
export function allowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  if (origin === 'capacitor://localhost' || origin === 'ionic://localhost') return true
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const h = url.hostname
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h.endsWith('.local')
  )
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too_large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Gemini（generateContent）を呼んで、検証したコピーを返す。失敗したら例外 */
export async function generateCopy(style: Parameters<typeof buildCopyPrompt>[0], hint: string, o: Required<Pick<PosterServerOptions, 'apiKey' | 'model' | 'fetch' | 'timeoutMs'>>) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(o.model)}:generateContent`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs)
  try {
    const r = await o.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': o.apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildCopyPrompt(style, hint) }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: COPY_RESPONSE_SCHEMA, temperature: 1.0, maxOutputTokens: 1024 },
      }),
      signal: ctrl.signal,
    })
    if (!r.ok) throw new Error(`gemini_http_${r.status}`)
    const copy = parseGeminiResponse(await r.json())
    if (!copy) throw new Error('gemini_invalid_response')
    return copy
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Node の http・Vite（connect）のミドルウェアとして使えるハンドラ。POSTER_API_PATH 以外は next（無ければ 404）。
 */
export function createPosterCopyHandler(options: PosterServerOptions = {}) {
  const apiKey = options.apiKey?.trim() ?? ''
  const model = options.model?.trim() || DEFAULT_GEMINI_MODEL
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? GEMINI_TIMEOUT_MS
  const hits = new Map<string, number[]>()

  return async (req: IncomingMessage, res: ServerResponse, next?: () => void): Promise<void> => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== POSTER_API_PATH && path !== `${POSTER_API_PATH}/health`) {
      if (next) next()
      else send(res, 404, { error: 'not_found' })
      return
    }
    const origin = req.headers.origin
    if (allowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin!)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    if (path.endsWith('/health')) {
      send(res, 200, { configured: apiKey !== '', model })
      return
    }
    if (req.method !== 'POST') {
      send(res, 405, { error: 'method_not_allowed' })
      return
    }
    // 送信元ごとの回数制限
    const ip = req.socket?.remoteAddress ?? 'unknown'
    const t = now()
    const recent = (hits.get(ip) ?? []).filter((x) => t - x < RATE_LIMIT.windowMs)
    if (recent.length >= RATE_LIMIT.max) {
      send(res, 429, { error: 'rate_limited' })
      return
    }
    recent.push(t)
    hits.set(ip, recent)

    let input: { style?: unknown; hint?: unknown }
    try {
      input = JSON.parse(await readBody(req))
    } catch {
      send(res, 400, { error: 'invalid_body' })
      return
    }
    if (!isPosterStyle(input?.style)) {
      send(res, 400, { error: 'invalid_style' })
      return
    }
    if (!apiKey) {
      send(res, 503, { error: 'not_configured' })
      return
    }
    try {
      const copy = await generateCopy(input.style, cleanHint(input.hint), { apiKey, model, fetch: doFetch, timeoutMs })
      send(res, 200, { copy, source: 'gemini', model })
    } catch (e) {
      // API キー・応答の本文はログにも返り値にも含めない
      const reason = e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : 'unknown'
      console.warn(`[poster-copy] Gemini の呼び出しに失敗：${reason}`)
      send(res, 502, { error: 'upstream_failed', reason })
    }
  }
}

/** .env.local・.env から KEY=VALUE を読む（すでに環境変数があればそちらを優先） */
export function loadEnvFiles(files = ['.env.local', '.env']): Record<string, string> {
  const env: Record<string, string> = {}
  for (const f of files) {
    let text: string
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (!m || line.trim().startsWith('#')) continue
      env[m[1]] ??= m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
  return env
}

// `npm run poster-server`（node server/posterServer.ts）で直接起動したとき：LAN に公開する
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fileEnv = loadEnvFiles()
  const apiKey = process.env.GEMINI_API_KEY ?? fileEnv.GEMINI_API_KEY ?? ''
  const model = process.env.GEMINI_MODEL ?? fileEnv.GEMINI_MODEL
  const port = Number(process.env.POSTER_PORT ?? fileEnv.POSTER_PORT ?? DEFAULT_PORT)
  const handler = createPosterCopyHandler({ apiKey, model })
  createServer((req, res) => void handler(req, res)).listen(port, '0.0.0.0', () => {
    const ips = Object.values(networkInterfaces())
      .flat()
      .filter((n) => n && n.family === 'IPv4' && !n.internal)
      .map((n) => n!.address)
    console.log(`ポスターのコピー生成サーバー：${apiKey ? 'Gemini の API キーあり' : 'API キー未設定（アプリは定型文を使う）'}・モデル ${model || DEFAULT_GEMINI_MODEL}`)
    for (const ip of ips) console.log(`  iPhone のアプリの接続先：http://${ip}:${port}`)
  })
}
