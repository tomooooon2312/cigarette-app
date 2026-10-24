import type { HsvRange } from './penDetector'
import type { Point2 } from './penGeometry'

/**
 * STEP 6：認識するペンの色。
 * HSV は OpenCV の値域（H: 0-179、S/V: 0-255）。hMin > hMax のときは色相の折り返し（赤など）として扱う。
 */
export type PenColor = {
  id: string
  name: string
  hsv: HsvRange
  /** 表示用の色（CSS） */
  swatch: string
  /** 組み込みの色（削除できない。範囲の編集はできる） */
  builtin: boolean
  /** 全色同時認識のときに使うか */
  enabled: boolean
  /**
   * 彩度の低い色（黒・白・グレー）。色相で区別できないため、明度・彩度の範囲と、より厳しい形状判定で検出する。
   * 精度は不十分で、**未対応（実験的）**として扱う。
   */
  achromatic: boolean
}

export type ColorMode = 'single' | 'all'

export type ColorSettings = {
  /** single：選択中の 1 色だけ認識 / all：有効な全色を同時に認識 */
  mode: ColorMode
  /** single モードで認識する色・HSV スライダーで編集する色 */
  selectedId: string
  colors: PenColor[]
}

/** 彩度の低い色の追加の形状スコアの下限（色だけでは背景と区別しにくいため） */
export const ACHROMATIC_SCORE_PENALTY = 0.2

/**
 * 組み込みの 4 色。ピンクは STEP 1 からの既定値（DEFAULT_SETTINGS）と同じ範囲。
 * 赤は色相 0/179 をまたぐ（172〜179 と 0〜8）。ピンクの上端（175）と重なる 172〜175 は、
 * 両方の色で検出されたときに重複除去（penDetector）でどちらか 1 本にまとめる。
 */
export const BUILTIN_COLORS: PenColor[] = [
  {
    id: 'pink',
    name: 'ピンク',
    hsv: { hMin: 140, hMax: 175, sMin: 70, sMax: 255, vMin: 70, vMax: 255 },
    swatch: '#ff4fb0',
    builtin: true,
    enabled: true,
    achromatic: false,
  },
  {
    id: 'blue',
    name: '青',
    hsv: { hMin: 100, hMax: 128, sMin: 110, sMax: 255, vMin: 50, vMax: 255 },
    swatch: '#2f6bff',
    builtin: true,
    enabled: true,
    achromatic: false,
  },
  {
    id: 'green',
    name: '緑',
    hsv: { hMin: 40, hMax: 85, sMin: 90, sMax: 255, vMin: 50, vMax: 255 },
    swatch: '#22c55e',
    builtin: true,
    enabled: true,
    achromatic: false,
  },
  {
    id: 'red',
    name: '赤',
    hsv: { hMin: 172, hMax: 8, sMin: 130, sMax: 255, vMin: 70, vMax: 255 },
    swatch: '#ef2b2b',
    builtin: true,
    enabled: true,
    achromatic: false,
  },
]

export const DEFAULT_COLOR_SETTINGS: ColorSettings = {
  // 既定は従来どおりピンク 1 色（STEP 5 までと同じ検出結果）
  mode: 'single',
  selectedId: 'pink',
  colors: BUILTIN_COLORS,
}

/** 認識に使う色（single なら選択中の 1 色、all なら有効な全色） */
export function activeColors(s: ColorSettings): PenColor[] {
  if (s.mode === 'single') {
    const c = s.colors.find((x) => x.id === s.selectedId) ?? s.colors[0]
    return c ? [c] : []
  }
  return s.colors.filter((c) => c.enabled)
}

/** RGB（0-255）→ OpenCV の HSV（H: 0-179、S/V: 0-255）。cv.COLOR_RGB2HSV と同じ定義 */
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = (60 * (g - b)) / d
    else if (max === g) h = 120 + (60 * (b - r)) / d
    else h = 240 + (60 * (r - g)) / d
    if (h < 0) h += 360
  }
  return { h: Math.round(h / 2) % 180, s: max === 0 ? 0 : Math.round((255 * d) / max), v: max }
}

/** OpenCV の HSV → CSS の色（表示用） */
export function hsvToCss(h: number, s: number, v: number): string {
  return `hsl(${h * 2}deg ${Math.round((s / 255) * 90)}% ${Math.round(20 + (v / 255) * 40)}%)`
}

const median = (xs: number[]) => {
  const a = [...xs].sort((p, q) => p - q)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}
/** 色相（0-179 の円周）の差 -90〜90 */
const hueDiff = (a: number, b: number) => ((((a - b) % 180) + 270) % 180) - 90

export type ColorEstimate = {
  /** 周辺画素の中央値 */
  h: number
  s: number
  v: number
  /** 中央値まわりのばらつき（中央絶対偏差） */
  spreadH: number
  /** 推定した検出範囲（編集して使う） */
  range: HsvRange
  /** 彩度が低く、色相では区別できない（黒・白・グレー） */
  achromatic: boolean
  /** 使った画素数 */
  samples: number
}

/** 彩度がこれ未満の色は「彩度の低い色」とみなす */
export const ACHROMATIC_S_MAX = 50

/**
 * タップ位置 (x, y) のまわり（半径 radius px）の画素から色を推定する。
 * - 色相は円周上の値なので、円周平均を基準に回転してから中央値を取る（赤の 0/179 またぎに対応）。
 * - 範囲は 中央値 ± ばらつき（中央絶対偏差）の数倍。色相 ±8 以上、彩度・明度の下限は低めに取る（影・照明の変化）。
 * - 彩度の中央値が 50 未満なら彩度の低い色とし、色相を全域にして明度・彩度の範囲だけで検出する（実験的）。
 */
export function estimateColor(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  at: Point2,
  radius: number,
): ColorEstimate | null {
  const hs: number[] = []
  const ss: number[] = []
  const vs: number[] = []
  const r = Math.max(1, Math.round(radius))
  const cx = Math.round(at.x)
  const cy = Math.round(at.y)
  for (let y = cy - r; y <= cy + r; y++) {
    if (y < 0 || y >= height) continue
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || x >= width || (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue
      const i = (y * width + x) * 4
      const hsv = rgbToHsv(rgba[i], rgba[i + 1], rgba[i + 2])
      hs.push(hsv.h)
      ss.push(hsv.s)
      vs.push(hsv.v)
    }
  }
  if (hs.length === 0) return null

  // 彩度のある画素だけで色相の基準を決める（ハイライト・影の画素の色相は不安定）
  const chromatic = hs.filter((_, i) => ss[i] >= ACHROMATIC_S_MAX)
  const hueSet = chromatic.length >= hs.length * 0.3 ? chromatic : hs
  let sx = 0
  let sy = 0
  for (const h of hueSet) {
    sx += Math.cos((h / 180) * 2 * Math.PI)
    sy += Math.sin((h / 180) * 2 * Math.PI)
  }
  const mean = ((Math.atan2(sy, sx) / (2 * Math.PI)) * 180 + 180) % 180
  const offsets = hueSet.map((h) => hueDiff(h, mean))
  const h = Math.round((mean + median(offsets) + 180) % 180)
  const spreadH = median(hueSet.map((x) => Math.abs(hueDiff(x, h))))
  const s = Math.round(median(ss))
  const v = Math.round(median(vs))
  const madS = median(ss.map((x) => Math.abs(x - s)))
  const madV = median(vs.map((x) => Math.abs(x - v)))
  const clamp = (x: number, lo: number, hi: number) => Math.round(Math.min(Math.max(x, lo), hi))

  const achromatic = s < ACHROMATIC_S_MAX
  if (achromatic) {
    return {
      h,
      s,
      v,
      spreadH,
      samples: hs.length,
      achromatic,
      range: {
        hMin: 0,
        hMax: 179,
        sMin: 0,
        sMax: clamp(s + 3 * madS + 30, 30, 255),
        vMin: clamp(v - 3 * madV - 40, 0, 255),
        vMax: clamp(v + 3 * madV + 40, 0, 255),
      },
    }
  }
  const dh = clamp(3 * spreadH + 4, 8, 25)
  return {
    h,
    s,
    v,
    spreadH,
    samples: hs.length,
    achromatic,
    range: {
      hMin: (h - dh + 180) % 180,
      hMax: (h + dh) % 180,
      sMin: clamp(s - 3 * madS - 40, 40, 255),
      sMax: 255,
      vMin: clamp(v - 3 * madV - 60, 30, 255),
      vMax: 255,
    },
  }
}

/** 表示された canvas（object-fit: contain）上のクライアント座標 → canvas の画素座標。余白なら null */
export function clientToCanvas(
  client: Point2,
  rect: { left: number; top: number; width: number; height: number },
  canvas: { width: number; height: number },
): Point2 | null {
  if (canvas.width === 0 || canvas.height === 0) return null
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height)
  const ox = (rect.width - canvas.width * scale) / 2
  const oy = (rect.height - canvas.height * scale) / 2
  const x = (client.x - rect.left - ox) / scale
  const y = (client.y - rect.top - oy) / scale
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null
  return { x, y }
}

/** ブラウザ内の保存キー */
export const COLOR_STORAGE_KEY = 'cigarette-app.penColors.v1'

const isRange = (r: unknown): r is HsvRange => {
  if (!r || typeof r !== 'object') return false
  const o = r as Record<string, unknown>
  return ['hMin', 'hMax', 'sMin', 'sMax', 'vMin', 'vMax'].every(
    (k) => typeof o[k] === 'number' && Number.isFinite(o[k]) && (o[k] as number) >= 0 && (o[k] as number) <= 255,
  )
}

/** 保存した設定を読み込む。壊れている・無い場合は既定値。組み込みの色は必ず含める */
export function parseColorSettings(json: string | null): ColorSettings {
  if (!json) return DEFAULT_COLOR_SETTINGS
  try {
    const raw = JSON.parse(json) as Partial<ColorSettings>
    const saved = Array.isArray(raw.colors) ? raw.colors : []
    const colors: PenColor[] = BUILTIN_COLORS.map((b) => {
      const o = saved.find((c) => c && c.id === b.id)
      return o && isRange(o.hsv) ? { ...b, hsv: o.hsv, enabled: o.enabled !== false } : b
    })
    for (const c of saved) {
      if (!c || typeof c.id !== 'string' || !c.id.startsWith('custom-') || !isRange(c.hsv)) continue
      if (colors.some((x) => x.id === c.id)) continue
      colors.push({
        id: c.id,
        name: typeof c.name === 'string' && c.name.trim() ? c.name.slice(0, 20) : 'カスタム',
        hsv: c.hsv,
        swatch: typeof c.swatch === 'string' ? c.swatch : '#999',
        builtin: false,
        enabled: c.enabled !== false,
        achromatic: c.achromatic === true,
      })
    }
    const mode: ColorMode = raw.mode === 'all' ? 'all' : 'single'
    const selectedId = colors.some((c) => c.id === raw.selectedId) ? raw.selectedId! : 'pink'
    return { mode, selectedId, colors }
  } catch {
    return DEFAULT_COLOR_SETTINGS
  }
}

export function loadColorSettings(): ColorSettings {
  try {
    return parseColorSettings(localStorage.getItem(COLOR_STORAGE_KEY))
  } catch {
    // プライベートブラウズなどで localStorage が使えない
    return DEFAULT_COLOR_SETTINGS
  }
}

export function saveColorSettings(s: ColorSettings): void {
  try {
    localStorage.setItem(COLOR_STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* 保存できない環境では、このセッションの間だけ有効 */
  }
}
