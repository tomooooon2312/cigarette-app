import { lighterNozzle } from './lighterDetector'
import type { PenDetection } from './penGeometry'

/** 本体に対するキャップ（金属部分）の長さの比率 */
const CAP_RATIO = 0.24

/**
 * 検出した長方形にライターの CG を重ねる（Canvas 2D で描画）。
 * 火口（キャップ側）は画面上で上にある端。検出の大きさ・角度に合わせて拡大縮小・回転する。
 */
export function drawLighter(ctx: CanvasRenderingContext2D, d: PenDetection, pressed: boolean): void {
  const { up } = lighterNozzle(d)
  const L = d.length
  const W = d.thickness
  ctx.save()
  ctx.translate(d.center.x, d.center.y)
  // ローカル座標：-y 方向が火口（キャップ）側
  ctx.rotate(Math.atan2(up.y, up.x) + Math.PI / 2)
  const top = -L / 2
  const capH = L * CAP_RATIO
  const bodyTop = top + capH

  // 本体（半透明の樹脂）
  const body = ctx.createLinearGradient(-W / 2, 0, W / 2, 0)
  body.addColorStop(0, '#7a0d12')
  body.addColorStop(0.35, '#d9262e')
  body.addColorStop(0.55, '#ff6b6b')
  body.addColorStop(1, '#8c1016')
  ctx.fillStyle = body
  roundRect(ctx, -W / 2, bodyTop, W, L - capH, Math.min(W * 0.25, 8))
  ctx.fill()

  // 中の燃料（液面）
  ctx.fillStyle = 'rgba(255, 220, 180, 0.18)'
  ctx.fillRect(-W * 0.32, bodyTop + (L - capH) * 0.35, W * 0.64, (L - capH) * 0.6)

  // 金属のキャップ
  const metal = ctx.createLinearGradient(-W / 2, 0, W / 2, 0)
  metal.addColorStop(0, '#6d7177')
  metal.addColorStop(0.4, '#e9ecef')
  metal.addColorStop(0.6, '#c3c8ce')
  metal.addColorStop(1, '#5c6066')
  ctx.fillStyle = metal
  roundRect(ctx, -W / 2, top, W, capH, Math.min(W * 0.15, 5))
  ctx.fill()
  // キャップの穴
  ctx.fillStyle = 'rgba(30, 30, 35, 0.6)'
  for (let i = 0; i < 3; i++) {
    ctx.beginPath()
    ctx.arc(-W * 0.22 + i * W * 0.22, top + capH * 0.6, Math.max(W * 0.05, 1), 0, Math.PI * 2)
    ctx.fill()
  }

  // ヤスリ（ホイール）と押しボタン
  ctx.fillStyle = '#3b3d40'
  roundRect(ctx, W * 0.05, top - capH * 0.12, W * 0.38, capH * 0.4, 3)
  ctx.fill()
  ctx.fillStyle = pressed ? '#1f1f1f' : '#2c2c2c'
  roundRect(ctx, -W * 0.45, bodyTop - capH * (pressed ? 0.12 : 0.25), W * 0.5, capH * 0.35, 3)
  ctx.fill()

  // 本体のハイライト
  ctx.fillStyle = 'rgba(255, 255, 255, 0.18)'
  ctx.fillRect(-W * 0.2, bodyTop + 4, W * 0.08, L - capH - 8)
  ctx.restore()
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}
