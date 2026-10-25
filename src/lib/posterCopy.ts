/**
 * STEP 14：映画ポスターの作風と、タイトル・キャッチコピー（Gemini で生成、または定型文）。
 *
 * このファイルは他のモジュールに依存しない（アプリと、Gemini を呼ぶサーバー server/posterServer.ts の両方で使う）。
 * Gemini にはポスターの作風と利用者のお題（任意）だけを送り、写真は送らない。
 */
export type PosterStyleId = 'hollywood' | 'anime' | 'noir' | 'lazyCat' | 'chaosClown' | 'gentlemanChef'

export const POSTER_STYLE_IDS: PosterStyleId[] = ['hollywood', 'anime', 'noir', 'lazyCat', 'chaosClown', 'gentlemanChef']

export type PosterCopy = {
  /** 映画のタイトル */
  title: string
  /** 副題（タイトルと別の言語の読み・英題など。無ければ空） */
  subtitle: string
  /** キャッチコピー */
  tagline: string
}

export type PosterCopySpec = {
  label: string
  /** 一覧に出す短い説明 */
  description: string
  /** Gemini に渡す作風の説明 */
  prompt: string
  /** タイトル・副題・キャッチコピーの言語 */
  titleLang: 'en' | 'ja'
  subtitleLang: 'en' | 'ja' | 'none'
  taglineLang: 'en' | 'ja'
  /** API が使えないときの定型文 */
  fallbacks: PosterCopy[]
}

export const POSTER_COPY_SPECS: Record<PosterStyleId, PosterCopySpec> = {
  hollywood: {
    label: '海外映画風',
    description: '暗め・高コントラスト・英語タイトルの大作',
    prompt: 'ハリウッドの大作アクション映画。暗く重厚で、運命や決断を感じさせる英語のタイトル。',
    titleLang: 'en',
    subtitleLang: 'ja',
    taglineLang: 'en',
    fallbacks: [
      { title: 'LAST EMBER', subtitle: 'ラスト・エンバー', tagline: 'One spark. One choice. No way back.' },
      { title: 'SMOKE PROTOCOL', subtitle: 'スモーク・プロトコル', tagline: 'Every legend starts with a single light.' },
      { title: 'THE FINAL ASH', subtitle: 'ファイナル・アッシュ', tagline: 'When the smoke clears, only one remains.' },
    ],
  },
  anime: {
    label: 'アニメ映画風',
    description: '幻想的な光・エモい雰囲気・日本語タイトル',
    prompt: '日本の青春アニメ映画。夕焼けや星空、すれ違いや約束を感じさせる、エモくて少し切ない日本語のタイトル。',
    titleLang: 'ja',
    subtitleLang: 'en',
    taglineLang: 'ja',
    fallbacks: [
      { title: '君と煙の行方', subtitle: 'Where the Smoke Goes', tagline: 'あの日の夕焼けを、まだ覚えている。' },
      { title: '星降る夜の一服', subtitle: 'A Pause Under the Stars', tagline: 'この一瞬が、永遠になればいいのに。' },
      { title: '放課後、灯がともる', subtitle: 'After School Light', tagline: '言えなかった言葉が、煙になって空へ。' },
    ],
  },
  noir: {
    label: 'ノワール風',
    description: '白黒・煙・ハードボイルド',
    prompt: '1940 年代のフィルム・ノワール。雨の夜の街、探偵、裏切り。短く渋い英語のタイトルと、ハードボイルドな日本語のキャッチコピー。',
    titleLang: 'en',
    subtitleLang: 'ja',
    taglineLang: 'ja',
    fallbacks: [
      { title: 'SMOKE & SHADOWS', subtitle: '煙と影', tagline: 'この街では、誰もが何かを隠している。' },
      { title: 'MIDNIGHT ASH', subtitle: '真夜中の灰', tagline: '最後の一本に、火をつけた。' },
      { title: 'THE LONG DRAG', subtitle: 'ロング・ドラッグ', tagline: '雨はやまない。俺の過去も消えない。' },
    ],
  },
  lazyCat: {
    label: '脱力ネコ風',
    description: 'ライトグリーンの猫耳・くすみカラー・ゆるい漫画',
    prompt: 'ゆるい日常系の漫画原作映画。やる気のない猫が主人公。気の抜けた、ほっこり笑える日本語のタイトル。',
    titleLang: 'ja',
    subtitleLang: 'none',
    taglineLang: 'ja',
    fallbacks: [
      { title: 'きょうも、だらにゃん', subtitle: '', tagline: 'がんばらないって、決めたにゃ。' },
      { title: 'ねこは休憩中', subtitle: '', tagline: '世界は、あとで救うにゃ。' },
      { title: 'のんびり一服ニャン', subtitle: '', tagline: 'まあ、いっか。' },
    ],
  },
  chaosClown: {
    label: 'カオス・クラウン風',
    description: '白い顔・赤い口元・緑や紫の狂気',
    prompt: '狂気と混沌のサスペンス映画。笑顔の裏の不気味さ。英語のタイトルと、皮肉の効いた日本語のキャッチコピー。暴力や犯罪を具体的に描かない。',
    titleLang: 'en',
    subtitleLang: 'ja',
    taglineLang: 'ja',
    fallbacks: [
      { title: 'MAD SMOKE CIRCUS', subtitle: 'マッド・スモーク・サーカス', tagline: '笑え。世界はもっと狂っている。' },
      { title: 'CHAOS GRIN', subtitle: 'カオス・グリン', tagline: 'ルールなんて、燃やしてしまえ。' },
      { title: 'THE LAST LAUGH', subtitle: 'ラスト・ラフ', tagline: '最後に笑うのは、誰だ。' },
    ],
  },
  gentlemanChef: {
    label: '紳士シェフ風',
    description: '金髪の前髪・片目隠れ・スーツ・キザ',
    prompt: '女性に優しく料理の腕は一流、キザな紳士コックが主人公のロマンティック・アクション映画。気取った日本語のタイトルと、キザなキャッチコピー。',
    titleLang: 'ja',
    subtitleLang: 'en',
    taglineLang: 'ja',
    fallbacks: [
      { title: '恋するコックの一服', subtitle: 'The Gentleman Chef', tagline: 'レディのためなら、火の中へも。' },
      { title: '紳士は煙を纏う', subtitle: 'Smoke & Sauce', tagline: '最高の一皿と、最高の一服を。' },
      { title: '厨房のジェントルマン', subtitle: 'Kitchen Gentleman', tagline: '腹が減ったら、いつでも来な。' },
    ],
  },
}

/** 文字数の上限（ポスターに収まる長さ。超えたら切る） */
export const COPY_LIMITS = { title: 24, subtitle: 32, tagline: 44 } as const
/** 利用者のお題の文字数の上限 */
export const HINT_MAX = 40

export function isPosterStyle(v: unknown): v is PosterStyleId {
  return typeof v === 'string' && (POSTER_STYLE_IDS as string[]).includes(v)
}

/** 制御文字・改行をまとめ、前後の空白と囲みの引用符を取り、上限で切る */
function clean(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const s = [...v]
    .map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'「『“]+|["'」』”]+$/g, '')
    .trim()
  return [...s].slice(0, max).join('')
}

/** 生成結果（JSON）を検証して整える。タイトルかキャッチコピーが無ければ null */
export function sanitizeCopy(raw: unknown): PosterCopy | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const title = clean(r.title, COPY_LIMITS.title)
  const tagline = clean(r.tagline, COPY_LIMITS.tagline)
  if (!title || !tagline) return null
  return { title, subtitle: clean(r.subtitle, COPY_LIMITS.subtitle), tagline }
}

/** 定型文（rand は 0〜1。同じ値なら同じ文） */
export function fallbackCopy(style: PosterStyleId, rand = Math.random()): PosterCopy {
  const list = POSTER_COPY_SPECS[style].fallbacks
  return { ...list[Math.min(list.length - 1, Math.floor(Math.max(0, rand) * list.length))] }
}

export function cleanHint(hint: unknown): string {
  return clean(hint, HINT_MAX)
}

const LANG = { en: '英語', ja: '日本語' } as const

/** Gemini に送る指示（作風とお題だけ。写真の内容は含めない） */
export function buildCopyPrompt(style: PosterStyleId, hint = ''): string {
  const spec = POSTER_COPY_SPECS[style]
  const h = cleanHint(hint)
  return [
    'あなたは映画の宣伝コピーライターです。AR アプリ「シブガレット」（タバコの CG を持った人物の写真を映画ポスター風にする）のために、架空の映画のタイトルとキャッチコピーを 1 つ考えてください。',
    `作風：${spec.label}。${spec.prompt}`,
    `title：${LANG[spec.titleLang]}、${COPY_LIMITS.title} 文字以内。`,
    spec.subtitleLang === 'none' ? 'subtitle：空文字。' : `subtitle：${LANG[spec.subtitleLang]}の副題、${COPY_LIMITS.subtitle} 文字以内。`,
    `tagline：${LANG[spec.taglineLang]}のキャッチコピー、${COPY_LIMITS.tagline} 文字以内。`,
    h ? `お題（参考にする）：${h}` : '',
    '実在の映画・アニメ・漫画の作品名、キャラクター名、実在の人物名は使わないでください。喫煙を勧める表現、差別的・性的・暴力的な表現は避けてください。',
    'JSON で {"title": "...", "subtitle": "...", "tagline": "..."} だけを返してください。',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Gemini（generateContent）の JSON の応答の形（responseSchema） */
export const COPY_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    subtitle: { type: 'STRING' },
    tagline: { type: 'STRING' },
  },
  required: ['title', 'subtitle', 'tagline'],
} as const

/** generateContent の応答から、生成されたコピーを取り出す。取り出せなければ null */
export function parseGeminiResponse(body: unknown): PosterCopy | null {
  const parts = (body as { candidates?: { content?: { parts?: { text?: string }[] } }[] } | null)?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return null
  const text = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
  // ```json ... ``` で囲まれて返る場合もある
  const json = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '')
  try {
    return sanitizeCopy(JSON.parse(json))
  } catch {
    return null
  }
}
