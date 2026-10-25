import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { posterFileName } from '../src/lib/photoCapture.ts'
import { POSTER_API_PATH, posterApiUrl, requestPosterCopy, type PosterApiDeps } from '../src/lib/posterApi.ts'
import {
  COPY_LIMITS,
  POSTER_COPY_SPECS,
  POSTER_STYLE_IDS,
  buildCopyPrompt,
  fallbackCopy,
  parseGeminiResponse,
  sanitizeCopy,
  type PosterStyleId,
} from '../src/lib/posterCopy.ts'
import {
  CHEF_HAIR,
  GRADES,
  POSTER_HEIGHT,
  POSTER_WIDTH,
  applyGrade,
  coverCrop,
  faceFrame,
  facePoint,
  fitText,
  renderPoster,
  scaleFace,
  wrapText,
  type PosterFace,
} from '../src/lib/posterRenderer.ts'
import { RATE_LIMIT, allowedOrigin, createPosterCopyHandler } from '../server/posterServer.ts'

type P = { x: number; y: number }

/** 正面を向いた顔（顔の幅 w、両目の中点 c、傾き angle ラジアン） */
function face(c: P, w: number, angle = 0): PosterFace {
  const r = { x: Math.cos(angle), y: Math.sin(angle) }
  const up = { x: Math.sin(angle), y: -Math.cos(angle) }
  const at = (u: number, v: number) => ({ x: c.x + (r.x * u + up.x * v) * w, y: c.y + (r.y * u + up.y * v) * w })
  const oval = Array.from({ length: 36 }, (_, i) => {
    const a = (i / 36) * Math.PI * 2
    return at(Math.sin(a) * 0.5, 0.1 + Math.cos(a) * 0.65)
  })
  return {
    oval,
    foreheadTop: at(0, 0.55),
    chin: at(0, -0.75),
    cheekL: at(-0.5, -0.1),
    cheekR: at(0.5, -0.1),
    eyeL: at(-0.2, 0),
    eyeR: at(0.2, 0),
    mouthL: at(-0.18, -0.5),
    mouthR: at(0.18, -0.5),
    upperLip: at(0, -0.46),
    lowerLip: at(0, -0.56),
    noseTip: at(0, -0.25),
  }
}

type Call = { name: string; args: unknown[]; fillStyle: string; strokeStyle: string; font: string }
/** 描画の呼び出しを記録する偽の 2D コンテキスト（measureText は文字数 × 大きさ × 0.55） */
function fakeCtx(width = POSTER_WIDTH, height = POSTER_HEIGHT) {
  const calls: Call[] = []
  const state: Record<string, unknown> = { fillStyle: '', strokeStyle: '', font: '10px sans-serif', globalAlpha: 1, globalCompositeOperation: 'source-over' }
  const canvas = { width, height }
  let image = new Uint8ClampedArray(width * height * 4).fill(128)
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop === 'canvas') return canvas
      if (prop in target) return target[prop]
      return (...args: unknown[]) => {
        calls.push({ name: prop, args, fillStyle: String(target.fillStyle), strokeStyle: String(target.strokeStyle), font: String(target.font) })
        if (prop === 'measureText') {
          const size = Number(/(\d+)px/.exec(String(target.font))?.[1] ?? 10)
          return { width: [...String(args[0])].length * size * 0.55 }
        }
        if (prop === 'getImageData') return { data: image, width, height }
        if (prop === 'putImageData') image = (args[0] as { data: Uint8ClampedArray }).data
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return { addColorStop() {} }
        if (prop === 'getContext') return ctx
        return undefined
      }
    },
    set(target, prop: string, value) {
      target[prop] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, calls }
}
const fakeCanvasFactory = () => (w: number, h: number) => ({ width: w, height: h, getContext: () => fakeCtx(w, h).ctx }) as unknown as HTMLCanvasElement

function render(style: PosterStyleId, faces: PosterFace[], copy = fallbackCopy(style, 0)) {
  const { ctx, calls } = fakeCtx()
  const report = renderPoster(ctx, { photo: {} as CanvasImageSource, photoWidth: 1280, photoHeight: 1920, faces, style, copy, seed: 0.5, createCanvas: fakeCanvasFactory() })
  return { report, calls }
}

describe('STEP 14：ポスターのコピー（posterCopy）', () => {
  it('6 種類の作風があり、定型文はどれも文字数の上限に収まる', () => {
    assert.deepEqual(POSTER_STYLE_IDS, ['hollywood', 'anime', 'noir', 'lazyCat', 'chaosClown', 'gentlemanChef'])
    for (const id of POSTER_STYLE_IDS) {
      for (const c of POSTER_COPY_SPECS[id].fallbacks) {
        assert.deepEqual(sanitizeCopy(c), c, `${id} ${c.title}`)
        assert.ok([...c.title].length <= COPY_LIMITS.title && [...c.tagline].length <= COPY_LIMITS.tagline)
      }
    }
    // 海外映画風は英語のタイトル、アニメ映画風は日本語のタイトル
    assert.match(fallbackCopy('hollywood', 0).title, /^[A-Z0-9 &'.-]+$/)
    assert.match(fallbackCopy('anime', 0).title, /[぀-ヿ一-鿿]/)
  })

  it('生成結果の検証：前後の空白・引用符・改行・制御文字を除き、上限で切る。タイトルかコピーが無ければ使わない', () => {
    const c = sanitizeCopy({ title: '  「煙の\n向こう」 ', subtitle: 123, tagline: 'あ'.repeat(80) })
    assert.deepEqual(c, { title: '煙の 向こう', subtitle: '', tagline: 'あ'.repeat(COPY_LIMITS.tagline) })
    assert.equal(sanitizeCopy({ title: '', tagline: 'x' }), null)
    assert.equal(sanitizeCopy({ title: 'x' }), null)
    assert.equal(sanitizeCopy('x'), null)
    assert.equal(sanitizeCopy({ title: 'a\u0007b', tagline: 't' })!.title, 'a b')
  })

  it('Gemini への指示：作風・言語・お題を含み、実在の作品名や喫煙を勧める表現を禁止する（写真は送らない）', () => {
    const p = buildCopyPrompt('noir', '雨の渋谷')
    assert.match(p, /ノワール風/)
    assert.match(p, /title：英語/)
    assert.match(p, /tagline：日本語/)
    assert.match(p, /お題（参考にする）：雨の渋谷/)
    assert.match(p, /実在の映画/)
    assert.match(p, /喫煙を勧める表現/)
    assert.ok(!/base64|image/i.test(p))
    assert.ok(!buildCopyPrompt('lazyCat').includes('お題'))
  })

  it('Gemini の応答から JSON を取り出す（```json で囲まれていても）。壊れていれば null', () => {
    const body = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] })
    assert.deepEqual(parseGeminiResponse(body('{"title":"A","subtitle":"B","tagline":"C"}')), { title: 'A', subtitle: 'B', tagline: 'C' })
    assert.deepEqual(parseGeminiResponse(body('```json\n{"title":"A","subtitle":"","tagline":"C"}\n```')), { title: 'A', subtitle: '', tagline: 'C' })
    assert.equal(parseGeminiResponse(body('not json')), null)
    assert.equal(parseGeminiResponse({}), null)
  })
})

describe('STEP 14：コピー生成の呼び出し（posterApi）', () => {
  const deps = (status: number, data: unknown, native = false): PosterApiDeps & { calls: string[] } => {
    const calls: string[] = []
    return {
      calls,
      isNative: () => native,
      post: async (url) => {
        calls.push(url)
        return { status, data }
      },
    }
  }

  it('接続先の URL：Web 版の空欄は同じオリジン、iOS アプリの空欄は呼ばない。http:// 以外は使わない', () => {
    assert.equal(posterApiUrl('', false), POSTER_API_PATH)
    assert.equal(posterApiUrl('', true), null)
    assert.equal(posterApiUrl('http://192.168.1.5:8787/', true), `http://192.168.1.5:8787${POSTER_API_PATH}`)
    assert.equal(posterApiUrl(`http://a.local:8787${POSTER_API_PATH}`, true), `http://a.local:8787${POSTER_API_PATH}`)
    assert.equal(posterApiUrl('192.168.1.5:8787', true), null)
  })

  it('成功したら Gemini のコピー、失敗（API キー未設定・通信の失敗・壊れた応答）なら定型文と理由', async () => {
    const ok = await requestPosterCopy('noir', '', '', deps(200, { copy: { title: 'T', subtitle: '', tagline: 'C' } }))
    assert.deepEqual(ok, { copy: { title: 'T', subtitle: '', tagline: 'C' }, source: 'gemini', reason: '' })
    const noKey = await requestPosterCopy('noir', '', '', deps(503, { error: 'not_configured' }))
    assert.equal(noKey.source, 'fallback')
    assert.match(noKey.reason, /API キーが設定されていない/)
    assert.ok(POSTER_COPY_SPECS.noir.fallbacks.some((f) => f.title === noKey.copy.title))
    const broken = await requestPosterCopy('anime', '', '', deps(200, { copy: { title: '' } }))
    assert.match(broken.reason, /形式が正しくない/)
    const thrown = await requestPosterCopy('anime', '', '', { isNative: () => false, post: async () => { throw new Error('offline') } })
    assert.match(thrown.reason, /接続できない/)
    const native = deps(200, {}, true)
    const unset = await requestPosterCopy('hollywood', '', '', native)
    assert.match(unset.reason, /接続先が未設定/)
    assert.equal(native.calls.length, 0, '接続先が無ければ呼ばない')
  })
})

describe('STEP 14：コピー生成サーバー（server/posterServer.ts）', () => {
  let server: Server
  let base = ''
  const geminiCalls: { url: string; headers: Record<string, string>; body: { contents: { parts: { text: string }[] }[]; generationConfig: { responseMimeType: string } } }[] = []
  let geminiReply: () => Response = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"title":"NEON ASH","subtitle":"ネオン・アッシュ","tagline":"光は消えない。"}' }] } }] }), { status: 200 })
  const fakeFetch = (async (url: string, init: RequestInit) => {
    geminiCalls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
    return geminiReply()
  }) as unknown as typeof fetch
  let now = 0
  before(async () => {
    const handler = createPosterCopyHandler({ apiKey: 'test-key-123', model: 'gemini-test', fetch: fakeFetch, now: () => now })
    server = createServer((req, res) => void handler(req, res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => new Promise<void>((r) => server.close(() => r())))
  const post = (body: unknown, origin?: string) =>
    fetch(`${base}${POSTER_API_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) })

  it('Gemini を呼んでコピーを返す。API キーはヘッダーだけで送り、写真は送らない', async () => {
    const r = await post({ style: 'hollywood', hint: '夜の高速' })
    assert.equal(r.status, 200)
    const data = (await r.json()) as { copy: unknown; source: string; model: string }
    assert.deepEqual(data, { copy: { title: 'NEON ASH', subtitle: 'ネオン・アッシュ', tagline: '光は消えない。' }, source: 'gemini', model: 'gemini-test' })
    const call = geminiCalls.at(-1)!
    assert.match(call.url, /models\/gemini-test:generateContent$/)
    assert.equal(call.headers['x-goog-api-key'], 'test-key-123')
    assert.ok(!call.url.includes('test-key-123'), 'URL にキーを入れない')
    assert.equal(call.body.generationConfig.responseMimeType, 'application/json')
    assert.match(call.body.contents[0].parts[0].text, /海外映画風[\s\S]*夜の高速/)
    assert.equal(call.body.contents[0].parts.length, 1, 'テキストだけ（画像なし）')
  })

  it('不正な作風は 400、Gemini の失敗は 502（キーを返さない）、状態の確認はキーの有無だけ', async () => {
    assert.equal((await post({ style: 'unknown' })).status, 400)
    geminiReply = () => new Response('{"error":"bad"}', { status: 500 })
    const r = await post({ style: 'noir' })
    assert.equal(r.status, 502)
    assert.ok(!(await r.text()).includes('test-key-123'))
    geminiReply = () => new Response(JSON.stringify({ candidates: [] }), { status: 200 })
    assert.equal((await post({ style: 'noir' })).status, 502)
    const health = await (await fetch(`${base}${POSTER_API_PATH}/health`)).json()
    assert.deepEqual(health, { configured: true, model: 'gemini-test' })
  })

  it('CORS：iOS アプリ（capacitor://localhost）と LAN の開発サーバーだけを許可する', async () => {
    const ok = await post({ style: 'x' }, 'capacitor://localhost')
    assert.equal(ok.headers.get('access-control-allow-origin'), 'capacitor://localhost')
    const ng = await post({ style: 'x' }, 'https://evil.example')
    assert.equal(ng.headers.get('access-control-allow-origin'), null)
    for (const o of ['http://localhost:5173', 'http://192.168.10.3:5173', 'http://10.0.0.2', 'http://mac.local:5173']) assert.ok(allowedOrigin(o), o)
    for (const o of ['https://example.com', 'http://8.8.8.8', 'file://x', undefined]) assert.ok(!allowedOrigin(o), String(o))
  })

  it('送信元ごとの回数制限（1 分に RATE_LIMIT.max 回）', async () => {
    now = 1_000_000
    let limited = 0
    for (let i = 0; i < RATE_LIMIT.max + 3; i++) if ((await post({ style: 'x' })).status === 429) limited++
    assert.equal(limited, 3)
    now += RATE_LIMIT.windowMs
    assert.notEqual((await post({ style: 'x' })).status, 429, '1 分後は再び使える')
  })

  it('API キーが無ければ 503（アプリは定型文にする）', async () => {
    // fetch は呼ばれないはず（呼ばれたら失敗させ、外部へ通信しない）
    const h = createPosterCopyHandler({ apiKey: '', fetch: (async () => { throw new Error('fetch must not be called') }) as unknown as typeof fetch })
    const s = createServer((req, res) => void h(req, res))
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}${POSTER_API_PATH}`, { method: 'POST', body: '{"style":"noir"}' })
    assert.equal(r.status, 503)
    assert.deepEqual(await r.json(), { error: 'not_configured' })
    await new Promise<void>((res) => s.close(() => res()))
  })
})

describe('STEP 14：ポスターの合成（posterRenderer）', () => {
  it('写真の切り抜き：顔を横の中央・上から 4 割へ寄せる。頭の上にパーツを付ける作風は、上に余白を足して顔を下げる', () => {
    const f = face({ x: 400, y: 700 }, 300)
    const { s, ox, oy } = coverCrop(1280, 1920, [f], POSTER_WIDTH, POSTER_HEIGHT)
    const m = scaleFace(f, s, ox, oy)
    const cy = (m.foreheadTop.y + m.chin.y) / 2
    assert.ok(Math.abs((m.cheekL.x + m.cheekR.x) / 2 - POSTER_WIDTH / 2) < 2 || ox === 0)
    assert.ok(Math.abs(cy - POSTER_HEIGHT * 0.4) < 2, `${cy}`)
    assert.ok(1280 * s >= POSTER_WIDTH && 1920 * s >= POSTER_HEIGHT, '隙間なく覆う')
    // 顔が写真の上の端にある
    const top = face({ x: 640, y: 260 }, 300)
    assert.equal(coverCrop(1280, 1920, [top]).oy, 0, '余白なし：上の端に合わせる')
    const padded = coverCrop(1280, 1920, [top], POSTER_WIDTH, POSTER_HEIGHT, 0.47, 0.12)
    assert.ok(padded.oy > 0 && padded.oy <= POSTER_HEIGHT * 0.12)
  })

  it('6 つの作風の色調はすべて違い、ノワールは白黒', () => {
    const sample = () => new Uint8ClampedArray([200, 80, 40, 255, 40, 120, 200, 255, 90, 90, 90, 255])
    const outs = POSTER_STYLE_IDS.map((id) => {
      const d = sample()
      applyGrade(d, GRADES[id])
      return Array.from(d).join(',')
    })
    assert.equal(new Set(outs).size, 6)
    const noir = sample()
    applyGrade(noir, GRADES.noir)
    for (let i = 0; i < noir.length; i += 4) assert.ok(noir[i] === noir[i + 1] && noir[i + 1] === noir[i + 2])
  })

  it('文字の折り返し：1 行に収まるならそのまま、日本語の 2 行は長さをそろえる（1 文字だけ次の行にしない）', () => {
    const measureAt = (s: string, size: number) => [...s].length * size
    const one = fitText('ABC DEF', 1000, measureAt, 100, 40, 2)
    assert.deepEqual(one.lines, ['ABC DEF'])
    const jp = fitText('紳士は煙を纏う', 600, measureAt, 100, 40, 2)
    assert.equal(jp.lines.length, 1, '55% 以上の大きさで 1 行に収まる')
    // 1 行には収まらない大きさ：左から詰めると「紳士は煙を纏 / う」になるところを、4 文字 + 3 文字に分ける
    const two = fitText('紳士は煙を纏う', 600, measureAt, 200, 40, 2)
    assert.deepEqual(two.lines, ['紳士は煙', 'を纏う'])
    assert.deepEqual(wrapText('one two three', 7, (s) => s.length, 3), ['one two', 'three'])
  })

  it('顔の座標系は顔の傾きに追従する（猫耳などのパーツが一緒に傾く）', () => {
    const straight = faceFrame(face({ x: 500, y: 500 }, 200))
    const tilted = faceFrame(face({ x: 500, y: 500 }, 200, Math.PI / 6))
    const ear = facePoint(straight, 0.4, 1.2)
    assert.ok(ear.y < 500 && ear.x > 500)
    const tEar = facePoint(tilted, 0.4, 1.2)
    assert.ok(Math.abs(Math.atan2(tilted.right.y, tilted.right.x) - Math.PI / 6) < 1e-9)
    assert.ok(tEar.x > ear.x, '右に傾くと、耳の先も右へ')
  })

  it('紳士シェフの前髪は、画面の左の目を隠し、右の目は隠さない', () => {
    const inside = (p: [number, number], poly: [number, number][]) => {
      let c = false
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i]
        const [xj, yj] = poly[j]
        if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c
      }
      return c
    }
    assert.ok(inside([-0.2, 0], CHEF_HAIR), '左の目')
    assert.ok(!inside([0.2, 0], CHEF_HAIR), '右の目')
    assert.ok(inside([0, 0.5], CHEF_HAIR), '額')
  })

  it('顔があるとき、作風ごとの顔のパーツを描く。顔が無くてもポスターはできる（パーツなし）', () => {
    const f = face({ x: 640, y: 800 }, 320)
    assert.deepEqual(render('lazyCat', [f]).report.parts, ['catEars', 'blush', 'whiskers'])
    assert.deepEqual(render('chaosClown', [f]).report.parts, ['whiteFace', 'eyeMakeup', 'redSmile', 'greenHair'])
    assert.deepEqual(render('gentlemanChef', [f]).report.parts, ['suit', 'tie', 'blondBangs'])
    for (const id of ['hollywood', 'anime', 'noir'] as const) assert.deepEqual(render(id, [f]).report.parts, [])
    for (const id of POSTER_STYLE_IDS) {
      const r = render(id, [])
      assert.equal(r.report.facesDrawn, 0)
      assert.deepEqual(r.report.parts, [])
      assert.ok(r.report.titleLines.length >= 1, id)
    }
    // 2 人の顔
    assert.equal(render('lazyCat', [f, face({ x: 300, y: 800 }, 200)]).report.parts.length, 6)
  })

  it('カオス・クラウンの赤い口元は、口角より外側の頬まで広がる', () => {
    const f = face({ x: 640, y: 800 }, 320)
    const { s, ox, oy } = coverCrop(1280, 1920, [f])
    const m = scaleFace(f, s, ox, oy)
    const { calls } = render('chaosClown', [f])
    const red = calls.filter((c) => c.name === 'moveTo' && c.strokeStyle.startsWith('rgba(196, 18, 36'))
    assert.ok(red.length >= 1)
    const startX = red[0].args[0] as number
    const curve = calls.find((c) => c.name === 'quadraticCurveTo' && c.strokeStyle.startsWith('rgba(196, 18, 36'))!
    const endX = curve.args[2] as number
    assert.ok(startX < m.mouthL.x && endX > m.mouthR.x, `${startX} ${endX}`)
  })

  it('タイトル・副題・キャッチコピーを描き、作風ごとに書体が違う。海外映画風・ノワールのタイトルは大文字', () => {
    const fonts = new Set<string>()
    for (const id of POSTER_STYLE_IDS) {
      const copy = { title: 'Test Title', subtitle: '副題', tagline: 'コピー' }
      const { calls } = render(id, [], copy)
      const texts = calls.filter((c) => c.name === 'fillText' || c.name === 'strokeText').map((c) => String(c.args[0]))
      const title = id === 'hollywood' || id === 'noir' || id === 'chaosClown' ? 'TEST TITLE' : 'Test Title'
      assert.ok(texts.includes(title), `${id} ${texts.join('|')}`)
      assert.ok(texts.some((t) => t.includes('副題')), id)
      assert.ok(texts.join('').includes(id === 'hollywood' ? 'コピー'.toUpperCase() : 'コ'), id)
      const titleCall = calls.find((c) => c.name === 'fillText' && String(c.args[0]) === title)!
      fonts.add(titleCall.font.replace(/\d+px/, ''))
    }
    assert.ok(fonts.size >= 5, [...fonts].join(' / '))
  })

  it('長すぎる・空の文字でも例外にならず、幅に収める', () => {
    for (const id of POSTER_STYLE_IDS) {
      const { report } = render(id, [], { title: 'あ'.repeat(24), subtitle: 'x'.repeat(32), tagline: 'い'.repeat(44) })
      for (const l of report.titleLines) assert.ok([...l].length * report.titleSize * 0.55 <= POSTER_WIDTH * 0.92, `${id} ${l}`)
      assert.doesNotThrow(() => render(id, [], { title: '', subtitle: '', tagline: '' }))
    }
  })

  it('保存のファイル名はポスター用', () => {
    assert.equal(posterFileName(new Date(2026, 9, 25, 9, 5, 7)), 'shibugarette_poster_20261025_090507.jpg')
  })
})
