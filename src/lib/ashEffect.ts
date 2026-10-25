import type { Point2 } from './penGeometry'

/** 灰の粒子の上限（スマホでの負荷対策。全員の合計） */
export const MAX_ASH_PARTICLES = 120
/** 1 回の灰落としで出す塊と細かい粒の数 */
const CHUNKS = 4
const FINE = 18
/** 塊が途中で崩れて出す細かい粒の数 */
const CRUMBS_PER_CHUNK = 5
const MAX_STEP_SEC = 0.1

type AshParticle = {
  x: number
  y: number
  vx: number
  vy: number
  /** 空気抵抗 1/s */
  drag: number
  size: number
  rotation: number
  spin: number
  age: number
  life: number
  /** 塊（不規則な多角形）か、細かい粒か */
  chunk: boolean
  /** 塊が崩れる時刻 s（崩れたら細かい粒を出す。崩れない塊は Infinity） */
  breakAt: number
  /** 0 = 白っぽい、1 = 黒っぽい */
  tone: number
  /** 塊の形（頂点の半径の倍率） */
  shape: number[]
}

export type AshDrop = {
  /** 灰の塊の中心（タバコの火側の先） */
  position: Point2
  /** 吸い口 → 火 の単位ベクトル */
  dir: Point2
  /** 落ちる灰の長さ px */
  ashLength: number
  /** タバコの太さ px */
  thickness: number
}

const rand = (min: number, max: number) => min + Math.random() * (max - min)

/**
 * STEP 10：落ちる灰（Canvas 2D）。灰の塊が重力で下へ落ち、途中で崩れて細かい粒が散り、1〜2 秒でフェードアウトする。
 * 時間の計算はすべて deltaTime（秒）で行い、fps によって落ちる速さが変わらないようにしている。
 */
export class AshEffect {
  /** 重力 px/s²（画面の高さに合わせて setFrame で決める） */
  private gravity = 900
  private particles: AshParticle[] = []
  private lastTime: number | null = null

  get particleCount(): number {
    return this.particles.length
  }

  /** 画面の高さから重力を決める（処理解像度が変わっても同じ見た目の速さにする） */
  setFrame(height: number): void {
    this.gravity = Math.max(height, 1) * 2.2
  }

  /** 灰を落とす（塊と細かい粒を出す） */
  drop(d: AshDrop): void {
    const s = Math.max(d.thickness, 3)
    const along = Math.max(d.ashLength, s * 0.6)
    for (let i = 0; i < CHUNKS && this.particles.length < MAX_ASH_PARTICLES; i++) {
      const k = (i + 0.5) / CHUNKS - 0.5
      this.particles.push({
        x: d.position.x + d.dir.x * along * k,
        y: d.position.y + d.dir.y * along * k,
        vx: rand(-0.6, 0.6) * s,
        vy: rand(-0.4, 0.6) * s,
        drag: 0.4,
        size: s * rand(0.35, 0.6),
        rotation: rand(0, Math.PI * 2),
        spin: rand(-4, 4),
        age: 0,
        life: rand(1.2, 1.8),
        chunk: true,
        breakAt: rand(0.25, 0.55),
        tone: rand(0.15, 0.6),
        shape: Array.from({ length: 7 }, () => rand(0.6, 1)),
      })
    }
    for (let i = 0; i < FINE && this.particles.length < MAX_ASH_PARTICLES; i++) this.particles.push(fine(d.position, s, 1))
  }

  update(now: number): void {
    const dt = this.lastTime === null ? 0 : Math.min((now - this.lastTime) / 1000, MAX_STEP_SEC)
    this.lastTime = now
    if (this.particles.length === 0) return
    const born: AshParticle[] = []
    for (const p of this.particles) {
      p.age += dt
      const decay = Math.exp(-p.drag * dt)
      p.vx *= decay
      p.vy = p.vy * decay + this.gravity * (p.chunk ? 1 : 0.35) * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.rotation += p.spin * dt
      if (p.chunk && p.age >= p.breakAt) {
        // 塊が崩れて細かい粒が散る（塊は小さくなって落ち続ける）
        p.breakAt = Infinity
        p.size *= 0.6
        for (let i = 0; i < CRUMBS_PER_CHUNK; i++) {
          const c = fine({ x: p.x, y: p.y }, p.size * 1.6, 0.6)
          c.vy += p.vy * 0.5
          born.push(c)
        }
      }
    }
    this.particles = this.particles.filter((p) => p.age < p.life)
    for (const c of born) if (this.particles.length < MAX_ASH_PARTICLES) this.particles.push(c)
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.particles.length === 0) return
    ctx.save()
    for (const p of this.particles) {
      const t = p.age / p.life
      // 最後の 40% でフェードアウト
      ctx.globalAlpha = Math.min(1, (1 - t) / 0.4) * 0.95
      const g = Math.round(225 - p.tone * 170)
      ctx.fillStyle = `rgb(${g}, ${g - 4}, ${g - 8})`
      if (p.chunk) {
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rotation)
        ctx.beginPath()
        p.shape.forEach((m, i) => {
          const a = (i / p.shape.length) * Math.PI * 2
          const r = p.size * m
          if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r)
          else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r)
        })
        ctx.closePath()
        ctx.fill()
        ctx.restore()
      } else {
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
      }
    }
    ctx.restore()
  }

  clear(): void {
    this.particles = []
    this.lastTime = null
  }

  /** テスト用：粒子の読み取り専用コピー */
  snapshot(): { x: number; y: number; age: number; chunk: boolean }[] {
    return this.particles.map(({ x, y, age, chunk }) => ({ x, y, age, chunk }))
  }
}

/** 細かい灰の粒（ふわっと散ってから落ちる） */
function fine(at: Point2, s: number, spread: number): AshParticle {
  const a = rand(0, Math.PI * 2)
  const v = s * rand(0.8, 2.6) * spread
  return {
    x: at.x + rand(-0.3, 0.3) * s,
    y: at.y + rand(-0.3, 0.3) * s,
    vx: Math.cos(a) * v,
    vy: Math.sin(a) * v - s * 0.5,
    drag: 2.2,
    size: Math.max(s * rand(0.08, 0.18), 1),
    rotation: 0,
    spin: 0,
    age: 0,
    life: rand(0.8, 1.6),
    chunk: false,
    breakAt: Infinity,
    tone: rand(0, 1),
    shape: [],
  }
}
