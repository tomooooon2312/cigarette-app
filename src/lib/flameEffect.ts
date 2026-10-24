import type { Point2 } from './penGeometry'

export type FlameSource = 'snap' | 'lighter' | 'manual'

type Flame = {
  id: number
  source: FlameSource
  position: Point2
  /** 炎の高さ px */
  size: number
  startedAt: number
  /** 消える時刻（ライターの炎は Infinity で、ボタンを離したら消す） */
  endsAt: number
  /** 追従させる手の番号（指パッチンの炎のみ） */
  handKey: string | null
  seed: number
}

type Spark = { x: number; y: number; vx: number; vy: number; age: number; life: number; size: number }

/** 指パッチン・手動の炎の表示時間 ms */
export const SNAP_FLAME_MS = 2500
/** 出現・消滅時のフェード時間 ms */
const FADE_IN_MS = 120
const FADE_OUT_MS = 350
/** 火の粉の上限（スマホでの負荷対策） */
const MAX_SPARKS = 60
const SPARK_RATE = 14
const MAX_STEP_SEC = 0.1

export type ActiveFlame = { source: FlameSource; position: Point2; size: number; intensity: number }

/**
 * Canvas 2D による炎。
 * 赤・オレンジ・黄・白の半透明の涙形を重ねて加算合成し、時間で揺らす。外側に光のにじみ、上へ舞う火の粉を加える。
 */
export class FlameEffect {
  private flames: Flame[] = []
  private sparks: Spark[] = []
  private nextId = 1
  private lastTime: number | null = null
  private sparkCarry = 0

  /** 一定時間だけ表示する炎を出す（指パッチン・手動） */
  spawn(source: Exclude<FlameSource, 'lighter'>, position: Point2, size: number, now: number, handKey: string | null = null): void {
    // 同じ手の炎は 1 つにまとめる（連続で判定されても炎が増え続けない）
    this.flames = this.flames.filter((f) => !(handKey && f.handKey === handKey))
    this.flames.push({
      id: this.nextId++,
      source,
      position,
      size,
      startedAt: now,
      endsAt: now + SNAP_FLAME_MS,
      handKey,
      seed: Math.random() * 1000,
    })
  }

  /** ライターの炎：position が null（ボタンを離した・ライター未検出）なら消す */
  setLighter(position: Point2 | null, size: number, now: number): void {
    const current = this.flames.find((f) => f.source === 'lighter')
    if (!position) {
      if (current && current.endsAt === Infinity) current.endsAt = now + FADE_OUT_MS
      return
    }
    if (current && current.endsAt === Infinity) {
      current.position = position
      current.size = size
    } else {
      this.flames = this.flames.filter((f) => f.source !== 'lighter')
      this.flames.push({
        id: this.nextId++,
        source: 'lighter',
        position,
        size,
        startedAt: now,
        endsAt: Infinity,
        handKey: null,
        seed: Math.random() * 1000,
      })
    }
  }

  /** 指パッチンの炎を、その手の指先に追従させる */
  follow(handKey: string, position: Point2): void {
    for (const f of this.flames) if (f.handKey === handKey) f.position = position
  }

  /**
   * 着火判定に使う、現在見えている炎（フェードアウト中も含む）。
   * position は炎の根元ではなく、炎の胴体の中心（根元から高さの 45% 上）。
   */
  active(now: number): ActiveFlame[] {
    return this.flames
      .filter((f) => now >= f.startedAt && now < f.endsAt)
      .map((f) => ({
        source: f.source,
        position: { x: f.position.x, y: f.position.y - f.size * 0.45 },
        size: f.size,
        intensity: this.intensity(f, now),
      }))
  }

  update(now: number): void {
    const dt = this.lastTime === null ? 0 : Math.min((now - this.lastTime) / 1000, MAX_STEP_SEC)
    this.lastTime = now
    this.flames = this.flames.filter((f) => now < f.endsAt)

    for (const s of this.sparks) {
      s.age += dt
      s.vy -= 40 * dt
      s.vx *= Math.exp(-1.5 * dt)
      s.x += s.vx * dt
      s.y += s.vy * dt
    }
    this.sparks = this.sparks.filter((s) => s.age < s.life)

    for (const f of this.flames) {
      this.sparkCarry += SPARK_RATE * dt * this.intensity(f, now)
      while (this.sparkCarry >= 1 && this.sparks.length < MAX_SPARKS) {
        this.sparkCarry -= 1
        this.sparks.push({
          x: f.position.x + (Math.random() - 0.5) * f.size * 0.25,
          y: f.position.y - f.size * (0.3 + Math.random() * 0.4),
          vx: (Math.random() - 0.5) * f.size * 0.8,
          vy: -f.size * (0.8 + Math.random() * 0.9),
          age: 0,
          life: 0.4 + Math.random() * 0.5,
          size: Math.max(f.size * 0.035, 1.2),
        })
      }
    }
    if (this.flames.length === 0) this.sparkCarry = 0
  }

  draw(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.flames.length === 0 && this.sparks.length === 0) return
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (const f of this.flames) drawFlame(ctx, f, now, this.intensity(f, now))
    for (const s of this.sparks) {
      const t = s.age / s.life
      ctx.globalAlpha = (1 - t) * 0.9
      ctx.fillStyle = t < 0.4 ? '#ffe9a8' : '#ff8a3d'
      ctx.beginPath()
      ctx.arc(s.x, s.y, s.size * (1 - t * 0.5), 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  clear(): void {
    this.flames = []
    this.sparks = []
    this.lastTime = null
    this.sparkCarry = 0
  }

  private intensity(f: Flame, now: number): number {
    const fadeIn = Math.min((now - f.startedAt) / FADE_IN_MS, 1)
    const fadeOut = f.endsAt === Infinity ? 1 : Math.min((f.endsAt - now) / FADE_OUT_MS, 1)
    return Math.max(0, Math.min(fadeIn, fadeOut))
  }
}

/** 炎の層：外側から赤 → オレンジ → 黄 → 白に近い芯 */
const LAYERS = [
  { scale: 1.0, width: 0.42, color: [255, 60, 20], alpha: 0.55 },
  { scale: 0.82, width: 0.34, color: [255, 130, 30], alpha: 0.6 },
  { scale: 0.6, width: 0.25, color: [255, 205, 70], alpha: 0.65 },
  { scale: 0.35, width: 0.14, color: [255, 250, 220], alpha: 0.7 },
] as const

function drawFlame(ctx: CanvasRenderingContext2D, f: Flame, now: number, intensity: number): void {
  if (intensity <= 0) return
  const t = now / 1000 + f.seed
  // ゆらぎ：周期の違う sin を重ねて、高さ・傾き・幅を揺らす
  const flicker = 0.88 + 0.08 * Math.sin(t * 17) + 0.05 * Math.sin(t * 31 + 1.3)
  const sway = 0.12 * Math.sin(t * 5.3) + 0.06 * Math.sin(t * 11.7 + 0.7)
  const h = f.size * flicker * (0.6 + 0.4 * intensity)
  const { x, y } = f.position

  // 光のにじみ
  const glow = ctx.createRadialGradient(x, y - h * 0.3, 0, x, y - h * 0.3, h * 1.1)
  glow.addColorStop(0, `rgba(255, 150, 60, ${0.35 * intensity})`)
  glow.addColorStop(1, 'rgba(255, 80, 20, 0)')
  ctx.globalAlpha = 1
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(x, y - h * 0.3, h * 1.1, 0, Math.PI * 2)
  ctx.fill()

  for (const layer of LAYERS) {
    const lh = h * layer.scale
    const lw = h * layer.width * (1 + 0.06 * Math.sin(t * 23 + layer.scale * 5))
    const tipX = x + sway * lh
    const tipY = y - lh
    const [r, g, b] = layer.color
    ctx.globalAlpha = layer.alpha * intensity
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
    // 涙形：根元は丸く、先端はとがる
    ctx.beginPath()
    ctx.moveTo(tipX, tipY)
    ctx.bezierCurveTo(x + lw * 0.9, y - lh * 0.55, x + lw, y - lh * 0.05, x, y + lw * 0.35)
    ctx.bezierCurveTo(x - lw, y - lh * 0.05, x - lw * 0.9, y - lh * 0.55, tipX, tipY)
    ctx.fill()
  }
}
