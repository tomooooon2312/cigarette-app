import type { Point2 } from './penGeometry'
import {
  DEFAULT_FSM_SETTINGS,
  type SmokeEmitter,
  type SmokeFsmSettings,
} from './smokeStateMachine'

/** 煙の見た目の調整値（STEP 3.2） */
export type SmokeStyle = {
  /** 量：発生数の倍率（0〜3 = 0〜300%） */
  amount: number
  /** 速度：初速の倍率（0.5〜4.0） */
  speed: number
  /** 広がり：拡大量・噴き出す角度・揺らぎの倍率（0.5〜3.0） */
  spread: number
  /** 濃さ：不透明度（0〜1 = 0〜100%） */
  density: number
}

export type SmokePresetId = 'natural' | 'cinematic' | 'powerful'

/**
 * 倍率 1.0（量 100%・速度 ×1.0）は、STEP 3.1 の口元の煙に対して発生数 約 2.4 倍・初速 約 3 倍。
 */
export const SMOKE_PRESETS: Record<SmokePresetId, { label: string; style: SmokeStyle }> = {
  natural: { label: 'ナチュラル', style: { amount: 0.5, speed: 0.6, spread: 0.8, density: 0.4 } },
  cinematic: { label: 'シネマティック', style: { amount: 1.0, speed: 1.0, spread: 1.2, density: 0.7 } },
  powerful: { label: 'パワフル', style: { amount: 1.8, speed: 1.6, spread: 1.8, density: 0.85 } },
}

export type SmokeSettings = SmokeFsmSettings &
  SmokeStyle & {
    /** 口元検出（MediaPipe）と煙を有効にする */
    enabled: boolean
    /** 顔の推論間隔 ms（大きくするとスマホでの負荷が下がる） */
    inferenceIntervalMs: number
    /** 顔ランドマーク・ペンの両端・煙の発生位置・しきい値の円を画面に表示する */
    showDebug: boolean
    /** 選択中のプリセット（スライダーを動かすと 'custom'） */
    preset: SmokePresetId | 'custom'
  }

export const DEFAULT_SMOKE: SmokeSettings = {
  ...DEFAULT_FSM_SETTINGS,
  ...SMOKE_PRESETS.powerful.style,
  preset: 'powerful',
  enabled: true,
  inferenceIntervalMs: 66,
  showDebug: false,
}

/** 新しい煙を出す位置と種類。状態機械の出力からのみ作る */
export type SmokeSource = {
  kind: Exclude<SmokeEmitter, 'none'>
  position: Point2
  /** 粒子の大きさの基準 px（顔・タバコ・画面の大きさから決める） */
  scale: number
  /** 噴き出す向き（単位ベクトル）。mouth のみ使う */
  direction: Point2
}

export type SmokeSourceInput = {
  emberEnd: Point2 | null
  cigaretteThickness: number
  mouth: { center: Point2; width: number; facing: number } | null
  /** 画面（処理解像度）の幅。粒子の大きさの上限・下限に使う */
  frameWidth: number
}

/** 顔の向きがこれより小さい（ほぼ正面）ときは、直前の向きに噴き出す */
const FACING_DEADZONE = 0.12
/** 噴き出す向きの下向き成分（ラジアン）。吐いた煙は少し下へ出てから浮き上がる */
const EXHALE_DOWNWARD = 0.12

/**
 * 状態機械が選んだ発生源を、画面上の位置・向き・大きさに変換する（発生位置の決定はここに一元化する）。
 * ember はタバコ CG の火側の端、mouth は唇の中心。
 * 口元の煙は顔が向いている側（表示座標＝ミラー後で判定するので左右反転にも追従）へ横向きに噴き出す。
 */
export function resolveSmokeSource(
  emitter: SmokeEmitter,
  input: SmokeSourceInput,
  previousSide = 1,
): SmokeSource | null {
  const clampScale = (v: number) =>
    Math.min(Math.max(v, input.frameWidth * 0.008), input.frameWidth * 0.08)
  if (emitter === 'ember' && input.emberEnd) {
    return {
      kind: 'ember',
      position: input.emberEnd,
      scale: clampScale(Math.max(input.cigaretteThickness, 6)),
      direction: { x: 0, y: -1 },
    }
  }
  if (emitter === 'mouth' && input.mouth) {
    const { facing } = input.mouth
    const side = Math.abs(facing) >= FACING_DEADZONE ? Math.sign(facing) : previousSide
    return {
      kind: 'mouth',
      position: input.mouth.center,
      scale: clampScale(input.mouth.width * 0.45),
      direction: { x: side * Math.cos(EXHALE_DOWNWARD), y: Math.sin(EXHALE_DOWNWARD) },
    }
  }
  return null
}

type Particle = {
  kind: SmokeSource['kind']
  x: number
  y: number
  vx: number
  vy: number
  /** 空気抵抗（1/s）。速度は exp(-drag·dt) で減衰する */
  drag: number
  /** 浮力の最大値 px/s²。発生直後は 0 で、時間とともに効く */
  lift: number
  /** 横方向の揺らぎの強さ px/s² と位相 */
  wobble: number
  phase: number
  /** 揺らぎが最大になるまでの時間 s（口元の煙は最初まっすぐな流れにする） */
  wobbleRamp: number
  /** 広がり方：'fast' は生まれてすぐ広がる、'delayed' は細い流れのまま進んでから大きく広がる（STEP 4） */
  growthCurve: 'fast' | 'delayed'
  radius: number
  /** 最終的な半径の増分 px（発生直後に速く、その後ゆっくり広がる） */
  growth: number
  r0: number
  age: number
  life: number
  maxAlpha: number
  rotation: number
  spin: number
  sprite: number
}

/** 粒子数の上限（スマホでの負荷対策）。これを超える分は生成しない */
export const MAX_PARTICLES = 500
/** 量 100% のときの 1 秒あたりの発生数（STEP 4 で口元を 110 → 160） */
export const BASE_EMIT_RATE = { ember: 14, mouth: 160 } as const
/** フレーム間隔がこれを超えたら（タブ非表示からの復帰など）この値で計算する */
const MAX_STEP_SEC = 0.1
/** 1 フレームで生成する最大数（発生数の倍率を上げたときのスパイク防止） */
const MAX_SPAWN_PER_FRAME = 32

/**
 * Canvas 2D による煙のパーティクル（STEP 3.2 で強化）。
 * - mouth（EXHALING）：口元から横向きに勢いよく噴き出し、密集した塊が減速しながら広がって上へ漂う。
 * - ember（SMOKING）：火の端から細い煙がゆっくり立ち上り、わずかに横へ揺らぐ。
 * 新しい粒子は source があるときだけ出し、既存の粒子は寿命まで描画する。
 * 時間の計算はすべて deltaTime（秒）で行い、端末の fps によって速度が変わらないようにしている。
 */
export class SmokeEffect {
  /** 粒子数の上限（STEP 5：複数人のときは人数で割り振る） */
  maxParticles = MAX_PARTICLES
  private particles: Particle[] = []
  private lastTime: number | null = null
  private emitCarry = 0
  private sprites: HTMLCanvasElement[] | null = null

  update(now: number, source: SmokeSource | null, style: SmokeStyle): void {
    const dt = this.lastTime === null ? 0 : Math.min((now - this.lastTime) / 1000, MAX_STEP_SEC)
    this.lastTime = now

    for (const p of this.particles) {
      p.age += dt
      const decay = Math.exp(-p.drag * dt)
      // 浮力は発生直後は弱く、速度が落ちるにつれて効き始める
      const lift = p.lift * Math.min(p.age / 0.6, 1)
      const wobble = p.wobble * Math.min(p.age / p.wobbleRamp, 1)
      p.vx = p.vx * decay + Math.sin(p.phase + p.age * 2.3) * wobble * dt
      p.vy = p.vy * decay - lift * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.rotation += p.spin * dt
      // 小さく生まれて広がる（突然大きな円にならない）。delayed は最初ほとんど広がらず、減速してから大きな塊になる
      p.radius = p.r0 + p.growth * growthFactor(p.growthCurve, p.age)
    }
    if (this.particles.some((p) => p.age >= p.life)) {
      this.particles = this.particles.filter((p) => p.age < p.life)
    }

    if (!source || style.amount <= 0 || dt === 0) {
      this.emitCarry = 0
      return
    }
    this.emitCarry += BASE_EMIT_RATE[source.kind] * style.amount * dt
    let spawned = 0
    while (
      this.emitCarry >= 1 &&
      spawned < MAX_SPAWN_PER_FRAME &&
      this.particles.length < this.maxParticles
    ) {
      this.emitCarry -= 1
      spawned++
      // 1 フレーム内の粒子を時間方向に散らして、低 fps でも粒子が団子状に並ばないようにする
      const p = source.kind === 'mouth' ? mouthParticle(source, style) : emberParticle(source, style)
      const head = Math.random() * dt
      p.x += p.vx * head
      p.y += p.vy * head
      this.particles.push(p)
    }
    this.emitCarry = Math.min(this.emitCarry, 1)
  }

  draw(ctx: CanvasRenderingContext2D, style: SmokeStyle): void {
    if (this.particles.length === 0 || style.density <= 0) return
    const sprites = (this.sprites ??= createPuffSprites())
    ctx.save()
    for (const p of this.particles) {
      const t = p.age / p.life
      // 出始めは素早く濃くなり、寿命に合わせて薄れる
      const alpha = p.maxAlpha * style.density * Math.min(t / 0.08, 1) * (1 - t) ** 1.2
      if (alpha <= 0.003) continue
      const size = p.radius * 2
      ctx.globalAlpha = Math.min(alpha, 1)
      ctx.setTransform(
        Math.cos(p.rotation),
        Math.sin(p.rotation),
        -Math.sin(p.rotation),
        Math.cos(p.rotation),
        p.x,
        p.y,
      )
      ctx.drawImage(sprites[p.sprite], -size / 2, -size / 2, size, size)
    }
    ctx.restore()
  }

  get particleCount(): number {
    return this.particles.length
  }

  /** テスト・デバッグ用：粒子の位置と大きさの読み取り専用コピー */
  snapshot(): { kind: SmokeSource['kind']; x: number; y: number; radius: number; age: number }[] {
    return this.particles.map(({ kind, x, y, radius, age }) => ({ kind, x, y, radius, age }))
  }

  clear(): void {
    this.particles = []
    this.lastTime = null
    this.emitCarry = 0
  }
}

const rand = (min: number, max: number) => min + Math.random() * (max - min)

/** 半径の増え方（0 → 1）。fast：1 − e^(−1.4t)、delayed：1 − e^(−kt)(1 + kt)（ガンマ分布の累積、立ち上がりが遅い） */
function growthFactor(curve: Particle['growthCurve'], age: number): number {
  if (curve === 'fast') return 1 - Math.exp(-age * 1.4)
  const k = age * 1.6
  return 1 - Math.exp(-k) * (1 + k)
}

function mouthParticle({ position, scale: s, direction }: SmokeSource, style: SmokeStyle): Particle {
  // 噴き出す向きを中心に、細い円錐状に散らす（STEP 4：0.22 → 0.1。最初は細い流れにする）
  const cone = 0.1 * style.spread
  const a = Math.atan2(direction.y, direction.x) + rand(-cone, cone)
  // STEP 4：初速を STEP 3.2 の 7〜11 から 10〜14 に強化（STEP 3.1 の約 4 倍）
  const speed = s * rand(10, 14) * style.speed
  return {
    kind: 'mouth',
    // 発生直後は密集させる（口元付近の小さな範囲から出す）
    x: position.x + rand(-0.06, 0.06) * s,
    y: position.y + rand(-0.05, 0.05) * s,
    vx: Math.cos(a) * speed,
    vy: Math.sin(a) * speed,
    drag: rand(1.8, 2.4),
    lift: s * rand(1.4, 2.0),
    wobble: s * 1.4 * style.spread,
    phase: rand(0, Math.PI * 2),
    wobbleRamp: 0.5,
    growthCurve: 'delayed',
    r0: s * rand(0.05, 0.09),
    radius: s * 0.05,
    growth: s * rand(2.4, 3.4) * style.spread,
    age: 0,
    life: rand(2.0, 3.2),
    maxAlpha: rand(0.38, 0.52),
    rotation: rand(0, Math.PI * 2),
    spin: rand(-0.8, 0.8),
    sprite: Math.floor(Math.random() * PUFF_VARIANTS),
  }
}

function emberParticle({ position, scale: s }: SmokeSource, style: SmokeStyle): Particle {
  // タバコ側は速度・広がりの影響を弱め、細くゆっくり立ち上る見た目を保つ
  const speed = Math.sqrt(style.speed)
  const spread = Math.sqrt(style.spread)
  return {
    kind: 'ember',
    x: position.x + rand(-0.15, 0.15) * s,
    y: position.y + rand(-0.15, 0.15) * s,
    vx: rand(-0.15, 0.15) * s * speed,
    vy: -s * rand(1.8, 2.6) * speed,
    drag: 0.6,
    lift: s * 1.4 * speed,
    wobble: s * 0.9 * spread,
    phase: rand(0, Math.PI * 2),
    wobbleRamp: 0.01,
    growthCurve: 'fast',
    r0: s * rand(0.1, 0.16),
    radius: s * 0.1,
    growth: s * rand(0.6, 0.9) * spread,
    age: 0,
    life: rand(2.2, 3.4),
    maxAlpha: rand(0.2, 0.3),
    rotation: rand(0, Math.PI * 2),
    spin: rand(-0.4, 0.4),
    sprite: Math.floor(Math.random() * PUFF_VARIANTS),
  }
}

const PUFF_VARIANTS = 3
const PUFF_SIZE = 96

/**
 * 煙の塊のスプライトを事前に生成する。
 * 毎フレーム粒子ごとに放射グラデーションを作ると重いため、柔らかい塊を数種類だけ描いておき drawImage で使い回す。
 * 中心の大きな円に小さな円を重ね、輪郭が真円にならない「もくもく」した形にする。
 */
function createPuffSprites(): HTMLCanvasElement[] {
  let seed = 11
  const random = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  return Array.from({ length: PUFF_VARIANTS }, () => {
    const canvas = document.createElement('canvas')
    canvas.width = PUFF_SIZE
    canvas.height = PUFF_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) return canvas
    const c = PUFF_SIZE / 2
    const blob = (x: number, y: number, r: number, alpha: number) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      // 明るい背景でも見えるよう、中心はわずかに灰色寄りにする
      g.addColorStop(0, `rgba(232, 232, 236, ${alpha})`)
      g.addColorStop(0.55, `rgba(212, 212, 220, ${alpha * 0.5})`)
      g.addColorStop(1, 'rgba(205, 205, 215, 0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    blob(c, c, c * 0.95, 0.85)
    for (let i = 0; i < 5; i++) {
      const a = random() * Math.PI * 2
      const d = c * (0.2 + random() * 0.15)
      // スプライトの端で切れて輪郭が硬くならないよう、円が枠内に収まる半径にする
      const r = Math.min(c * (0.35 + random() * 0.25), c * 0.95 - d)
      blob(c + Math.cos(a) * d, c + Math.sin(a) * d, r, 0.35)
    }
    return canvas
  })
}
