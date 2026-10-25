/**
 * STEP 9：写真撮影（AR 合成）。表示と保存で同じ座標変換を使い、元映像 → フィルター → 周辺減光 → AR（タバコ・炎・煙）の順に合成する。
 *
 * 表示の構成（PenTracker）：
 *   映像の canvas（ミラー後の元映像。CSS の filter で色調を変える）
 *   周辺減光（CSS のグラデーション）
 *   AR の canvas（タバコ CG・ライター・炎・煙・認識枠。透明な背景）
 * 写真は、同じ順番で 1 枚の canvas に描く（composePhoto）。
 */
import { applyFilter, drawVignette, type FilterId } from './photoFilters'

/** 映像を出力の大きさに描くときの変換（ミラーなら左右反転）。表示と保存で共通 */
export function videoTransform(width: number, mirror: boolean): [number, number, number, number, number, number] {
  return mirror ? [-1, 0, 0, 1, width, 0] : [1, 0, 0, 1, 0, 0]
}

/** 映像（ミラー適用）を ctx の (0, 0)〜(width, height) に描く */
export function drawVideoFrame(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number,
  mirror: boolean,
): void {
  ctx.save()
  ctx.setTransform(...videoTransform(width, mirror))
  ctx.drawImage(source, 0, 0, width, height)
  ctx.restore()
}

/** 写真の大きさ：映像の解像度（長い辺は maxSide まで）。縦横比は映像と同じ */
export function photoSize(videoWidth: number, videoHeight: number, maxSide: number): { width: number; height: number } {
  const s = Math.min(1, maxSide / Math.max(videoWidth, videoHeight))
  return { width: Math.round(videoWidth * s), height: Math.round(videoHeight * s) }
}

export type ComposeInput = {
  /** 元映像（video 要素）。撮影時点のフレームを使う */
  video: HTMLVideoElement
  /** AR の canvas（処理解像度。写真の大きさに拡大して重ねる） */
  overlay: HTMLCanvasElement | null
  mirror: boolean
  filter: FilterId
  /** 写真の長い辺の上限 px */
  maxSide?: number
  /** テスト用：canvas を作る関数 */
  createCanvas?: (w: number, h: number) => HTMLCanvasElement
}

/** 合成の手順（テストで順番を確かめるための記録） */
export type ComposeStep = 'video' | 'filter' | 'vignette' | 'overlay'

/**
 * 撮影：映像と AR を 1 枚に合成した canvas を返す。呼び出し側は blob にした後、canvas の大きさを 0 にしてメモリを解放する。
 */
export function composePhoto(input: ComposeInput, steps: ComposeStep[] = []): HTMLCanvasElement {
  const { video, overlay, mirror, filter } = input
  const { width, height } = photoSize(video.videoWidth, video.videoHeight, input.maxSide ?? 1920)
  if (width === 0 || height === 0) throw new Error('カメラの映像がありません')
  const canvas = input.createCanvas ? input.createCanvas(width, height) : document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('写真を作れません（Canvas が使えません）')
  // 1. 元映像（表示と同じミラー）
  drawVideoFrame(ctx, video, width, height, mirror)
  steps.push('video')
  // 2. フィルター（表示の CSS の filter と同じ式を画素にかける）
  if (filter !== 'normal') {
    const img = ctx.getImageData(0, 0, width, height)
    applyFilter(img.data, filter)
    ctx.putImageData(img, 0, 0)
    steps.push('filter')
  }
  // 3. 周辺減光
  drawVignette(ctx, width, height, filter)
  steps.push('vignette')
  // 4. AR（タバコ CG・炎・煙）：表示と同じく、フィルターの上に重ねる。AR の canvas は映像と同じ縦横比なので、拡大するだけで位置が合う
  if (overlay && overlay.width > 0 && overlay.height > 0) {
    ctx.drawImage(overlay, 0, 0, width, height)
    steps.push('overlay')
  }
  return canvas
}

/** canvas を JPEG にする */
export function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('写真を JPEG にできませんでした'))), 'image/jpeg', quality)
  })
}

/** 撮影した写真のファイル名（シブガレット_年月日_時分秒.jpg） */
export function photoFileName(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `shibugarette_${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.jpg`
}

/** STEP 14：映画ポスターのファイル名（shibugarette_poster_年月日_時分秒.jpg） */
export function posterFileName(date = new Date()): string {
  return photoFileName(date).replace('shibugarette_', 'shibugarette_poster_')
}
