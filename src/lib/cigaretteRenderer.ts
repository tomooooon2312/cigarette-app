import { BURN_MAX_FRACTION } from './cigaretteLife'
import type { Point2 } from './penGeometry'
import type { TrackedPen } from './penTracking'

/** STEP 6：変換先の CG の種類 */
export type CgKind = 'cigarette' | 'cigar' | 'pipe'
/** CG の選び方（auto はペンの形の比率から選ぶ） */
export type CgChoice = CgKind | 'auto'

export const CG_LABELS: Record<CgChoice, string> = {
  cigarette: 'タバコ',
  cigar: '葉巻',
  pipe: 'パイプ',
  auto: '自動',
}

export type CigaretteSettings = {
  /** 全体の拡大率（ペンの全長・太さに対する倍率） */
  scale: number
  /** 太さの追加倍率。ペンより少し太くすると下のペンを覆いやすい（完全には消えない） */
  thicknessRatio: number
  /** 軸方向の位置オフセット（ペン全長に対する比率、+ は火側） */
  axialOffset: number
  /** 軸と垂直方向の位置オフセット（ペンの太さに対する比率） */
  perpOffset: number
  /** 火の向きを反転する（自動補正 ON のときは、自動で決めた向きをさらに反転する） */
  flipped: boolean
  /** 唇の中心に近い端をフィルター側にする（MediaPipe の口元検出を使う） */
  autoOrient: boolean
  /** 分断のすき間（指がある位置）では CG を切り抜き、指を CG の手前に見せる */
  fingerOcclusion: boolean
  /** STEP 6：CG の種類（ペンの色とは独立した設定） */
  kind: CgChoice
}

export const DEFAULT_CIGARETTE: CigaretteSettings = {
  scale: 1,
  thicknessRatio: 1.15,
  axialOffset: 0,
  perpOffset: 0,
  flipped: false,
  autoOrient: true,
  fingerOcclusion: true,
  kind: 'cigarette',
}

/** 葉巻の太さ（タバコに対する倍率） */
export const CIGAR_THICKNESS = 1.8
/** パイプの柄の太さ（タバコに対する倍率）。細くすると下のペンが見えるので、タバコと同じ太さにする */
export const PIPE_STEM_THICKNESS = 1

/**
 * 自動選択のしきい値（ペンの 全長 / 太さ）。細長い → タバコ、太め → 葉巻、短く太い → パイプ。
 * しきい値の前後 ±AUTO_HYSTERESIS では直前の種類を保つ（ちらつき防止）。
 */
export const AUTO_CG_THRESHOLDS = { cigar: 9, pipe: 5.5 } as const
export const AUTO_CG_HYSTERESIS = 0.7

/** 自動選択：縦横比から CG の種類を選ぶ（prev があれば、しきい値付近では prev を保つ） */
export function chooseCgKind(aspect: number, prev: CgKind | null = null): CgKind {
  const raw: CgKind = aspect >= AUTO_CG_THRESHOLDS.cigar ? 'cigarette' : aspect >= AUTO_CG_THRESHOLDS.pipe ? 'cigar' : 'pipe'
  if (!prev || prev === raw) return raw
  const h = AUTO_CG_HYSTERESIS
  const near = [AUTO_CG_THRESHOLDS.cigar, AUTO_CG_THRESHOLDS.pipe].some((t) => Math.abs(aspect - t) < h)
  return near ? prev : raw
}

/** スプライトの解像度（全長:太さ ≒ 10:1。描画時にペンの寸法へ引き伸ばす） */
const SPRITE_WIDTH = 640
const SPRITE_HEIGHT = 64
/** スプライト内の各部の位置（全長に対する比率、左端=吸い口） */
const FILTER_END = 0.27
const ASH_START = 0.93
/** 見失い中にフェードアウトする時間 ms と最低不透明度 */
const HELD_FADE_MS = 300
const HELD_MIN_ALPHA = 0.25
/** 指の切り抜きを、見失い・単独輪郭になってからも維持する時間 ms */
const OCCLUSION_MEMORY_MS = 300

type Gap = { from: number; to: number }

/** STEP 10：葉巻の吸い口側の帯の端（全長に対する比率）。燃え進む範囲の基準 */
const CIGAR_BAND_END = 0.26

/**
 * STEP 10：燃え進んだ割合（0〜1）から、燃え進んだ位置を求める（吸い口 0 → 火側 1 の比率）。パイプは変わらない。
 * STEP 11：CG の全長は短くしない。この位置より火側は透明にせず、焦げた色の CG で覆う（burnLayout）。
 */
export function burnRingFraction(kind: CgKind, progress: number): number {
  if (kind === 'pipe') return 1
  const base = kind === 'cigar' ? CIGAR_BAND_END : FILTER_END
  return 1 - Math.min(Math.max(progress, 0), 1) * BURN_MAX_FRACTION * (1 - base)
}

/**
 * STEP 11：燃え具合の見た目の配置（吸い口 0 → 火側 1 の比率）。CG 本体は燃焼状態によらず常に 0〜1 を不透明に覆い、
 * 燃え進んだ部分は焦げた色で上書きするだけ（ペンが見える透明な隙間を作らない）。灰は本体の外側（1 より先）に足す。
 *   baseLength（CG の全長）= ペンの検出結果 × 拡大率（placeCigarette）。burnProgress・appearanceState では変えない
 *   burnProgress = look.progress、appearanceState = NEW / BURNING / BUTT、ashLength = look.ash（外側）
 */
export type BurnLayout = {
  /** CG 本体の範囲。常に 0〜1 */
  bodyFrom: number
  bodyTo: number
  /** 焦げた色で覆う範囲の始まり（〜1）。焦げが無ければ 1 */
  charFrom: number
  /** 焦げの濃さ 0〜1（シケモクは 1） */
  charLevel: number
  /** 火側の端の灰の固まり（本体の内側、焦げの上に描く。シケモクで灰の質感を強調する）の長さ */
  crust: number
  /** 本体の外側に描く灰の長さ（全長に対する比率） */
  ashOutside: number
  /** 燃えている先端（赤い光）を描く */
  ember: boolean
}

/** STEP 11：シケモクの、本体の外側に必ず残す灰の長さ（全長に対する比率） */
export const BUTT_ASH_MIN = 0.03
/** STEP 11：シケモクの火側の端の灰の固まり（本体の内側。全長に対する比率） */
export const BUTT_CRUST = 0.07

export function burnLayout(kind: CgKind, look: CigaretteLook, lit: boolean): BurnLayout {
  if (kind === 'pipe') return { bodyFrom: 0, bodyTo: 1, charFrom: 1, charLevel: 0, crust: 0, ashOutside: 0, ember: lit && !look.butt }
  const paperFrom = kind === 'cigar' ? CIGAR_BAND_END : FILTER_END
  if (look.butt) {
    // シケモク：フィルター（葉巻は帯）より火側の巻紙をすべて焦げ茶〜黒にする
    return { bodyFrom: 0, bodyTo: 1, charFrom: paperFrom, charLevel: 1, crust: BUTT_CRUST, ashOutside: Math.max(look.ash, BUTT_ASH_MIN), ember: false }
  }
  const p = Math.min(Math.max(look.progress, 0), 1)
  const ring = burnRingFraction(kind, p)
  return {
    bodyFrom: 0,
    bodyTo: 1,
    // 燃え始め（progress 0）でも、燃えている先端の少し手前から焦げを付ける
    charFrom: lit || p > 0 ? Math.min(ring, 1 - CHAR_MIN) : 1,
    charLevel: 0.45 + 0.55 * p,
    crust: 0,
    ashOutside: Math.max(look.ash, 0),
    ember: lit,
  }
}

/** STEP 11：燃えている・燃えたタバコの、焦げの最小の長さ（全長に対する比率） */
const CHAR_MIN = 0.04

/** STEP 10：タバコの燃え具合の見た目 */
export type CigaretteLook = {
  /** 燃え進んだ割合 0〜1 */
  progress: number
  /** 灰の長さ（全長に対する比率） */
  ash: number
  /** 灰を落とした直後の燃焼部分の光 0〜1 */
  flash: number
  /** シケモク */
  butt: boolean
}

/** 画面上でのタバコ CG の配置 */
export type CigarettePlacement = {
  center: Point2
  /** 吸い口 → 火 の単位ベクトル */
  dir: Point2
  length: number
  thickness: number
  /** 吸い口側の端（口にくわえる側） */
  mouthEnd: Point2
  /** 火側の端（パイプはボウル（火皿）の開口部の中心）。STEP 11：燃焼状態によらず CG の火側の端（灰は更にその外側） */
  emberEnd: Point2
  /** STEP 6：CG の種類 */
  kind: CgKind
  /** パイプのボウルが伸びる向き（画面の上側。パイプ以外は null） */
  bowlUp: Point2 | null
}

/**
 * ペンの検出結果と CG 設定から、タバコ CG の配置を求める（描画・口元判定・煙の発生位置で共用）。
 * emberDir（吸い口 → 火 の向き、自動補正の結果）を渡すとその向きに合わせ、無ければ endpoints[0] 側を吸い口にする。
 * STEP 11：全長・火側の端は燃焼状態（燃え進んだ割合・シケモク・灰）によらない（STEP 10 では燃えるほど短くしていた）。
 * ペンの映像上の長さが変われば、従来どおり CG も伸び縮みする。
 */
export function placeCigarette(
  pen: TrackedPen,
  s: CigaretteSettings,
  emberDir?: Point2 | null,
  kind: CgKind = 'cigarette',
): CigarettePlacement {
  // 追跡フィルタが endpoints の順序をフレーム間で揃えているので、火の向きが毎フレーム入れ替わらない
  const [e0, e1] = pen.endpoints
  const len = Math.hypot(e1.x - e0.x, e1.y - e0.y) || 1
  const u = { x: (e1.x - e0.x) / len, y: (e1.y - e0.y) / len }
  const n = { x: -u.y, y: u.x }
  const base = emberDir && emberDir.x * u.x + emberDir.y * u.y < 0 ? { x: -u.x, y: -u.y } : u
  const dir = s.flipped ? { x: -base.x, y: -base.y } : base
  const length = pen.length * s.scale
  const kindRatio = kind === 'cigar' ? CIGAR_THICKNESS : kind === 'pipe' ? PIPE_STEM_THICKNESS : 1
  const thickness = pen.thickness * s.thicknessRatio * s.scale * kindRatio
  const center = {
    x: pen.center.x + u.x * s.axialOffset * pen.length + n.x * s.perpOffset * pen.thickness,
    y: pen.center.y + u.y * s.axialOffset * pen.length + n.y * s.perpOffset * pen.thickness,
  }
  const half = length / 2
  const mouthEnd = { x: center.x - dir.x * half, y: center.y - dir.y * half }
  if (kind === 'pipe') {
    // ボウルは火側の端から、画面の上側へ立ち上がる。火（着火・煙）の位置はボウルの開口部
    const normal = { x: -dir.y, y: dir.x }
    const bowlUp = normal.y <= 0 ? normal : { x: -normal.x, y: -normal.y }
    const { bowlWidth, bowlHeight } = pipeBowl(length, thickness)
    const along = half - bowlWidth / 2
    return {
      center,
      dir,
      length,
      thickness,
      mouthEnd,
      emberEnd: {
        x: center.x + dir.x * along + bowlUp.x * bowlHeight,
        y: center.y + dir.y * along + bowlUp.y * bowlHeight,
      },
      kind,
      bowlUp,
    }
  }
  return {
    center,
    dir,
    length,
    thickness,
    mouthEnd,
    emberEnd: { x: center.x + dir.x * half, y: center.y + dir.y * half },
    kind,
    bowlUp: null,
  }
}

/** パイプのボウルの大きさ（柄の太さと全長から） */
export function pipeBowl(length: number, stemThickness: number): { bowlWidth: number; bowlHeight: number } {
  const bowlWidth = Math.max(stemThickness * 3, length * 0.16)
  return { bowlWidth, bowlHeight: bowlWidth * 1.15 }
}

/**
 * 検出したペンの位置・長さ・太さ・角度に合わせてタバコの CG を描く。
 * CG は透明背景のスプライト（Canvas で生成）を変形して描画する。
 */
export class CigaretteRenderer {
  /** 着火済み（灰と火）/ 未着火（葉の断面）のスプライト */
  private readonly litSprite: HTMLCanvasElement
  private readonly unlitSprite: HTMLCanvasElement
  /** STEP 6：葉巻のスプライト（初めて使うときに作る） */
  private cigarSprites: { lit: HTMLCanvasElement; unlit: HTMLCanvasElement } | null = null
  private readonly layer: HTMLCanvasElement
  /** 直近の分断すき間（ペン全長に対する -0.5〜0.5 の比率） */
  private gaps: Gap[] = []
  private gapsAt = -Infinity

  constructor() {
    this.litSprite = createCigaretteSprite(true)
    this.unlitSprite = createCigaretteSprite(false)
    this.layer = document.createElement('canvas')
  }

  draw(
    ctx: CanvasRenderingContext2D,
    pen: TrackedPen,
    s: CigaretteSettings,
    now: number,
    emberDir?: Point2 | null,
    lit = true,
    kind: CgKind = 'cigarette',
    look?: CigaretteLook,
  ): void {
    const { width, height } = ctx.canvas
    if (this.layer.width !== width || this.layer.height !== height) {
      this.layer.width = width
      this.layer.height = height
    }
    const layer = this.layer.getContext('2d')
    if (!layer) return
    layer.clearRect(0, 0, width, height)

    const placement = placeCigarette(pen, s, emberDir, kind)
    const { center, dir, length: cgLength, thickness: cgThickness } = placement
    const angle = Math.atan2(dir.y, dir.x)
    // 指の切り抜きは CG のオフセットではなく元のペンの軸を基準にする
    const [e0, e1] = pen.endpoints
    const len = Math.hypot(e1.x - e0.x, e1.y - e0.y) || 1
    const u = { x: (e1.x - e0.x) / len, y: (e1.y - e0.y) / len }
    const n = { x: -u.y, y: u.x }

    layer.save()
    layer.translate(center.x, center.y)
    layer.rotate(angle)
    if (kind === 'pipe') {
      // 回転後の座標で、ボウルが画面の上側に来る向き（-1 = ローカル座標の y の負の向き）
      const up = placement.bowlUp!
      const side = up.x * -dir.y + up.y * dir.x >= 0 ? 1 : -1
      drawPipe(layer, cgLength, cgThickness, side, lit && !look?.butt, now)
    } else if (look && (look.progress > 0 || look.butt || look.ash > 0 || lit)) {
      // STEP 10：燃え具合（STEP 11：全長はそのまま、焦げた巻紙・燃えている先端・外側の灰・シケモクの焦げ）
      let body = this.unlitSprite
      if (kind === 'cigar') {
        this.cigarSprites ??= { lit: createCigarSprite(true), unlit: createCigarSprite(false) }
        body = this.cigarSprites.unlit
      }
      drawBurning(layer, body, kind, cgLength, cgThickness, lit && !look.butt, look, now)
    } else {
      let sprite = lit ? this.litSprite : this.unlitSprite
      if (kind === 'cigar') {
        this.cigarSprites ??= { lit: createCigarSprite(true), unlit: createCigarSprite(false) }
        sprite = lit ? this.cigarSprites.lit : this.cigarSprites.unlit
      }
      layer.drawImage(sprite, -cgLength / 2, -cgThickness / 2, cgLength, cgThickness)
      if (lit) drawEmberGlow(layer, cgLength / 2, cgThickness, now)
    }
    layer.restore()

    if (s.fingerOcclusion) {
      this.updateGaps(pen, u, now)
      if (now - this.gapsAt <= OCCLUSION_MEMORY_MS) {
        cutOutGaps(layer, this.gaps, pen.center, u, n, pen.length, cgThickness)
      }
    }

    ctx.save()
    ctx.globalAlpha = fadeAlpha(pen)
    ctx.drawImage(this.layer, 0, 0)
    ctx.restore()
  }

  /** 結合された輪郭どうしのすき間を、ペンの軸上の比率として記録する */
  private updateGaps(pen: TrackedPen, u: Point2, now: number): void {
    // 見失い中・長さ補完中は直前のすき間を使い回す。分断が解消されて全体が見えたら即座に消す
    if (pen.status !== 'measured' || pen.lengthCompleted) return
    if (pen.segments.length < 2) {
      this.gaps = []
      return
    }
    const intervals = pen.segments
      .map((segment) => {
        const ts = segment.corners.map(
          (p) => ((p.x - pen.center.x) * u.x + (p.y - pen.center.y) * u.y) / pen.length,
        )
        return { from: Math.min(...ts), to: Math.max(...ts) }
      })
      .sort((a, b) => a.from - b.from)
    const gaps: Gap[] = []
    let reach = intervals[0].to
    for (const iv of intervals.slice(1)) {
      if (iv.from > reach) gaps.push({ from: reach, to: iv.from })
      reach = Math.max(reach, iv.to)
    }
    this.gaps = gaps
    this.gapsAt = now
  }
}

function fadeAlpha(pen: TrackedPen): number {
  if (pen.status !== 'held') return 1
  const t = Math.min(pen.sinceMeasuredMs / HELD_FADE_MS, 1)
  return 1 - (1 - HELD_MIN_ALPHA) * t
}

/**
 * すき間（＝指があると推定される位置）の CG を透明にする。
 * 指の輪郭を推定しているわけではなく、ピンク領域が途切れた区間を帯状に切り抜くだけの近似。
 */
function cutOutGaps(
  layer: CanvasRenderingContext2D,
  gaps: Gap[],
  center: Point2,
  u: Point2,
  n: Point2,
  length: number,
  cgThickness: number,
): void {
  if (gaps.length === 0) return
  const half = cgThickness * 1.5
  layer.save()
  layer.globalCompositeOperation = 'destination-out'
  for (const gap of gaps) {
    const a = { x: center.x + u.x * gap.from * length, y: center.y + u.y * gap.from * length }
    const b = { x: center.x + u.x * gap.to * length, y: center.y + u.y * gap.to * length }
    layer.beginPath()
    layer.moveTo(a.x + n.x * half, a.y + n.y * half)
    layer.lineTo(b.x + n.x * half, b.y + n.y * half)
    layer.lineTo(b.x - n.x * half, b.y - n.y * half)
    layer.lineTo(a.x - n.x * half, a.y - n.y * half)
    layer.closePath()
    layer.fill()
  }
  layer.restore()
}

/**
 * STEP 10：燃えているタバコ・葉巻（回転済みの座標。x：吸い口 −L/2 → 火側 +L/2）。
 * STEP 11：本体（未着火のスプライト）は常に全長を描き、燃え進んだ部分はその上に不透明な焦げの色を重ねる
 * （source-atop で本体の形の中だけに塗るので、本体からはみ出さず、透明にもならない）。
 * 着火中は火側の端に燃えている部分（赤い光）、その外側に灰の柱を描く。シケモクは巻紙全体が焦げ茶〜黒になり、先端に灰の固まりが残る。
 */
export function drawBurning(
  ctx: CanvasRenderingContext2D,
  body: CanvasImageSource & { width: number; height: number },
  kind: CgKind,
  length: number,
  thickness: number,
  lit: boolean,
  look: CigaretteLook,
  now: number,
) {
  const layout = burnLayout(kind, look, lit)
  const x0 = -length / 2
  const xEnd = x0 + length * layout.bodyTo
  // 本体（常に全長。燃焼状態で短くしない）
  ctx.drawImage(body, 0, 0, body.width, body.height, x0 + length * layout.bodyFrom, -thickness / 2, length * (layout.bodyTo - layout.bodyFrom), thickness)
  if (layout.charFrom < 1) {
    const cx = x0 + length * layout.charFrom
    const level = layout.charLevel
    ctx.save()
    ctx.globalCompositeOperation = 'source-atop'
    const g = ctx.createLinearGradient(cx, 0, xEnd, 0)
    // 焦げ：吸い口側は薄い焦げ茶、火側ほど黒い（不透明）
    g.addColorStop(0, mixColor([196, 160, 112], [92, 58, 34], level))
    g.addColorStop(0.12, mixColor([150, 104, 64], [70, 42, 24], level))
    g.addColorStop(0.7, mixColor([88, 56, 32], [40, 26, 16], level))
    g.addColorStop(1, mixColor([40, 26, 16], [14, 10, 8], level))
    ctx.fillStyle = g
    ctx.fillRect(cx, -thickness / 2, xEnd - cx, thickness)
    // 焦げの境目のぎざぎざ（巻紙が燃えた跡）
    ctx.fillStyle = mixColor([120, 82, 50], [60, 38, 22], level)
    ctx.beginPath()
    ctx.moveTo(cx + 0.5, -thickness / 2)
    for (let i = 0; i <= 6; i++) {
      const y = -thickness / 2 + (thickness * i) / 6
      ctx.lineTo(cx - thickness * (0.1 + 0.22 * Math.abs(Math.sin(i * 2.3 + 1.1))), y)
    }
    ctx.lineTo(cx + 0.5, thickness / 2)
    ctx.closePath()
    ctx.fill()
    // 円柱の陰影を焦げの上にも重ねる（平たく見えないように）
    const shade = ctx.createLinearGradient(0, -thickness / 2, 0, thickness / 2)
    shade.addColorStop(0, 'rgba(0, 0, 0, 0.3)')
    shade.addColorStop(0.3, 'rgba(255, 235, 210, 0.16)')
    shade.addColorStop(0.55, 'rgba(255, 255, 255, 0)')
    shade.addColorStop(1, 'rgba(0, 0, 0, 0.4)')
    ctx.fillStyle = shade
    ctx.fillRect(cx - thickness * 0.4, -thickness / 2, xEnd - cx + thickness * 0.4, thickness)
    if (layout.crust > 0) drawAshCrust(ctx, xEnd - length * layout.crust, length * layout.crust, thickness)
    ctx.restore()
  }
  const band = Math.max(thickness * 0.45, 2)
  if (layout.ember) {
    // 燃えている先端：本体の火側の端の内側を赤〜オレンジに光らせる
    const flash = look.flash
    ctx.save()
    ctx.globalCompositeOperation = 'source-atop'
    const g = ctx.createLinearGradient(xEnd - band * 1.3, 0, xEnd, 0)
    g.addColorStop(0, 'rgba(60, 30, 15, 0.9)')
    g.addColorStop(0.45, flash > 0 ? '#ff7a2a' : '#c8401a')
    g.addColorStop(1, flash > 0 ? '#ffd27a' : '#ff8a3d')
    ctx.fillStyle = g
    ctx.fillRect(xEnd - band * 1.3, -thickness / 2, band * 1.3, thickness)
    ctx.restore()
  }
  // 灰の柱（本体の外側。灰の長さは本体の全長と独立）
  const ashLen = layout.ashOutside * length
  if (ashLen > 0.5) drawAshColumn(ctx, xEnd - band * 0.1, ashLen, thickness)
  if (layout.ember) drawEmberGlow(ctx, xEnd, thickness, now, 1 + look.flash * 1.6)
}

/** STEP 11：シケモクの先端の灰の固まり（本体の内側。灰色のまだら） */
function drawAshCrust(ctx: CanvasRenderingContext2D, x: number, len: number, thickness: number) {
  const g = ctx.createLinearGradient(x, 0, x + len, 0)
  g.addColorStop(0, 'rgba(70, 64, 58, 0)')
  g.addColorStop(0.35, 'rgba(120, 114, 106, 0.85)')
  g.addColorStop(1, 'rgba(165, 160, 152, 0.95)')
  ctx.fillStyle = g
  ctx.fillRect(x, -thickness / 2, len, thickness)
  ctx.fillStyle = 'rgba(30, 26, 22, 0.55)'
  for (let i = 0; i < 9; i++) {
    const px = x + len * ((i * 0.43 + 0.2) % 1)
    const py = -thickness / 2 + thickness * ((i * 0.67 + 0.1) % 1)
    ctx.fillRect(px, py, Math.max(thickness * 0.1, 1), Math.max(thickness * 0.08, 1))
  }
}

function mixColor(a: number[], b: number[], t: number): string {
  const k = Math.min(Math.max(t, 0), 1)
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * k))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

/**
 * STEP 10：先端にたまった灰（回転済みの座標。x から +x 方向へ len）。白・灰色・黒の筋と、不規則な輪郭。
 * 形は位置によらない決まった揺らぎ（毎フレーム同じ形）にして、ちらつかないようにする。
 */
function drawAshColumn(ctx: CanvasRenderingContext2D, x: number, len: number, thickness: number) {
  const h = thickness * 0.94
  const steps = 6
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(x, -h / 2)
  for (let i = 1; i <= steps; i++) ctx.lineTo(x + (len * i) / steps, -h / 2 + h * 0.06 * Math.sin(i * 1.7 + 0.4))
  // 先端は少し崩れた丸み
  for (let i = 0; i <= steps; i++) {
    const y = -h / 2 + (h * i) / steps
    ctx.lineTo(x + len - h * (0.08 + 0.16 * Math.abs(Math.sin(i * 2.1 + 0.7))), y)
  }
  for (let i = steps - 1; i >= 0; i--) ctx.lineTo(x + (len * i) / steps, h / 2 - h * 0.06 * Math.sin(i * 1.3 + 1.9))
  ctx.closePath()
  const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2)
  g.addColorStop(0, '#d9d6d0')
  g.addColorStop(0.45, '#a8a39c')
  g.addColorStop(1, '#5e5a55')
  ctx.fillStyle = g
  ctx.fill()
  ctx.clip()
  // 燃えた巻紙の輪の跡（黒い筋）と白い粒
  ctx.strokeStyle = 'rgba(40, 36, 32, 0.45)'
  ctx.lineWidth = Math.max(h * 0.06, 0.8)
  for (let sx = x + h * 0.35; sx < x + len; sx += h * 0.42) {
    ctx.beginPath()
    ctx.moveTo(sx, -h / 2)
    ctx.lineTo(sx + h * 0.08, h / 2)
    ctx.stroke()
  }
  ctx.fillStyle = 'rgba(250, 250, 246, 0.6)'
  for (let i = 0; i < 5; i++) {
    const px = x + len * ((i * 0.37 + 0.15) % 1)
    const py = -h / 2 + h * ((i * 0.61 + 0.2) % 1)
    ctx.fillRect(px, py, Math.max(h * 0.08, 1), Math.max(h * 0.08, 1))
  }
  ctx.restore()
}

/** 火の先端の発光（STEP 4：着火済みのときだけ。赤く脈打つように揺らぐ。STEP 10：boost で灰を落とした直後に強く光る） */
function drawEmberGlow(ctx: CanvasRenderingContext2D, tipX: number, thickness: number, now: number, boost = 1) {
  const flicker = Math.min(1, (0.7 + 0.3 * Math.sin(now / 90) * Math.sin(now / 37)) * boost)
  const pulse = 0.85 + 0.15 * Math.sin(now / 420)
  const r = thickness * 1.2 * pulse * (1 + (boost - 1) * 0.3)
  const glow = ctx.createRadialGradient(tipX, 0, 0, tipX, 0, r)
  glow.addColorStop(0, `rgba(255, 190, 90, ${0.75 * flicker})`)
  glow.addColorStop(0.35, `rgba(255, 70, 20, ${0.5 * flicker})`)
  glow.addColorStop(1, 'rgba(200, 20, 0, 0)')
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(tipX, 0, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** 透明背景のタバコ（左=吸い口フィルター、右=火側）を Canvas で描く。lit=false は未着火（葉の断面） */
function createCigaretteSprite(lit: boolean): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = SPRITE_WIDTH
  canvas.height = SPRITE_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const W = SPRITE_WIDTH
  const H = SPRITE_HEIGHT
  const filterEnd = W * FILTER_END
  const ashStart = W * ASH_START
  const radius = H * 0.18

  ctx.save()
  roundedRect(ctx, 0, 0, W, H, radius)
  ctx.clip()

  // 巻紙
  ctx.fillStyle = '#f4f1ea'
  ctx.fillRect(filterEnd, 0, ashStart - filterEnd, H)

  // フィルター（コルク柄）
  ctx.fillStyle = '#d58a3a'
  ctx.fillRect(0, 0, filterEnd, H)
  let seed = 7
  const rand = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  ctx.fillStyle = 'rgba(120, 60, 15, 0.35)'
  for (let i = 0; i < 260; i++) {
    ctx.beginPath()
    ctx.ellipse(rand() * filterEnd, rand() * H, 1 + rand() * 2.5, 0.8 + rand() * 1.5, rand() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = '#c9a54a'
  ctx.fillRect(filterEnd - 5, 0, 5, H)

  if (lit) {
    // 灰と火
    const ash = ctx.createLinearGradient(ashStart, 0, W, 0)
    ash.addColorStop(0, '#9c9893')
    ash.addColorStop(0.55, '#6f6a66')
    ash.addColorStop(0.8, '#e2531c')
    ash.addColorStop(1, '#ffb347')
    ctx.fillStyle = ash
    ctx.fillRect(ashStart, 0, W - ashStart, H)
  } else {
    // 未着火：巻紙のまま、端に葉の断面（茶色）
    ctx.fillStyle = '#f4f1ea'
    ctx.fillRect(ashStart, 0, W - ashStart, H)
    ctx.fillStyle = '#7a4f24'
    ctx.fillRect(W - 7, 0, 7, H)
  }

  // 円柱の陰影
  const shade = ctx.createLinearGradient(0, 0, 0, H)
  shade.addColorStop(0, 'rgba(0, 0, 0, 0.28)')
  shade.addColorStop(0.3, 'rgba(255, 255, 255, 0.25)')
  shade.addColorStop(0.55, 'rgba(255, 255, 255, 0)')
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.35)')
  ctx.fillStyle = shade
  ctx.fillRect(0, 0, W, H)
  ctx.restore()

  return canvas
}

/** STEP 6：透明背景の葉巻（左=吸い口、右=火側）。太く濃い茶色の葉、吸い口寄りに帯（シガーバンド） */
function createCigarSprite(lit: boolean): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  const W = SPRITE_WIDTH
  const H = 112
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.save()
  roundedRect(ctx, 0, 0, W, H, H * 0.45)
  ctx.clip()
  const leaf = ctx.createLinearGradient(0, 0, W, 0)
  leaf.addColorStop(0, '#5a3418')
  leaf.addColorStop(0.5, '#7a4a22')
  leaf.addColorStop(1, '#5e381a')
  ctx.fillStyle = leaf
  ctx.fillRect(0, 0, W, H)
  // 葉の巻き目（斜めの筋）
  ctx.strokeStyle = 'rgba(40, 20, 8, 0.35)'
  ctx.lineWidth = 3
  for (let x = -H; x < W; x += 46) {
    ctx.beginPath()
    ctx.moveTo(x, H)
    ctx.lineTo(x + H * 0.9, 0)
    ctx.stroke()
  }
  // シガーバンド（赤と金）
  ctx.fillStyle = '#b3201c'
  ctx.fillRect(W * 0.16, 0, W * 0.08, H)
  ctx.fillStyle = '#e2b84a'
  ctx.fillRect(W * 0.16, 0, W * 0.012, H)
  ctx.fillRect(W * 0.228, 0, W * 0.012, H)
  ctx.beginPath()
  ctx.ellipse(W * 0.2, H / 2, W * 0.022, H * 0.22, 0, 0, Math.PI * 2)
  ctx.fill()
  if (lit) {
    const ash = ctx.createLinearGradient(W * 0.9, 0, W, 0)
    ash.addColorStop(0, '#8d8984')
    ash.addColorStop(0.6, '#5f5a56')
    ash.addColorStop(0.85, '#d9461a')
    ash.addColorStop(1, '#ffa53d')
    ctx.fillStyle = ash
    ctx.fillRect(W * 0.9, 0, W * 0.1, H)
  } else {
    ctx.fillStyle = '#3d2410'
    ctx.fillRect(W - 9, 0, 9, H)
  }
  const shade = ctx.createLinearGradient(0, 0, 0, H)
  shade.addColorStop(0, 'rgba(0, 0, 0, 0.35)')
  shade.addColorStop(0.3, 'rgba(255, 230, 200, 0.18)')
  shade.addColorStop(0.55, 'rgba(255, 255, 255, 0)')
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.45)')
  ctx.fillStyle = shade
  ctx.fillRect(0, 0, W, H)
  ctx.restore()
  return canvas
}

/**
 * STEP 6：パイプ（回転済みの座標で描く。x：吸い口 −L/2 → 火側 +L/2、side：ボウルが伸びる y の符号）。
 * 黒い吸い口・木の柄・火側の端から立ち上がるボウル（火皿）。着火中はボウルの開口部が赤く光る。
 */
function drawPipe(
  ctx: CanvasRenderingContext2D,
  length: number,
  stem: number,
  side: number,
  lit: boolean,
  now: number,
) {
  const half = length / 2
  const { bowlWidth, bowlHeight } = pipeBowl(length, stem)
  const bowlX = half - bowlWidth / 2
  ctx.save()
  // ボウルが常に y の負の向き（上）に来るように反転して描く
  ctx.scale(1, -side)
  const wood = ctx.createLinearGradient(0, -bowlHeight, 0, stem)
  wood.addColorStop(0, '#8a4b22')
  wood.addColorStop(0.5, '#6b3415')
  wood.addColorStop(1, '#3f1d0a')
  // 柄
  ctx.fillStyle = wood
  roundedRect(ctx, -half + length * 0.18, -stem / 2, length * 0.82 - bowlWidth * 0.5, stem, stem * 0.4)
  ctx.fill()
  // 吸い口（黒）
  ctx.fillStyle = '#151515'
  roundedRect(ctx, -half, -stem / 2, length * 0.2, stem, stem * 0.4)
  ctx.fill()
  // ボウル（下が丸い円筒）
  ctx.fillStyle = wood
  ctx.beginPath()
  ctx.moveTo(bowlX - bowlWidth / 2, -bowlHeight)
  ctx.lineTo(bowlX + bowlWidth / 2, -bowlHeight)
  ctx.lineTo(bowlX + bowlWidth / 2, stem * 0.1)
  ctx.quadraticCurveTo(bowlX + bowlWidth / 2, stem * 0.9, bowlX, stem * 0.9)
  ctx.quadraticCurveTo(bowlX - bowlWidth / 2, stem * 0.9, bowlX - bowlWidth / 2, stem * 0.1)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = 'rgba(30, 12, 4, 0.6)'
  ctx.lineWidth = Math.max(stem * 0.12, 1)
  ctx.stroke()
  // 開口部
  ctx.fillStyle = lit ? '#e2531c' : '#2a1608'
  ctx.beginPath()
  ctx.ellipse(bowlX, -bowlHeight, bowlWidth * 0.42, bowlWidth * 0.12, 0, 0, Math.PI * 2)
  ctx.fill()
  if (lit) {
    ctx.translate(bowlX, -bowlHeight)
    ctx.rotate(Math.PI / 2)
    drawEmberGlow(ctx, 0, bowlWidth * 0.6, now)
  }
  ctx.restore()
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
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
