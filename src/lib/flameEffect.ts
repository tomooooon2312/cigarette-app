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
  /** STEP 9：手の位置を最後に受け取った時刻（手を見失ったらフェードアウトする） */
  lastSeenAt: number
  seed: number
  /** STEP 13：手を振って消した（フェードアウト中。着火判定には使わない） */
  doused?: boolean
}

type Spark = { x: number; y: number; vx: number; vy: number; age: number; life: number; size: number }

/**
 * 着火ジェスチャー（指パッチン）・手動の炎の表示時間 ms。STEP 10 で 2500 → 5000（2 倍）。
 * 表示と着火判定は同じ炎の endsAt を使うので、炎が見えている間だけ着火できる。
 */
export const FLAME_DURATION_MS = 5000
/** STEP 9 までの表示時間 ms（変更前の値。テストと仕様書の比較用） */
export const PREVIOUS_FLAME_DURATION_MS = 2500
/** 互換のための別名（STEP 4〜9 の名前） */
export const SNAP_FLAME_MS = FLAME_DURATION_MS
/** 出現・消滅時のフェード時間 ms */
const FADE_IN_MS = 120
const FADE_OUT_MS = 350
/** STEP 13：手を振って消したときのフェードアウト ms */
export const DOUSE_FADE_MS = 200
/** 火の粉の上限（スマホでの負荷対策） */
const MAX_SPARKS = 60
const SPARK_RATE = 14
const MAX_STEP_SEC = 0.1

export type ActiveFlame = {
  source: FlameSource
  /** 炎の胴体の中心（根元から高さの 45% 上） */
  position: Point2
  size: number
  intensity: number
  /** STEP 11：炎の根元（指先・火口。描画の基準と同じ点） */
  base: Point2
  /** STEP 11：炎の先端（根元から高さの FLAME_TIP_RATIO 上）。着火判定は根元〜先端の線分で行う */
  tip: Point2
  /** STEP 11：炎を出した手（指パッチン・手の指先の手動の炎。無ければ null） */
  handKey: string | null
}

/** STEP 11：着火判定に使う炎の先端の高さ（炎の大きさに対する比率。描画する炎の高さ 0.6〜1.0 倍の中ほど） */
export const FLAME_TIP_RATIO = 0.9

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
      endsAt: now + FLAME_DURATION_MS,
      handKey,
      lastSeenAt: now,
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
        lastSeenAt: now,
        seed: Math.random() * 1000,
      })
    }
  }

  /** 指パッチンの炎を、その手の指先に追従させる（now を渡すと、手が見えている時刻として記録する） */
  follow(handKey: string, position: Point2, now?: number): void {
    for (const f of this.flames) {
      if (f.handKey !== handKey) continue
      f.position = position
      if (now !== undefined) f.lastSeenAt = now
    }
  }

  /**
   * STEP 13：その手の炎（指パッチン・手動）を消す（手を振った）。DOUSE_FADE_MS でフェードアウトし、その間も着火には使わない。
   * 消した炎があれば true。
   */
  douse(handKey: string, now: number): boolean {
    let doused = false
    for (const f of this.flames) {
      if (f.handKey !== handKey || f.endsAt === Infinity || f.doused || now >= f.endsAt) continue
      f.doused = true
      f.endsAt = Math.min(f.endsAt, now + DOUSE_FADE_MS)
      doused = true
      // 振って消えるときの火の粉
      for (let i = 0; i < 10 && this.sparks.length < MAX_SPARKS; i++) {
        this.sparks.push({
          x: f.position.x + (Math.random() - 0.5) * f.size * 0.3,
          y: f.position.y - f.size * Math.random() * 0.6,
          vx: (Math.random() - 0.5) * f.size * 2.4,
          vy: -f.size * (0.3 + Math.random() * 0.8),
          age: 0,
          life: 0.25 + Math.random() * 0.3,
          size: Math.max(f.size * 0.03, 1),
        })
      }
    }
    return doused
  }

  /** STEP 13：その手に、まだ消していない炎があるか */
  hasLitFlame(handKey: string, now: number): boolean {
    return this.flames.some((f) => f.handKey === handKey && f.endsAt !== Infinity && !f.doused && now < f.endsAt)
  }

  /** STEP 9：その手の炎の根元の位置（無ければ null） */
  positionOf(handKey: string): Point2 | null {
    return this.flames.find((f) => f.handKey === handKey && f.endsAt !== Infinity)?.position ?? null
  }

  /**
   * STEP 9：手を holdMs より長く見失った炎は、その位置のままフェードアウトさせる（手が見えない間は位置を保持し、別の手には移さない）。
   */
  releaseLostHands(now: number, holdMs: number): void {
    for (const f of this.flames) {
      if (f.handKey === null || now - f.lastSeenAt <= holdMs) continue
      // 最後に手が見えた時刻から holdMs 保持し、その後 FADE_OUT_MS でフェードアウトする（更新の間隔によらない）
      f.endsAt = Math.min(f.endsAt, f.lastSeenAt + holdMs + FADE_OUT_MS)
    }
  }

  /** STEP 10：表示時間のある炎（指パッチン・手動）の残り時間（デバッグ表示用。フェードアウトの時間を含む） */
  remaining(now: number): { handKey: string | null; source: FlameSource; remainingMs: number; durationMs: number }[] {
    return this.flames
      .filter((f) => f.endsAt !== Infinity && now < f.endsAt)
      .map((f) => ({ handKey: f.handKey, source: f.source, remainingMs: f.endsAt - now, durationMs: f.endsAt - f.startedAt }))
  }

  /**
   * 着火判定に使う、現在見えている炎（フェードアウト中も含む）。
   * position は炎の根元ではなく、炎の胴体の中心（根元から高さの 45% 上）。
   * STEP 11：base・tip は描画と同じ根元の位置から求める（表示と着火判定で同じ座標を使う）。
   */
  active(now: number): ActiveFlame[] {
    return this.flames
      .filter((f) => now >= f.startedAt && now < f.endsAt && !f.doused)
      .map((f) => ({
        source: f.source,
        position: { x: f.position.x, y: f.position.y - f.size * 0.45 },
        size: f.size,
        intensity: this.intensity(f, now),
        base: { ...f.position },
        tip: { x: f.position.x, y: f.position.y - f.size * FLAME_TIP_RATIO },
        handKey: f.handKey,
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
