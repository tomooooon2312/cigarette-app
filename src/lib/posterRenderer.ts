import type { Point2 } from './penGeometry'
import type { PosterCopy, PosterStyleId } from './posterCopy'

/**
 * STEP 14：撮影した AR 写真を、映画ポスター風の 1 枚に Canvas で合成する（画像全体の AI 生成はしない）。
 *
 * 順番：写真（顔が上 4 割に来るように切り抜き）→ 作風の色調（画素の変換）→ 顔のパーツ（猫耳・メイク・前髪とスーツ）
 *       → 作風の演出（光・煙・飛び散り・枠など）→ 文字（キャッチコピー・タイトル・副題・クレジット）。
 * 顔のパーツは、撮影時の Face Landmarker のランドマーク（PosterFace、写真の座標）から位置・大きさ・傾きを決める。
 * 顔が無ければパーツは描かない（ポスターは作れる）。
 */
export const POSTER_WIDTH = 1080
export const POSTER_HEIGHT = 1620

/** 撮影時の顔（写真の座標 px）。ランドマーク番号は Face Mesh のもの */
export type PosterFace = {
  /** 顔の輪郭（FACE_OVAL の順） */
  oval: Point2[]
  /** 額の上（10）・あご（152） */
  foreheadTop: Point2
  chin: Point2
  /** 頬の端（234 / 454。画面の左・右） */
  cheekL: Point2
  cheekR: Point2
  /** 目の中心（画面の左・右） */
  eyeL: Point2
  eyeR: Point2
  /** 口角（画面の左・右）、上唇の上（0）・下唇の下（17） */
  mouthL: Point2
  mouthR: Point2
  upperLip: Point2
  lowerLip: Point2
  noseTip: Point2
}

/** Face Mesh の輪郭のランドマーク番号（額の上から時計回り） */
export const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]

/** Face Mesh の正規化座標のランドマーク（478 点）から PosterFace を作る。at は正規化座標 → 写真・表示の座標 */
export function posterFaceFromLandmarks(at: (i: number) => Point2): PosterFace {
  const byX = (a: Point2, b: Point2): [Point2, Point2] => (a.x <= b.x ? [a, b] : [b, a])
  const mid = (a: Point2, b: Point2) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const [eyeL, eyeR] = byX(mid(at(33), at(133)), mid(at(263), at(362)))
  const [cheekL, cheekR] = byX(at(234), at(454))
  const [mouthL, mouthR] = byX(at(61), at(291))
  return {
    oval: FACE_OVAL.map(at),
    foreheadTop: at(10),
    chin: at(152),
    cheekL,
    cheekR,
    eyeL,
    eyeR,
    mouthL,
    mouthR,
    upperLip: at(0),
    lowerLip: at(17),
    noseTip: at(1),
  }
}

export function scaleFace(f: PosterFace, s: number, ox = 0, oy = 0): PosterFace {
  const m = (p: Point2) => ({ x: p.x * s + ox, y: p.y * s + oy })
  return {
    oval: f.oval.map(m),
    foreheadTop: m(f.foreheadTop),
    chin: m(f.chin),
    cheekL: m(f.cheekL),
    cheekR: m(f.cheekR),
    eyeL: m(f.eyeL),
    eyeR: m(f.eyeR),
    mouthL: m(f.mouthL),
    mouthR: m(f.mouthR),
    upperLip: m(f.upperLip),
    lowerLip: m(f.lowerLip),
    noseTip: m(f.noseTip),
  }
}

const dist = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y)

/** 顔の座標系：中心（両目の中点）、右（画面の右の目の向き）・上（あご → 額）の単位ベクトル、顔の幅 */
export type FaceFrame = { origin: Point2; right: Point2; up: Point2; width: number; height: number }

export function faceFrame(f: PosterFace): FaceFrame {
  const origin = { x: (f.eyeL.x + f.eyeR.x) / 2, y: (f.eyeL.y + f.eyeR.y) / 2 }
  const ex = f.eyeR.x - f.eyeL.x
  const ey = f.eyeR.y - f.eyeL.y
  const el = Math.hypot(ex, ey) || 1
  const right = { x: ex / el, y: ey / el }
  // 上：目の線に垂直で、あごから額の向き
  let up = { x: right.y, y: -right.x }
  if ((f.foreheadTop.x - f.chin.x) * up.x + (f.foreheadTop.y - f.chin.y) * up.y < 0) up = { x: -up.x, y: -up.y }
  return { origin, right, up, width: Math.max(dist(f.cheekL, f.cheekR), 1), height: Math.max(dist(f.chin, f.foreheadTop), 1) }
}

/** 顔の座標（u：右、v：上。顔の幅を 1 とする）→ 写真の座標 */
export function facePoint(fr: FaceFrame, u: number, v: number): Point2 {
  return {
    x: fr.origin.x + (fr.right.x * u + fr.up.x * v) * fr.width,
    y: fr.origin.y + (fr.right.y * u + fr.up.y * v) * fr.width,
  }
}

/**
 * 写真をポスターの大きさに切り抜く（cover）。顔があれば顔をポスターの横の中央・上から 4 割の位置へ寄せ、
 * 顔が小さい（ポスターの高さの 22% 未満）、または顔が写真の上の端に近く上から 1/3 より下へ寄せられないときは、最大 2 倍まで拡大する。
 */
export function coverCrop(
  pw: number,
  ph: number,
  faces: PosterFace[],
  W = POSTER_WIDTH,
  H = POSTER_HEIGHT,
  focusY = 0.4,
  /** 写真の上に足してよい余白（ポスターの高さに対する比率）。頭の上にパーツを付ける作風で、顔を下げるのに使う */
  maxPadTop = 0,
): { s: number; ox: number; oy: number } {
  let s = Math.max(W / pw, H / ph)
  let focus = { x: pw / 2, y: ph / 2 }
  if (faces.length > 0) {
    const xs = faces.flatMap((f) => [f.cheekL.x, f.cheekR.x])
    const ys = faces.flatMap((f) => [f.foreheadTop.y, f.chin.y])
    focus = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
    const faceH = Math.max(...faces.map((f) => dist(f.chin, f.foreheadTop)))
    const spanX = Math.max(...xs) - Math.min(...xs)
    // 顔が小さい、または写真の上の端に近くて下へ寄せられないときは拡大する（全員が横に収まる範囲で、最大 2 倍）
    // 余白を足せるときは、顔を下げるための拡大はしない（顔が大きくなりすぎる）
    const wantPos = maxPadTop > 0 ? 1 : (H * (focusY - 0.07)) / (Math.max(focus.y, 1) * s)
    const want = Math.max((H * 0.22) / (faceH * s), wantPos)
    const zoom = Math.min(2, Math.max(1, want), (W * 0.85) / Math.max(spanX * s, 1))
    s *= Math.max(1, zoom)
  }
  const ox = Math.min(0, Math.max(W - pw * s, W / 2 - focus.x * s))
  const oy = Math.min(H * maxPadTop, Math.max(H - ph * s, H * focusY - focus.y * s))
  return { s, ox, oy }
}

/** 色調の変換（0〜1 の値）。split は暗部・明部に足す色 */
export type Grade = {
  mono?: boolean
  saturation: number
  contrast: number
  brightness: number
  shadow: [number, number, number]
  highlight: [number, number, number]
}

export const GRADES: Record<PosterStyleId, Grade> = {
  // ティール & オレンジ：暗く、コントラストが強い
  hollywood: { saturation: 0.85, contrast: 1.35, brightness: -0.08, shadow: [-0.04, 0.05, 0.12], highlight: [0.12, 0.04, -0.06] },
  // 明るく鮮やか、暗部は青紫・明部は桃色
  anime: { saturation: 1.25, contrast: 0.95, brightness: 0.08, shadow: [0.05, 0.0, 0.16], highlight: [0.1, 0.05, 0.03] },
  // 白黒、強いコントラスト
  noir: { mono: true, saturation: 0, contrast: 1.6, brightness: -0.05, shadow: [0, 0, 0], highlight: [0, 0, 0] },
  // くすんだ色（彩度を落として黒を持ち上げる）
  lazyCat: { saturation: 0.45, contrast: 0.8, brightness: 0.06, shadow: [0.06, 0.08, 0.05], highlight: [0.02, 0.03, -0.02] },
  // 暗部は緑・明部は紫
  chaosClown: { saturation: 0.9, contrast: 1.3, brightness: -0.05, shadow: [0.0, 0.12, 0.02], highlight: [0.1, -0.04, 0.14] },
  // 暖かい金色、暗部は紺
  gentlemanChef: { saturation: 1.0, contrast: 1.12, brightness: 0.02, shadow: [0.0, 0.02, 0.08], highlight: [0.12, 0.08, -0.04] },
}

/** 画素（RGBA）に色調をかける */
export function applyGrade(data: Uint8ClampedArray, g: Grade): void {
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] / 255
    let gr = data[i + 1] / 255
    let b = data[i + 2] / 255
    const l = 0.299 * r + 0.587 * gr + 0.114 * b
    if (g.mono) {
      r = gr = b = l
    } else {
      r = l + (r - l) * g.saturation
      gr = l + (gr - l) * g.saturation
      b = l + (b - l) * g.saturation
    }
    const c = (v: number, k: number) => (v - 0.5) * g.contrast + 0.5 + g.brightness + g.shadow[k] * (1 - l) + g.highlight[k] * l
    data[i] = Math.round(Math.min(1, Math.max(0, c(r, 0))) * 255)
    data[i + 1] = Math.round(Math.min(1, Math.max(0, c(gr, 1))) * 255)
    data[i + 2] = Math.round(Math.min(1, Math.max(0, c(b, 2))) * 255)
  }
}

/** 決まった種から作る乱数（再描画しても演出の位置が変わらない） */
export function seededRandom(seed: number): () => number {
  let s = Math.floor(Math.abs(seed) * 2147483646) % 2147483646 || 1
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

/** 文字列を幅に収まるよう折り返す（日本語は文字ごと、英語は単語ごと）。maxLines を超えたら null */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number, maxLines: number): string[] | null {
  const ascii = /^[\x20-\x7e]*$/.test(text)
  const tokens = ascii ? text.split(/(\s+)/).filter((t) => t.length > 0) : [...text]
  const lines: string[] = []
  let line = ''
  for (const tok of tokens) {
    const next = line + tok
    if (measure(next.trim()) <= maxWidth || line.trim() === '') {
      line = next
    } else {
      lines.push(line.trim())
      line = tok.trimStart()
    }
  }
  if (line.trim()) lines.push(line.trim())
  if (lines.some((l) => measure(l) > maxWidth)) return null
  return lines.length <= maxLines ? lines : null
}

/**
 * 幅と行数に収まる文字の大きさと行を求める。行数は少ない方を優先する
 * （1 行で maxSize の 55% 以上の大きさに収まるなら 1 行）。大きい方から試すので、2 行のときも行の長さはほぼそろう
 * （「紳士は煙を纏 / う」のように 1 文字だけが次の行に残らない）。
 */
export function fitText(
  text: string,
  maxWidth: number,
  measureAt: (s: string, size: number) => number,
  maxSize: number,
  minSize: number,
  maxLines: number,
): { size: number; lines: string[] } {
  for (let lines = 1; lines <= maxLines; lines++) {
    const floor = lines === maxLines ? minSize : Math.max(minSize, maxSize * 0.55)
    for (let size = maxSize; size >= floor; size -= Math.max(1, Math.round(size * 0.06))) {
      const measure = (s: string) => measureAt(s, size)
      const wrapped = wrapText(text, maxWidth, measure, lines)
      if (wrapped && wrapped.length === lines) return { size, lines: wrapped }
      if (wrapped && lines === 1) return { size, lines: wrapped }
    }
  }
  return { size: minSize, lines: wrapText(text, maxWidth, (s) => measureAt(s, minSize), 99) ?? [text] }
}

/** 作風ごとの書体（iPhone・Mac に標準で入っている書体から。無ければ後ろの書体） */
export const POSTER_FONTS: Record<PosterStyleId, { title: string; sub: string; tagline: string; weight: string }> = {
  hollywood: { title: '"Avenir Next Condensed", "Helvetica Neue", "Arial Narrow", sans-serif', sub: '"Hiragino Sans", sans-serif', tagline: '"Avenir Next Condensed", "Helvetica Neue", sans-serif', weight: '800' },
  anime: { title: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif', sub: '"Avenir Next", "Helvetica Neue", sans-serif', tagline: '"Hiragino Mincho ProN", "Yu Mincho", serif', weight: '600' },
  noir: { title: '"Bodoni 72", "Didot", "Times New Roman", serif', sub: '"Hiragino Mincho ProN", serif', tagline: '"Hiragino Mincho ProN", "Yu Mincho", serif', weight: '700' },
  lazyCat: { title: '"Hiragino Maru Gothic ProN", "Rounded Mplus 1c", "Chalkboard SE", sans-serif', sub: '"Hiragino Maru Gothic ProN", sans-serif', tagline: '"Hiragino Maru Gothic ProN", "Chalkboard SE", sans-serif', weight: '700' },
  chaosClown: { title: '"Impact", "Avenir Next Condensed", "Arial Black", sans-serif', sub: '"Hiragino Sans", sans-serif', tagline: '"Hiragino Sans", sans-serif', weight: '900' },
  gentlemanChef: { title: '"Hiragino Mincho ProN", "Bodoni 72", "Yu Mincho", serif', sub: '"Snell Roundhand", "Apple Chancery", "Bodoni 72", cursive', tagline: '"Hiragino Mincho ProN", serif', weight: '700' },
}

export type PosterInput = {
  photo: CanvasImageSource
  photoWidth: number
  photoHeight: number
  /** 撮影時の顔（写真の座標） */
  faces: PosterFace[]
  style: PosterStyleId
  copy: PosterCopy
  /** 演出の乱数の種（0〜1） */
  seed: number
  /** 作業用の canvas を作る関数（テスト用。省略時は document） */
  createCanvas?: (w: number, h: number) => HTMLCanvasElement
}

/** 描画の結果（テスト・デバッグ用） */
export type PosterReport = { facesDrawn: number; parts: string[]; titleLines: string[]; titleSize: number }

/** ctx（POSTER_WIDTH × POSTER_HEIGHT）にポスターを描く */
export function renderPoster(ctx: CanvasRenderingContext2D, input: PosterInput): PosterReport {
  const W = POSTER_WIDTH
  const H = POSTER_HEIGHT
  const { style } = input
  const rand = seededRandom(input.seed + POSTER_STYLE_SEED[style])
  const createCanvas =
    input.createCanvas ??
    ((w: number, h: number) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      return c
    })

  // 1. 写真（顔を上 4 割へ）
  ctx.save()
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  // 頭の上にパーツを付ける作風（猫耳・前髪）は、顔を少し下に置く
  const focusY = style === 'lazyCat' || style === 'gentlemanChef' ? 0.47 : 0.4
  const { s, ox, oy } = coverCrop(input.photoWidth, input.photoHeight, input.faces, W, H, focusY, focusY > 0.4 ? 0.12 : 0)
  ctx.drawImage(input.photo, ox, oy, input.photoWidth * s, input.photoHeight * s)
  if (oy > 0) {
    // 写真の上に足した余白：写真の上の端の数行を引き伸ばし、上へ向かって暗くする
    ctx.drawImage(input.photo, 0, 0, input.photoWidth, Math.max(2, input.photoHeight * 0.01), ox, 0, input.photoWidth * s, oy + 1)
    const g = ctx.createLinearGradient(0, 0, 0, oy + 2)
    g.addColorStop(0, 'rgba(0, 0, 0, 0.45)')
    g.addColorStop(1, 'rgba(0, 0, 0, 0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, oy + 2)
  }
  ctx.restore()
  const faces = input.faces.map((f) => scaleFace(f, s, ox, oy)).filter((f) => faceFrame(f).width >= 24)

  // 2. 色調
  const img = ctx.getImageData(0, 0, W, H)
  applyGrade(img.data, GRADES[style])
  ctx.putImageData(img, 0, 0)

  // 3. 顔のパーツ
  const parts: string[] = []
  for (const f of faces) {
    if (style === 'lazyCat') parts.push(...drawCatParts(ctx, f))
    if (style === 'chaosClown') parts.push(...drawClownParts(ctx, f))
    if (style === 'gentlemanChef') parts.push(...drawChefParts(ctx, f, H))
  }

  // 4. 作風の演出
  EFFECTS[style](ctx, W, H, rand, createCanvas)

  // 5. 文字
  const text = drawTexts(ctx, style, input.copy, W, H, rand)
  return { facesDrawn: faces.length, parts, titleLines: text.lines, titleSize: text.size }
}

/** 作風ごとに演出の配置を変える種 */
const POSTER_STYLE_SEED: Record<PosterStyleId, number> = { hollywood: 0.11, anime: 0.23, noir: 0.37, lazyCat: 0.41, chaosClown: 0.53, gentlemanChef: 0.67 }

// ---------------------------------------------------------------------------------------------
// 顔のパーツ（オリジナルの表現。特定の作品のキャラクターを再現しない）

/** 脱力ネコ：ライトグリーンの猫耳・頬の赤み・ひげ */
function drawCatParts(ctx: CanvasRenderingContext2D, f: PosterFace): string[] {
  const fr = faceFrame(f)
  const w = fr.width
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const side of [-1, 1]) {
    const base = (dv: number, du: number) => facePoint(fr, side * (0.3 + du), 0.56 + dv)
    const a = base(-0.02, -0.17)
    const b = base(0.02, 0.17)
    const tip = facePoint(fr, side * 0.44, 1.25)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.quadraticCurveTo(facePoint(fr, side * 0.24, 1.0).x, facePoint(fr, side * 0.24, 1.0).y, tip.x, tip.y)
    ctx.quadraticCurveTo(facePoint(fr, side * 0.56, 0.92).x, facePoint(fr, side * 0.56, 0.92).y, b.x, b.y)
    ctx.closePath()
    ctx.fillStyle = '#b6e3a4'
    ctx.fill()
    ctx.lineWidth = Math.max(w * 0.028, 2)
    ctx.strokeStyle = '#5f8a57'
    ctx.stroke()
    // 耳の内側
    const ia = facePoint(fr, side * 0.25, 0.63)
    const ib = facePoint(fr, side * 0.44, 0.63)
    const it = facePoint(fr, side * 0.41, 1.08)
    ctx.beginPath()
    ctx.moveTo(ia.x, ia.y)
    ctx.quadraticCurveTo(facePoint(fr, side * 0.3, 0.9).x, facePoint(fr, side * 0.3, 0.9).y, it.x, it.y)
    ctx.quadraticCurveTo(facePoint(fr, side * 0.48, 0.85).x, facePoint(fr, side * 0.48, 0.85).y, ib.x, ib.y)
    ctx.closePath()
    ctx.fillStyle = '#e9cfc4'
    ctx.fill()
  }
  // 頬の赤み
  for (const side of [-1, 1]) {
    const c = facePoint(fr, side * 0.3, -0.32)
    const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, w * 0.13)
    g.addColorStop(0, 'rgba(235, 140, 140, 0.5)')
    g.addColorStop(1, 'rgba(235, 140, 140, 0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(c.x, c.y, w * 0.13, 0, Math.PI * 2)
    ctx.fill()
  }
  // ひげ（ゆるく垂れた 3 本ずつ）
  ctx.strokeStyle = 'rgba(70, 70, 70, 0.7)'
  ctx.lineWidth = Math.max(w * 0.012, 1.5)
  for (const side of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const a = facePoint(fr, side * 0.2, -0.42 - k * 0.05)
      const b = facePoint(fr, side * 0.55, -0.4 - k * 0.1)
      const c = facePoint(fr, side * 0.38, -0.38 - k * 0.07)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.quadraticCurveTo(c.x, c.y, b.x, b.y)
      ctx.stroke()
    }
  }
  ctx.restore()
  return ['catEars', 'blush', 'whiskers']
}

/** カオス・クラウン：白い顔・濃い目元・赤く大きな口元・緑の髪の筋 */
function drawClownParts(ctx: CanvasRenderingContext2D, f: PosterFace): string[] {
  const fr = faceFrame(f)
  const w = fr.width
  ctx.save()
  // 白い顔（輪郭の内側を半透明の白で塗る。目鼻立ちは少し透ける）
  ctx.beginPath()
  f.oval.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.closePath()
  ctx.fillStyle = 'rgba(244, 244, 236, 0.62)'
  ctx.fill()
  // 目元：上下に伸びたにじんだ菱形
  for (const eye of [f.eyeL, f.eyeR]) {
    const r = w * 0.12
    const pts = [
      [0, 1.6],
      [0.55, 0.35],
      [1.05, 0],
      [0.5, -0.4],
      [0, -1.5],
      [-0.5, -0.4],
      [-1.05, 0],
      [-0.55, 0.35],
    ]
    ctx.beginPath()
    pts.forEach(([u, v], i) => {
      const p = { x: eye.x + (fr.right.x * u + fr.up.x * v) * r, y: eye.y + (fr.right.y * u + fr.up.y * v) * r }
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    })
    ctx.closePath()
    ctx.fillStyle = 'rgba(28, 16, 40, 0.78)'
    ctx.fill()
  }
  // 口元：口角の外側まで、頬へ上がる赤い笑み
  const lip = Math.max(dist(f.upperLip, f.lowerLip), w * 0.06)
  const left = facePoint(fr, -0.36, -0.42)
  const right = facePoint(fr, 0.36, -0.42)
  const bottom = { x: (f.upperLip.x + f.lowerLip.x) / 2 - fr.up.x * lip * 0.4, y: (f.upperLip.y + f.lowerLip.y) / 2 - fr.up.y * lip * 0.4 }
  ctx.strokeStyle = 'rgba(196, 18, 36, 0.82)'
  ctx.lineWidth = lip * 0.75
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(left.x, left.y)
  ctx.quadraticCurveTo(bottom.x * 2 - (left.x + right.x) / 2, bottom.y * 2 - (left.y + right.y) / 2, right.x, right.y)
  ctx.stroke()
  // 緑の髪の筋（額の上）
  ctx.strokeStyle = 'rgba(70, 200, 90, 0.55)'
  ctx.lineWidth = w * 0.04
  for (let k = -3; k <= 3; k++) {
    const a = facePoint(fr, k * 0.12, 0.55)
    const b = facePoint(fr, k * 0.16 + 0.05, 0.95)
    const c = facePoint(fr, k * 0.1 - 0.06, 0.78)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.quadraticCurveTo(c.x, c.y, b.x, b.y)
    ctx.stroke()
  }
  ctx.restore()
  return ['whiteFace', 'eyeMakeup', 'redSmile', 'greenHair']
}

/**
 * 紳士シェフの前髪の輪郭（顔の座標：u = 右、v = 上、顔の幅 = 1。原点は両目の中点）。
 * 額を覆い、画面の左の目（u ≒ −0.2, v = 0）を隠して、右の目は見せる。
 */
export const CHEF_HAIR: [number, number][] = [
  [-0.62, 0.3],
  [-0.55, 0.62],
  [-0.2, 0.8],
  [0.3, 0.77],
  [0.62, 0.5],
  [0.6, 0.12],
  [0.4, 0.3],
  [0.12, 0.27],
  [-0.02, 0.06],
  [-0.12, -0.2],
  [-0.3, -0.3],
  [-0.5, -0.26],
  [-0.64, -0.06],
]

/** 紳士シェフ：片目が隠れる金髪の前髪と、スーツの襟・ネクタイ */
function drawChefParts(ctx: CanvasRenderingContext2D, f: PosterFace, H: number): string[] {
  const fr = faceFrame(f)
  const w = fr.width
  ctx.save()
  // スーツ（あごの下から画面の下まで）
  const neck = facePoint(fr, 0, -(dist(fr.origin, f.chin) / w) - 0.08)
  const down = { x: -fr.up.x, y: -fr.up.y }
  const at = (u: number, d: number) => ({ x: neck.x + (fr.right.x * u + down.x * d) * w, y: neck.y + (fr.right.y * u + down.y * d) * w })
  const far = Math.max(2, (H - neck.y) / w + 0.5)
  ctx.fillStyle = '#1c2233'
  ctx.beginPath()
  const jacket = [at(-0.3, 0), at(-1.45, 0.35), at(-1.7, far), at(1.7, far), at(1.45, 0.35), at(0.3, 0)]
  jacket.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.closePath()
  ctx.fill()
  // シャツ（白い V）
  ctx.fillStyle = '#f2efe8'
  ctx.beginPath()
  ;[at(-0.3, 0), at(0, 1.05), at(0.3, 0)].forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.closePath()
  ctx.fill()
  // ネクタイ
  ctx.fillStyle = '#121212'
  ctx.beginPath()
  ;[at(-0.07, 0.04), at(0.07, 0.04), at(0.1, 0.85), at(0, 1.0), at(-0.1, 0.85)].forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.closePath()
  ctx.fill()
  // 襟（ラペル）の線
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)'
  ctx.lineWidth = Math.max(w * 0.015, 1.5)
  for (const side of [-1, 1]) {
    const a = at(side * 0.3, 0)
    const b = at(side * 0.55, 0.9)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }

  // 金髪の前髪：額を覆い、画面の左の目を隠すように流す（右の目は見える）
  const hair = CHEF_HAIR
  const pts = hair.map(([u, v]) => facePoint(fr, u, v))
  ctx.beginPath()
  // 点の中点をつなぐ曲線（なめらかな髪の輪郭）
  const midOf = (a: Point2, b: Point2) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const start = midOf(pts[pts.length - 1], pts[0])
  ctx.moveTo(start.x, start.y)
  for (let i = 0; i < pts.length; i++) {
    const m = midOf(pts[i], pts[(i + 1) % pts.length])
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y)
  }
  ctx.closePath()
  const top = facePoint(fr, 0, 0.8)
  const bottom = facePoint(fr, -0.3, -0.2)
  const g = ctx.createLinearGradient(top.x, top.y, bottom.x, bottom.y)
  g.addColorStop(0, '#fbe27e')
  g.addColorStop(0.55, '#e7b23e')
  g.addColorStop(1, '#b67d1f')
  ctx.fillStyle = g
  ctx.fill()
  ctx.strokeStyle = 'rgba(120, 78, 18, 0.75)'
  ctx.lineWidth = Math.max(w * 0.012, 1.5)
  ctx.stroke()
  // 前髪の毛先（下へとがった房）
  ctx.fillStyle = '#d9a23a'
  const tips: [number, number, number, number][] = [
    [0.36, 0.3, 0.3, 0.16],
    [0.2, 0.27, 0.12, 0.1],
    [0.04, 0.12, -0.06, -0.06],
    [-0.1, -0.12, -0.2, -0.36],
    [-0.28, -0.26, -0.36, -0.42],
    [-0.46, -0.22, -0.56, -0.34],
  ]
  for (const [u0, v0, u1, v1] of tips) {
    const a = facePoint(fr, u0 + 0.07, v0 + 0.05)
    const b = facePoint(fr, u0 - 0.07, v0 + 0.02)
    const t = facePoint(fr, u1, v1)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.quadraticCurveTo((a.x + t.x) / 2, (a.y + t.y) / 2, t.x, t.y)
    ctx.lineTo(b.x, b.y)
    ctx.closePath()
    ctx.fill()
  }
  // 毛の流れ
  ctx.strokeStyle = 'rgba(150, 100, 30, 0.45)'
  ctx.lineWidth = Math.max(w * 0.01, 1)
  for (let k = 0; k < 7; k++) {
    const a = facePoint(fr, 0.45 - k * 0.12, 0.72 - k * 0.02)
    const c = facePoint(fr, 0.15 - k * 0.1, 0.4 - k * 0.04)
    const b = facePoint(fr, -0.1 - k * 0.07, 0.05 - k * 0.04)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.quadraticCurveTo(c.x, c.y, b.x, b.y)
    ctx.stroke()
  }
  // つや
  ctx.strokeStyle = 'rgba(255, 250, 225, 0.6)'
  ctx.lineWidth = Math.max(w * 0.025, 2)
  const s1 = facePoint(fr, 0.3, 0.62)
  const s2 = facePoint(fr, -0.1, 0.5)
  const s3 = facePoint(fr, -0.3, 0.2)
  ctx.beginPath()
  ctx.moveTo(s1.x, s1.y)
  ctx.quadraticCurveTo(s2.x, s2.y, s3.x, s3.y)
  ctx.stroke()
  ctx.restore()
  return ['suit', 'tie', 'blondBangs']
}

// ---------------------------------------------------------------------------------------------
// 作風の演出

type Effect = (ctx: CanvasRenderingContext2D, W: number, H: number, rand: () => number, createCanvas: (w: number, h: number) => HTMLCanvasElement) => void

/** 柔らかい光（縮小 → 拡大でぼかした画像を screen で重ねる） */
function bloom(ctx: CanvasRenderingContext2D, W: number, H: number, alpha: number, createCanvas: (w: number, h: number) => HTMLCanvasElement) {
  const small = createCanvas(Math.round(W / 12), Math.round(H / 12))
  const sctx = small.getContext('2d')
  if (!sctx) return
  sctx.drawImage(ctx.canvas, 0, 0, small.width, small.height)
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.globalCompositeOperation = 'screen'
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(small, 0, 0, W, H)
  ctx.restore()
  small.width = 0
  small.height = 0
}

function vignette(ctx: CanvasRenderingContext2D, W: number, H: number, strength: number, color = '0, 0, 0') {
  const g = ctx.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.3, W / 2, H * 0.5, Math.max(W, H) * 0.75)
  g.addColorStop(0, `rgba(${color}, 0)`)
  g.addColorStop(1, `rgba(${color}, ${strength})`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
}

/** 上下を暗くする帯（文字を読みやすくする） */
function bands(ctx: CanvasRenderingContext2D, W: number, H: number, top: number, bottom: number, color = '0, 0, 0') {
  const t = ctx.createLinearGradient(0, 0, 0, H * 0.28)
  t.addColorStop(0, `rgba(${color}, ${top})`)
  t.addColorStop(1, `rgba(${color}, 0)`)
  ctx.fillStyle = t
  ctx.fillRect(0, 0, W, H * 0.28)
  const b = ctx.createLinearGradient(0, H * 0.55, 0, H)
  b.addColorStop(0, `rgba(${color}, 0)`)
  b.addColorStop(1, `rgba(${color}, ${bottom})`)
  ctx.fillStyle = b
  ctx.fillRect(0, H * 0.55, W, H * 0.45)
}

function grain(ctx: CanvasRenderingContext2D, W: number, H: number, rand: () => number, count: number, alpha: number) {
  ctx.save()
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = rand() < 0.5 ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`
    ctx.fillRect(rand() * W, rand() * H, 2, 2)
  }
  ctx.restore()
}

/** 煙の帯（大きく淡い円を曲線に沿って重ねる） */
function smoke(ctx: CanvasRenderingContext2D, W: number, H: number, rand: () => number, wisps: number, alpha: number, color = '255, 255, 255') {
  ctx.save()
  for (let k = 0; k < wisps; k++) {
    const y0 = H * (0.15 + rand() * 0.75)
    const amp = H * (0.03 + rand() * 0.06)
    const phase = rand() * Math.PI * 2
    for (let i = 0; i <= 24; i++) {
      const x = (W * i) / 24
      const y = y0 + Math.sin(phase + i * 0.35) * amp
      const r = W * (0.05 + rand() * 0.07)
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, `rgba(${color}, ${alpha})`)
      g.addColorStop(1, `rgba(${color}, 0)`)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.restore()
}

const EFFECTS: Record<PosterStyleId, Effect> = {
  hollywood: (ctx, W, H, rand) => {
    bands(ctx, W, H, 0.75, 0.92)
    // 横に伸びるレンズフレア
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const fy = H * 0.24
    const g = ctx.createLinearGradient(0, fy, W, fy)
    g.addColorStop(0, 'rgba(80, 160, 255, 0)')
    g.addColorStop(0.5, 'rgba(160, 210, 255, 0.55)')
    g.addColorStop(1, 'rgba(80, 160, 255, 0)')
    ctx.fillStyle = g
    ctx.fillRect(0, fy - 3, W, 6)
    const c = ctx.createRadialGradient(W * 0.72, fy, 0, W * 0.72, fy, W * 0.18)
    c.addColorStop(0, 'rgba(255, 230, 190, 0.55)')
    c.addColorStop(1, 'rgba(255, 140, 60, 0)')
    ctx.fillStyle = c
    ctx.fillRect(0, 0, W, H)
    // 火の粉
    for (let i = 0; i < 90; i++) {
      const x = rand() * W
      const y = H * (0.3 + rand() * 0.65)
      ctx.fillStyle = `rgba(255, ${120 + Math.round(rand() * 80)}, 40, ${0.3 + rand() * 0.5})`
      ctx.beginPath()
      ctx.arc(x, y, 1.5 + rand() * 3.5, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
    vignette(ctx, W, H, 0.7)
  },
  anime: (ctx, W, H, rand, createCanvas) => {
    bloom(ctx, W, H, 0.45, createCanvas)
    // 空のグラデーション（上：夕焼けの桃色 → 青）
    ctx.save()
    ctx.globalCompositeOperation = 'screen'
    const sky = ctx.createLinearGradient(0, 0, 0, H * 0.6)
    sky.addColorStop(0, 'rgba(255, 150, 190, 0.55)')
    sky.addColorStop(0.5, 'rgba(120, 150, 255, 0.25)')
    sky.addColorStop(1, 'rgba(120, 150, 255, 0)')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, W, H * 0.6)
    // 右上からの光の筋
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI * 0.72 + i * 0.09 + rand() * 0.04
      ctx.fillStyle = `rgba(255, 245, 220, ${0.08 + rand() * 0.08})`
      ctx.beginPath()
      ctx.moveTo(W * 1.05, -H * 0.05)
      ctx.lineTo(W * 1.05 + Math.cos(a) * H * 1.6, -H * 0.05 - Math.sin(a) * H * 1.6)
      ctx.lineTo(W * 1.05 + Math.cos(a + 0.035) * H * 1.6, -H * 0.05 - Math.sin(a + 0.035) * H * 1.6)
      ctx.closePath()
      ctx.fill()
    }
    // 光の粒（ボケ）ときらめき
    for (let i = 0; i < 40; i++) {
      const x = rand() * W
      const y = rand() * H
      const r = 4 + rand() * 22
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, `rgba(255, 255, 240, ${0.25 + rand() * 0.35})`)
      g.addColorStop(1, 'rgba(255, 220, 240, 0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
    bands(ctx, W, H, 0.15, 0.55, '20, 20, 70')
  },
  noir: (ctx, W, H, rand) => {
    // ブラインドの影
    ctx.save()
    ctx.translate(W / 2, H / 2)
    ctx.rotate(-0.35)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.32)'
    for (let y = -H; y < H; y += 70) ctx.fillRect(-W * 1.5, y, W * 3, 30)
    ctx.restore()
    smoke(ctx, W, H, rand, 4, 0.07)
    bands(ctx, W, H, 0.7, 0.85)
    vignette(ctx, W, H, 0.85)
    grain(ctx, W, H, rand, 9000, 0.12)
  },
  lazyCat: (ctx, W, H, rand) => {
    // 漫画の集中線（四隅から、淡く）
    ctx.save()
    ctx.strokeStyle = 'rgba(90, 110, 90, 0.18)'
    ctx.lineWidth = 3
    for (let i = 0; i < 70; i++) {
      const a = rand() * Math.PI * 2
      const r0 = Math.max(W, H) * (0.55 + rand() * 0.1)
      const r1 = Math.max(W, H) * 0.9
      ctx.beginPath()
      ctx.moveTo(W / 2 + Math.cos(a) * r0, H * 0.45 + Math.sin(a) * r0)
      ctx.lineTo(W / 2 + Math.cos(a) * r1, H * 0.45 + Math.sin(a) * r1)
      ctx.stroke()
    }
    // 網点（左上・右下）
    ctx.fillStyle = 'rgba(170, 205, 160, 0.45)'
    for (let y = 0; y < H * 0.22; y += 26) {
      for (let x = 0; x < W * 0.4; x += 26) {
        const r = 7 * (1 - (x / (W * 0.4) + y / (H * 0.22)) / 2)
        if (r > 0.5) {
          ctx.beginPath()
          ctx.arc(x + 13, y + 13, r, 0, Math.PI * 2)
          ctx.fill()
          ctx.beginPath()
          ctx.arc(W - x - 13, H - y - 13, r, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
    // コマの枠（クリーム色の太い枠と黒い線）
    ctx.strokeStyle = '#f4efdc'
    ctx.lineWidth = 36
    ctx.strokeRect(18, 18, W - 36, H - 36)
    ctx.strokeStyle = '#3d4a3a'
    ctx.lineWidth = 6
    ctx.strokeRect(36, 36, W - 72, H - 72)
    ctx.restore()
  },
  chaosClown: (ctx, W, H, rand) => {
    // ずれ（横の帯を少しずらす）
    for (let i = 0; i < 7; i++) {
      const y = Math.round(rand() * H)
      const h = Math.round(8 + rand() * 40)
      const dx = Math.round((rand() - 0.5) * 60)
      ctx.drawImage(ctx.canvas, 0, y, W, h, dx, y, W, h)
    }
    // 緑と紫の飛び散り
    ctx.save()
    for (let i = 0; i < 26; i++) {
      const x = rand() * W
      const y = rand() < 0.5 ? rand() * H * 0.3 : H * (0.7 + rand() * 0.3)
      const r = 10 + rand() * 60
      ctx.fillStyle = rand() < 0.5 ? `rgba(80, 210, 70, ${0.35 + rand() * 0.35})` : `rgba(150, 40, 200, ${0.35 + rand() * 0.35})`
      ctx.beginPath()
      for (let k = 0; k <= 10; k++) {
        const a = (k / 10) * Math.PI * 2
        const rr = r * (0.6 + rand() * 0.6)
        const px = x + Math.cos(a) * rr
        const py = y + Math.sin(a) * rr
        if (k === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      ctx.fill()
    }
    // ひっかき傷
    ctx.strokeStyle = 'rgba(230, 230, 230, 0.25)'
    ctx.lineWidth = 2
    for (let i = 0; i < 30; i++) {
      const x = rand() * W
      const y = rand() * H
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + (rand() - 0.5) * 200, y + rand() * 120)
      ctx.stroke()
    }
    ctx.restore()
    bands(ctx, W, H, 0.6, 0.8, '20, 5, 30')
    vignette(ctx, W, H, 0.6, '30, 0, 40')
  },
  gentlemanChef: (ctx, W, H, rand, createCanvas) => {
    bloom(ctx, W, H, 0.25, createCanvas)
    smoke(ctx, W, H, rand, 2, 0.05, '255, 230, 190')
    // 金色のボケ
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (let i = 0; i < 26; i++) {
      const x = rand() * W
      const y = rand() * H * 0.5
      const r = 8 + rand() * 30
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, `rgba(255, 210, 120, ${0.18 + rand() * 0.25})`)
      g.addColorStop(1, 'rgba(255, 180, 80, 0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
    bands(ctx, W, H, 0.55, 0.85, '15, 12, 25')
    // 細い金の枠と四隅の飾り
    ctx.save()
    ctx.strokeStyle = 'rgba(226, 190, 110, 0.9)'
    ctx.lineWidth = 3
    ctx.strokeRect(40, 40, W - 80, H - 80)
    ctx.lineWidth = 1.5
    ctx.strokeRect(52, 52, W - 104, H - 104)
    for (const [x, y] of [[40, 40], [W - 40, 40], [40, H - 40], [W - 40, H - 40]]) {
      ctx.beginPath()
      ctx.arc(x, y, 14, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()
  },
}

// ---------------------------------------------------------------------------------------------
// 文字

const STUDIO = 'SHIBUGARETTE PICTURES'
const BILLING = [
  `${STUDIO} PRESENTS  A SMOKE & MIRRORS PRODUCTION`,
  'MUSIC BY ASH  EDITED BY FILTER  CINEMATOGRAPHY BY AR  DIRECTED BY YOU',
]

function setFont(ctx: CanvasRenderingContext2D, weight: string, size: number, family: string, italic = false) {
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${Math.round(size)}px ${family}`
}

function setSpacing(ctx: CanvasRenderingContext2D, px: number) {
  if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`
}

function measurer(ctx: CanvasRenderingContext2D, weight: string, family: string, italic = false) {
  return (s: string, size: number) => {
    setFont(ctx, weight, size, family, italic)
    return ctx.measureText(s).width
  }
}

/** 下部のクレジット（細い文字の 2 行）と公開日 */
function billing(ctx: CanvasRenderingContext2D, W: number, H: number, color: string, release: string, family = '"Avenir Next Condensed", "Helvetica Neue", "Arial Narrow", sans-serif') {
  ctx.save()
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  setSpacing(ctx, 2)
  BILLING.forEach((line, i) => {
    const f = fitText(line, W * 0.86, measurer(ctx, '500', family), 22, 12, 1)
    setFont(ctx, '500', f.size, family)
    ctx.fillText(f.lines[0], W / 2, H - 132 + i * 30)
  })
  setSpacing(ctx, 6)
  setFont(ctx, '700', 34, family)
  ctx.fillText(release, W / 2, H - 52)
  ctx.restore()
}

/** タイトルを描く（行ごと、中央揃え）。戻り値は使った大きさと行 */
function titleBlock(
  ctx: CanvasRenderingContext2D,
  text: string,
  opts: {
    /** 1 行目のベースライン（bottom が true なら最後の行のベースライン） */
    y: number
    bottom?: boolean
    maxWidth: number
    maxSize: number
    minSize: number
    maxLines: number
    family: string
    weight: string
    italic?: boolean
    spacing?: number
    paint: (line: string, x: number, y: number, size: number) => void
  },
): { size: number; lines: string[]; bottom: number } {
  setSpacing(ctx, opts.spacing ?? 0)
  const f = fitText(text, opts.maxWidth, measurer(ctx, opts.weight, opts.family, opts.italic), opts.maxSize, opts.minSize, opts.maxLines)
  setFont(ctx, opts.weight, f.size, opts.family, opts.italic)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  const lh = f.size * 1.05
  const first = opts.bottom ? opts.y - (f.lines.length - 1) * lh : opts.y
  f.lines.forEach((line, i) => opts.paint(line, W_CENTER(ctx), first + i * lh, f.size))
  return { ...f, bottom: first + (f.lines.length - 1) * lh }
}

/** ポスターの横の中央（テストの偽の ctx では canvas が無いので、ポスターの幅から求める） */
const W_CENTER = (ctx: CanvasRenderingContext2D) => (ctx.canvas?.width ?? POSTER_WIDTH) / 2

/** 下から積む文字の位置：クレジット（H − 132 〜）の上に副題、その上にタイトルの最後の行 */
const SUB_BASELINE = POSTER_HEIGHT - 196
function titleBottom(subtitle: string, subSize: number): number {
  return subtitle ? SUB_BASELINE - subSize * 1.25 - 18 : SUB_BASELINE - 10
}

function drawTexts(ctx: CanvasRenderingContext2D, style: PosterStyleId, copy: PosterCopy, W: number, H: number, rand: () => number): { size: number; lines: string[] } {
  const font = POSTER_FONTS[style]
  const title = copy.title.trim() || ' '
  ctx.save()
  let result: { size: number; lines: string[] } = { size: 0, lines: [] }
  const simple = (family: string, weight: string, size: number, color: string, text: string, y: number, spacing = 0, italic = false, maxWidth = W * 0.86) => {
    if (!text) return
    setSpacing(ctx, spacing)
    const f = fitText(text, maxWidth, measurer(ctx, weight, family, italic), size, Math.max(12, size * 0.5), 2)
    setFont(ctx, weight, f.size, family, italic)
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    f.lines.forEach((l, i) => ctx.fillText(l, W / 2, y + i * f.size * 1.25))
  }

  switch (style) {
    case 'hollywood': {
      simple(font.tagline, '600', 40, 'rgba(235, 235, 235, 0.92)', copy.tagline.toUpperCase(), 120, 6)
      const t = titleBlock(ctx, title.toUpperCase(), {
        y: titleBottom(copy.subtitle, 36),
        bottom: true,
        maxWidth: W * 0.9,
        maxSize: 190,
        minSize: 70,
        maxLines: 2,
        family: font.title,
        weight: font.weight,
        spacing: 8,
        paint: (line, x, y, size) => {
          const g = ctx.createLinearGradient(0, y - size, 0, y)
          g.addColorStop(0, '#fff6dc')
          g.addColorStop(0.5, '#e9c46a')
          g.addColorStop(1, '#9c6b22')
          ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
          ctx.shadowBlur = 24
          ctx.fillStyle = g
          ctx.fillText(line, x, y)
          ctx.shadowBlur = 0
        },
      })
      result = t
      simple(font.sub, '600', 36, 'rgba(240, 225, 190, 0.9)', copy.subtitle, SUB_BASELINE, 4)
      billing(ctx, W, H, 'rgba(220, 220, 220, 0.75)', 'COMING SOON')
      break
    }
    case 'anime': {
      // キャッチコピーは右端に縦書き
      if (copy.tagline) {
        const chars = [...copy.tagline]
        const size = Math.min(48, (H * 0.62) / Math.max(chars.length, 1))
        setFont(ctx, '600', size, font.tagline)
        ctx.fillStyle = '#ffffff'
        ctx.shadowColor = 'rgba(80, 60, 160, 0.8)'
        ctx.shadowBlur = 14
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        chars.forEach((c, i) => {
          const rotate = /[ー〜～…―\-()（）「」『』]/.test(c)
          // 縦書きの句読点は右上へ寄せる
          const punct = /[、。，．]/.test(c)
          const x = W - 80 + (punct ? size * 0.32 : 0)
          const y = 140 + i * size * 1.1 - (punct ? size * 0.32 : 0)
          if (rotate) {
            ctx.save()
            ctx.translate(x, y)
            ctx.rotate(Math.PI / 2)
            ctx.fillText(c, 0, 0)
            ctx.restore()
          } else ctx.fillText(c, x, y)
        })
        ctx.shadowBlur = 0
      }
      const t = titleBlock(ctx, title, {
        y: titleBottom(copy.subtitle, 38),
        bottom: true,
        maxWidth: W * 0.84,
        maxSize: 150,
        minSize: 60,
        maxLines: 2,
        family: font.title,
        weight: font.weight,
        spacing: 4,
        paint: (line, x, y) => {
          ctx.shadowColor = 'rgba(140, 170, 255, 0.95)'
          ctx.shadowBlur = 36
          ctx.fillStyle = '#ffffff'
          ctx.fillText(line, x, y)
          ctx.shadowBlur = 0
          ctx.lineWidth = 2
          ctx.strokeStyle = 'rgba(255, 210, 230, 0.8)'
          ctx.strokeText(line, x, y)
        },
      })
      result = t
      simple(font.sub, '500', 38, 'rgba(255, 240, 250, 0.95)', copy.subtitle, SUB_BASELINE, 3, true)
      billing(ctx, W, H, 'rgba(255, 255, 255, 0.8)', '近日公開', '"Hiragino Sans", "Avenir Next", sans-serif')
      break
    }
    case 'noir': {
      const t = titleBlock(ctx, title.toUpperCase(), {
        y: 230,
        maxWidth: W * 0.88,
        maxSize: 170,
        minSize: 70,
        maxLines: 2,
        family: font.title,
        weight: font.weight,
        spacing: 2,
        paint: (line, x, y) => {
          ctx.fillStyle = '#f3f3f3'
          ctx.fillText(line, x, y)
        },
      })
      result = t
      // 赤い線
      ctx.fillStyle = '#c1121f'
      ctx.fillRect(W * 0.3, t.bottom + 34, W * 0.4, 8)
      simple(font.sub, '600', 40, '#d8d8d8', copy.subtitle, t.bottom + 100, 8)
      simple(font.tagline, '600', 52, '#ffffff', copy.tagline, H - 250, 2)
      billing(ctx, W, H, 'rgba(200, 200, 200, 0.7)', 'COMING SOON')
      break
    }
    case 'lazyCat': {
      // 吹き出し（キャッチコピー）
      if (copy.tagline) {
        setFont(ctx, '700', 44, font.tagline)
        const f = fitText(copy.tagline, W * 0.62, measurer(ctx, '700', font.tagline), 46, 24, 2)
        setFont(ctx, '700', f.size, font.tagline)
        const bw = Math.max(...f.lines.map((l) => ctx.measureText(l).width)) + 70
        const bh = f.lines.length * f.size * 1.3 + 44
        // タイトルの上に置き、しっぽは上（顔の方）へ向ける（頭の上の猫耳を隠さない）
        const bx = 90
        const by = H - 490 - bh
        ctx.fillStyle = '#fffdf2'
        ctx.strokeStyle = '#3d4a3a'
        ctx.lineWidth = 5
        ctx.beginPath()
        ctx.moveTo(bx + bw * 0.62, by + 2)
        ctx.lineTo(bx + bw * 0.8, by - 56)
        ctx.lineTo(bx + bw * 0.78, by + 2)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
        roundRect(ctx, bx, by, bw, bh, 40)
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = '#3d4a3a'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        f.lines.forEach((l, i) => ctx.fillText(l, bx + 35, by + 22 + (i + 1) * f.size * 1.2))
      }
      const t = titleBlock(ctx, title, {
        y: copy.subtitle ? H - 205 : H - 170,
        bottom: true,
        maxWidth: W * 0.82,
        maxSize: 140,
        minSize: 56,
        maxLines: 2,
        family: font.title,
        weight: font.weight,
        paint: (line, x, y, size) => {
          ctx.lineJoin = 'round'
          ctx.lineWidth = size * 0.22
          ctx.strokeStyle = '#3d4a3a'
          ctx.strokeText(line, x, y)
          ctx.fillStyle = '#c9ecb8'
          ctx.fillText(line, x, y)
        },
      })
      result = t
      ctx.textAlign = 'center'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = '#f4efdc'
      if (copy.subtitle) {
        setFont(ctx, '700', 34, font.sub)
        ctx.lineWidth = 10
        ctx.strokeText(copy.subtitle, W / 2, H - 140)
        ctx.fillStyle = '#3d4a3a'
        ctx.fillText(copy.subtitle, W / 2, H - 140)
      }
      setFont(ctx, '700', 30, font.sub)
      ctx.lineWidth = 10
      ctx.strokeText('ぜんぜん近日公開', W / 2, H - 90)
      ctx.fillStyle = '#3d4a3a'
      ctx.fillText('ぜんぜん近日公開', W / 2, H - 90)
      break
    }
    case 'chaosClown': {
      ctx.save()
      ctx.translate(W / 2, 0)
      ctx.rotate(-0.04)
      ctx.translate(-W / 2, 0)
      simple(font.tagline, '800', 46, '#ff2b4a', copy.tagline, 130, 2)
      const t = titleBlock(ctx, title.toUpperCase(), {
        y: titleBottom(copy.subtitle, 38),
        bottom: true,
        maxWidth: W * 0.9,
        maxSize: 200,
        minSize: 70,
        maxLines: 2,
        family: font.title,
        weight: font.weight,
        spacing: 4,
        paint: (line, x, y) => {
          // 紫の影 → 緑の本体 → ずれた白の筋
          ctx.fillStyle = 'rgba(120, 30, 170, 0.9)'
          ctx.fillText(line, x + 10, y + 10)
          ctx.fillStyle = '#5fe14a'
          ctx.fillText(line, x, y)
          ctx.save()
          ctx.globalAlpha = 0.35
          ctx.fillStyle = '#ffffff'
          ctx.fillText(line, x - 6 + (rand() - 0.5) * 6, y - 4)
          ctx.restore()
        },
      })
      result = t
      ctx.restore()
      simple(font.sub, '700', 38, '#d6b6ff', copy.subtitle, SUB_BASELINE, 6)
      billing(ctx, W, H, 'rgba(210, 255, 200, 0.7)', 'COMING SOON')
      break
    }
    case 'gentlemanChef': {
      simple(font.tagline, '600', 44, '#f6e7c1', copy.tagline, 140, 4)
      const t = titleBlock(ctx, title, {
        y: titleBottom(copy.subtitle, 56),
        bottom: true,
        maxWidth: W * 0.84,
        maxSize: 140,
        minSize: 56,
        maxLines: 2,
        family: font.title,
        weight: font.weight,
        spacing: 6,
        paint: (line, x, y, size) => {
          const g = ctx.createLinearGradient(0, y - size, 0, y)
          g.addColorStop(0, '#fff3cf')
          g.addColorStop(1, '#d4a04c')
          ctx.shadowColor = 'rgba(0, 0, 0, 0.7)'
          ctx.shadowBlur = 16
          ctx.fillStyle = g
          ctx.fillText(line, x, y)
          ctx.shadowBlur = 0
        },
      })
      result = t
      simple(font.sub, '400', 56, '#f1d391', copy.subtitle, SUB_BASELINE, 0)
      billing(ctx, W, H, 'rgba(240, 220, 180, 0.75)', 'COMING SOON')
      break
    }
  }
  ctx.restore()
  return result
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}
