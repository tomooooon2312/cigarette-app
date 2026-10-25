import type { Point2 } from './penGeometry'

/**
 * STEP 11：着火ジェスチャーが成功した瞬間に、人差し指の先端の少し上へ出す「SNAP!」の文字（コミック風）。
 * 炎と同じ成功イベント（SnapEvent）から出し、位置は出した時点の人差し指の先端に固定する（短時間なので追従しない）。
 * Canvas 2D だけで描く（ギザギザの吹き出し・衝撃線・火花・縁取りした文字）。1 つあたり数十回の描画命令なので軽い。
 */
/** 表示時間 ms */
export const SNAP_TEXT_MS = 600
/** 勢いよく拡大する時間 ms（その後は少しだけ大きくなりながら残る） */
const POP_MS = 140
/** フェードアウトを始める時刻 ms */
const FADE_START_MS = 330
/** 指先から文字の中心までの高さ（手の大きさに対する比率）。炎（手の大きさ × 0.9 の高さ）の先端より少し上 */
export const SNAP_TEXT_OFFSET = 1.15
/** 同時に表示する上限（複数人・連続成功でも増え続けない） */
const MAX_BURSTS = 6
const SPARKS = 7
const RAYS = 10

type Burst = {
  handKey: string | null
  /** 文字の中心 */
  center: Point2
  /** 文字の大きさの基準 px（手の大きさ） */
  size: number
  startedAt: number
  seed: number
}

export type SnapBurstView = { handKey: string | null; center: Point2; scale: number; alpha: number; ageMs: number }

/** 0 → 1 の時間に対する文字の大きさ：小さく出て勢いよく行き過ぎ、少し戻ってから、ゆっくり大きくなる */
export function snapScale(ageMs: number): number {
  if (ageMs <= 0) return 0.3
  if (ageMs < POP_MS) {
    const t = ageMs / POP_MS
    // easeOutBack（行き過ぎてから戻る）
    const c = 1.9
    return 0.3 + 0.9 * (1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2)
  }
  return 1.2 + 0.15 * Math.min((ageMs - POP_MS) / (SNAP_TEXT_MS - POP_MS), 1)
}

/** 不透明度：FADE_START_MS まで 1、そこから SNAP_TEXT_MS で 0 */
export function snapAlpha(ageMs: number): number {
  if (ageMs < 0 || ageMs >= SNAP_TEXT_MS) return 0
  if (ageMs <= FADE_START_MS) return 1
  return 1 - (ageMs - FADE_START_MS) / (SNAP_TEXT_MS - FADE_START_MS)
}

export class SnapBurstEffect {
  private bursts: Burst[] = []

  /**
   * 成功した手の人差し指の先端 tip（表示座標。左右反転は手のランドマークに適用済み）と手の大きさから出す。
   * 同じ手の前の表示は置き換える。
   */
  spawn(tip: Point2, handScale: number, now: number, handKey: string | null = null): void {
    const size = Math.max(handScale, 24)
    this.bursts = this.bursts.filter((b) => !(handKey !== null && b.handKey === handKey))
    this.bursts.push({
      handKey,
      center: { x: tip.x, y: tip.y - size * SNAP_TEXT_OFFSET },
      size,
      startedAt: now,
      seed: Math.random() * 1000,
    })
    if (this.bursts.length > MAX_BURSTS) this.bursts = this.bursts.slice(-MAX_BURSTS)
  }

  update(now: number): void {
    this.bursts = this.bursts.filter((b) => now - b.startedAt < SNAP_TEXT_MS)
  }

  /** 表示中の SNAP!（テスト・デバッグ用） */
  active(now: number): SnapBurstView[] {
    return this.bursts
      .filter((b) => now >= b.startedAt && now - b.startedAt < SNAP_TEXT_MS)
      .map((b) => {
        const ageMs = now - b.startedAt
        return { handKey: b.handKey, center: b.center, scale: snapScale(ageMs), alpha: snapAlpha(ageMs), ageMs }
      })
  }

  clear(): void {
    this.bursts = []
  }

  draw(ctx: CanvasRenderingContext2D, now: number): void {
    for (const b of this.bursts) {
      const age = now - b.startedAt
      const alpha = snapAlpha(age)
      if (alpha <= 0) continue
      drawBurst(ctx, b, age, snapScale(age), alpha)
    }
  }
}

function drawBurst(ctx: CanvasRenderingContext2D, b: Burst, age: number, scale: number, alpha: number) {
  const { x, y } = b.center
  const s = b.size * 0.55 * scale
  const t = Math.min(age / SNAP_TEXT_MS, 1)
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(x, y)
  ctx.rotate(-0.12)

  // 衝撃線：中心から外へ広がる短い線（時間とともに外へ移動）
  ctx.strokeStyle = '#ffb300'
  ctx.lineCap = 'round'
  ctx.lineWidth = Math.max(s * 0.07, 1.5)
  ctx.beginPath()
  for (let i = 0; i < RAYS; i++) {
    const a = (i / RAYS) * Math.PI * 2 + b.seed
    const r0 = s * (1.25 + t * 0.6)
    const r1 = r0 + s * (0.35 + 0.25 * ((i * 7) % 3) / 2) * (1 - t * 0.5)
    ctx.moveTo(Math.cos(a) * r0 * 1.35, Math.sin(a) * r0)
    ctx.lineTo(Math.cos(a) * r1 * 1.35, Math.sin(a) * r1)
  }
  ctx.stroke()

  // ギザギザの吹き出し（黄色、オレンジの縁）
  ctx.beginPath()
  const points = 14
  for (let i = 0; i <= points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2
    const r = i % 2 === 0 ? s * 1.18 : s * (0.86 + 0.08 * Math.sin(i * 1.7 + b.seed))
    const px = Math.cos(a) * r * 1.45
    const py = Math.sin(a) * r
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  ctx.fillStyle = '#ffe14d'
  ctx.fill()
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(s * 0.08, 1.5)
  ctx.strokeStyle = '#ff7a00'
  ctx.stroke()

  // 文字：太い斜体、濃い縁取り → オレンジの縁 → 黄〜白のグラデーション
  const fontPx = Math.max(Math.round(s * 0.78), 10)
  ctx.font = `italic 900 ${fontPx}px "Arial Black", "Hiragino Sans", system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = Math.max(fontPx * 0.24, 2)
  ctx.strokeStyle = '#5a1e00'
  ctx.strokeText('SNAP!', 0, 0)
  ctx.lineWidth = Math.max(fontPx * 0.1, 1)
  ctx.strokeStyle = '#ff5a00'
  ctx.strokeText('SNAP!', 0, 0)
  const g = ctx.createLinearGradient(0, -fontPx / 2, 0, fontPx / 2)
  g.addColorStop(0, '#fffbe0')
  g.addColorStop(0.45, '#ffd21f')
  g.addColorStop(1, '#ff8c00')
  ctx.fillStyle = g
  ctx.fillText('SNAP!', 0, 0)

  // 小さな火花：外へ飛び散る点
  ctx.fillStyle = '#fff3b0'
  for (let i = 0; i < SPARKS; i++) {
    const a = (i / SPARKS) * Math.PI * 2 + b.seed * 1.3
    const r = s * (1.1 + t * 1.4 + 0.2 * (i % 3))
    const size = Math.max(s * 0.07 * (1 - t), 0.8)
    ctx.beginPath()
    ctx.arc(Math.cos(a) * r * 1.35, Math.sin(a) * r, size, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}
