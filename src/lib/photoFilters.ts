/**
 * STEP 9：渋い背景フィルター（カメラ映像の色調）。
 *
 * - 表示：映像だけを描いた canvas に CSS の filter をかける（GPU で処理され、毎フレームの JavaScript の処理が増えない）。
 *   タバコ CG・炎・煙は別の canvas（上に重ねる）に描くので、フィルターはかからない。
 * - OpenCV のペン認識：映像の canvas の画素（getImageData）は CSS の filter の影響を受けないので、フィルター前の元映像を解析する。
 * - 写真：同じパラメータから作った色の行列を画素に直接かける（applyFilter）。CSS の filter と同じ式（W3C Filter Effects）。
 * - 周辺減光（ビネット）も、表示は CSS のグラデーション、写真は同じ値の Canvas のグラデーション。
 */
export type FilterId = 'normal' | 'sepia' | 'noir' | 'vintage'

type FilterOp =
  | { kind: 'sepia'; amount: number }
  | { kind: 'grayscale'; amount: number }
  | { kind: 'saturate'; amount: number }
  | { kind: 'contrast'; amount: number }
  | { kind: 'brightness'; amount: number }

export type FilterDef = {
  label: string
  /** CSS の filter と、画素にかける色の変換の元になるパラメータ（この順にかける） */
  ops: FilterOp[]
  /** 周辺減光の強さ（四隅の黒の不透明度、0 = なし） */
  vignette: number
}

export const FILTERS: Record<FilterId, FilterDef> = {
  normal: { label: 'Normal', ops: [], vignette: 0 },
  sepia: {
    label: 'Sepia',
    ops: [
      { kind: 'sepia', amount: 0.85 },
      { kind: 'contrast', amount: 1.08 },
      { kind: 'brightness', amount: 0.95 },
    ],
    vignette: 0.35,
  },
  noir: {
    label: 'Noir',
    ops: [
      { kind: 'grayscale', amount: 1 },
      { kind: 'contrast', amount: 1.55 },
      { kind: 'brightness', amount: 0.9 },
    ],
    vignette: 0.55,
  },
  vintage: {
    label: 'Vintage',
    ops: [
      { kind: 'saturate', amount: 0.55 },
      { kind: 'sepia', amount: 0.3 },
      { kind: 'contrast', amount: 0.9 },
      { kind: 'brightness', amount: 1.05 },
    ],
    vignette: 0.4,
  },
}

export const FILTER_IDS = Object.keys(FILTERS) as FilterId[]

/** 表示用の CSS の filter の値 */
export function cssFilter(id: FilterId): string {
  const ops = FILTERS[id].ops
  return ops.length ? ops.map((o) => `${o.kind}(${o.amount})`).join(' ') : 'none'
}

/** ビネットの範囲：中心からこの割合までは暗くしない */
export const VIGNETTE_INNER = 0.55

/** 表示用の周辺減光（CSS のグラデーション）。強さ 0 なら null */
export function vignetteCss(id: FilterId): string | null {
  const v = FILTERS[id].vignette
  return v > 0
    ? `radial-gradient(ellipse at center, rgba(0, 0, 0, 0) ${VIGNETTE_INNER * 100}%, rgba(0, 0, 0, ${v}) 100%)`
    : null
}

/** 3×3 の色の行列（行優先）と、加算する定数 */
type Affine = { m: number[]; b: number[] }

const IDENTITY: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], b: [0, 0, 0] }

/** W3C Filter Effects の各関数の行列（値は 0〜1 の sRGB） */
function opAffine(op: FilterOp): Affine {
  const a = op.amount
  switch (op.kind) {
    case 'grayscale': {
      const g = 1 - Math.min(Math.max(a, 0), 1)
      return {
        m: [
          0.2126 + 0.7874 * g, 0.7152 - 0.7152 * g, 0.0722 - 0.0722 * g,
          0.2126 - 0.2126 * g, 0.7152 + 0.2848 * g, 0.0722 - 0.0722 * g,
          0.2126 - 0.2126 * g, 0.7152 - 0.7152 * g, 0.0722 + 0.9278 * g,
        ],
        b: [0, 0, 0],
      }
    }
    case 'sepia': {
      const g = 1 - Math.min(Math.max(a, 0), 1)
      return {
        m: [
          0.393 + 0.607 * g, 0.769 - 0.769 * g, 0.189 - 0.189 * g,
          0.349 - 0.349 * g, 0.686 + 0.314 * g, 0.168 - 0.168 * g,
          0.272 - 0.272 * g, 0.534 - 0.534 * g, 0.131 + 0.869 * g,
        ],
        b: [0, 0, 0],
      }
    }
    case 'saturate':
      return {
        m: [
          0.213 + 0.787 * a, 0.715 - 0.715 * a, 0.072 - 0.072 * a,
          0.213 - 0.213 * a, 0.715 + 0.285 * a, 0.072 - 0.072 * a,
          0.213 - 0.213 * a, 0.715 - 0.715 * a, 0.072 + 0.928 * a,
        ],
        b: [0, 0, 0],
      }
    case 'contrast':
      return { m: [a, 0, 0, 0, a, 0, 0, 0, a], b: [0.5 - 0.5 * a, 0.5 - 0.5 * a, 0.5 - 0.5 * a] }
    case 'brightness':
      return { m: [a, 0, 0, 0, a, 0, 0, 0, a], b: [0, 0, 0] }
  }
}

/** 後からかける変換 q を、先にかけた p の後ろにつなぐ（q ∘ p） */
function compose(q: Affine, p: Affine): Affine {
  const m = new Array(9).fill(0)
  const b = [0, 0, 0]
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < 3; k++) m[r * 3 + c] += q.m[r * 3 + k] * p.m[k * 3 + c]
    }
    b[r] = q.b[r] + q.m[r * 3] * p.b[0] + q.m[r * 3 + 1] * p.b[1] + q.m[r * 3 + 2] * p.b[2]
  }
  return { m, b }
}

/** フィルターの色の変換を 1 つの行列にまとめる（1 画素あたり 1 回の計算で済む） */
export function filterAffine(id: FilterId): Affine {
  return FILTERS[id].ops.reduce((acc, op) => compose(opAffine(op), acc), IDENTITY)
}

/**
 * RGBA の画素にフィルターの色の変換をかける（写真用。その場で書き換える）。
 * 途中の各関数の結果を 0〜1 に丸めず、最後にまとめて丸める（ブラウザの CSS の filter と、極端な色でわずかに違うことがある）。
 */
export function applyFilter(data: Uint8ClampedArray, id: FilterId): void {
  if (FILTERS[id].ops.length === 0) return
  const { m, b } = filterAffine(id)
  const b0 = b[0] * 255
  const b1 = b[1] * 255
  const b2 = b[2] * 255
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const bl = data[i + 2]
    // Uint8ClampedArray なので、代入で 0〜255 に丸められる
    data[i] = m[0] * r + m[1] * g + m[2] * bl + b0
    data[i + 1] = m[3] * r + m[4] * g + m[5] * bl + b1
    data[i + 2] = m[6] * r + m[7] * g + m[8] * bl + b2
  }
}

/** 写真用の周辺減光（表示の CSS と同じ範囲・強さ） */
export function drawVignette(ctx: CanvasRenderingContext2D, width: number, height: number, id: FilterId): void {
  const v = FILTERS[id].vignette
  if (v <= 0) return
  ctx.save()
  // 楕円のグラデーション：横に引き伸ばした円で描く（CSS の ellipse at center と同じく、四隅まで届く大きさ）
  ctx.translate(width / 2, height / 2)
  ctx.scale(width / Math.SQRT2, height / Math.SQRT2)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
  g.addColorStop(VIGNETTE_INNER, 'rgba(0, 0, 0, 0)')
  g.addColorStop(1, `rgba(0, 0, 0, ${v})`)
  ctx.fillStyle = g
  ctx.fillRect(-Math.SQRT2, -Math.SQRT2, 2 * Math.SQRT2, 2 * Math.SQRT2)
  ctx.restore()
}
