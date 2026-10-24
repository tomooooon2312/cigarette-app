import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_SNAP,
  SNAP_TIMING,
  SnapDetector,
  type HandSample,
  type SnapEvent,
} from '../src/lib/snapDetector.ts'

type P = { x: number; y: number }
const S = DEFAULT_SNAP

/**
 * 合成した手の姿勢。手のひらは (cx, cy) 付近、手の大きさ 100px。
 * side = 1 は右手、-1 は左手（x を左右反転）。
 * phase: 'open'（指を開いた）/ 'press'（親指と中指を押し付けた）/ 'snapped'（中指が手のひらを打った）/ 'pinchOpen'（つまんだ指を外へ開いた）
 */
function pose(phase: 'open' | 'press' | 'snapped' | 'pinchOpen', side = 1, offset: P = { x: 0, y: 0 }, time = 0): HandSample {
  const cx = 300 + offset.x
  const cy = 300 + offset.y
  const at = (x: number, y: number): P => ({ x: cx + side * x, y: cy + y })
  const wrist = at(0, 60)
  const indexMcp = at(-30, -40)
  const pinkyMcp = at(35, -30)
  const thumbTip = phase === 'pinchOpen' ? at(-85, -40) : at(-60, -55)
  const middleTip = {
    open: at(-5, -140),
    press: at(-55, -75), // 親指の先端から約 21px（0.21）
    snapped: at(-25, 15), // 手のひら側（親指の付け根付近）。親指から約 0.78
    pinchOpen: at(10, -150), // 手のひらから離れる方向
  }[phase]
  return { time, thumbTip, middleTip, wrist, indexMcp, pinkyMcp, scale: 100 }
}

/** fps で姿勢の列を流し、発生したイベントを返す */
function play(d: SnapDetector, frames: ((t: number) => HandSample)[], fps = 30, key = 'right', start = 0) {
  const events: SnapEvent[] = []
  frames.forEach((f, i) => {
    const t = start + (i * 1000) / fps
    const e = d.update(key, { ...f(t), time: t }, S)
    if (e) events.push(e)
  })
  return events
}

const repeat = <T,>(n: number, x: T) => Array.from({ length: n }, () => x)

describe('SnapDetector', () => {
  it('押し付け → 素早く弾いて中指が手のひらを打つ動きを、指パッチンと判定する（30fps）', () => {
    const d = new SnapDetector()
    const ev = play(d, [...repeat(5, () => pose('open')), ...repeat(4, () => pose('press')), () => pose('snapped'), ...repeat(5, () => pose('open'))])
    assert.equal(ev.length, 1)
    assert.deepEqual(ev[0].position, pose('snapped').thumbTip)
  })

  it('左手でも判定する', () => {
    const d = new SnapDetector()
    const ev = play(d, [...repeat(4, () => pose('press', -1)), () => pose('snapped', -1)], 30, 'left')
    assert.equal(ev.length, 1)
  })

  it('推論が 15fps でも判定する（弾いた瞬間が 1 フレームしか写らない）', () => {
    const d = new SnapDetector()
    const ev = play(d, [...repeat(3, () => pose('press')), () => pose('snapped')], 15)
    assert.equal(ev.length, 1)
  })

  it('指を開いたままでは判定しない', () => {
    const d = new SnapDetector()
    assert.equal(play(d, repeat(60, () => pose('open'))).length, 0)
  })

  it('押し付けたまま（つまんだまま）では判定しない', () => {
    const d = new SnapDetector()
    assert.equal(play(d, repeat(60, () => pose('press'))).length, 0)
  })

  it('1 フレームだけの接触（ノイズ）では判定しない', () => {
    const d = new SnapDetector()
    assert.equal(play(d, [() => pose('open'), () => pose('press'), () => pose('snapped')]).length, 0)
  })

  it('ゆっくり指を離す動きは判定しない（速さが足りない）', () => {
    const d = new SnapDetector()
    // 接触から 1 フレームずつ少しずつ手のひら側へ動かし、250ms を超えてから開き切る
    const press = pose('press')
    const snapped = pose('snapped')
    const slow = Array.from({ length: 12 }, (_, i) => () => {
      const k = (i + 1) / 12
      return { ...press, middleTip: { x: press.middleTip.x + (snapped.middleTip.x - press.middleTip.x) * k, y: press.middleTip.y + (snapped.middleTip.y - press.middleTip.y) * k } }
    })
    assert.equal(play(d, [...repeat(4, () => press), ...slow]).length, 0)
  })

  it('つまんだ指を外側（手のひらと反対）へ開く動きは判定しない', () => {
    const d = new SnapDetector()
    assert.equal(play(d, [...repeat(4, () => pose('press')), () => pose('pinchOpen')]).length, 0)
  })

  it('手全体を素早く振った動きは判定しない', () => {
    const d = new SnapDetector()
    const ev = play(d, [...repeat(4, () => pose('press')), () => pose('snapped', 1, { x: 150, y: 0 })])
    assert.equal(ev.length, 0)
  })

  it('クールダウン中の 2 回目は判定せず、クールダウン後は判定する', () => {
    const d = new SnapDetector()
    const snap = [...repeat(3, () => pose('press')), () => pose('snapped')]
    const first = play(d, snap, 30, 'right', 0)
    const second = play(d, snap, 30, 'right', 200)
    const third = play(d, snap, 30, 'right', 200 + SNAP_TIMING.cooldownMs + 200)
    assert.deepEqual([first.length, second.length, third.length], [1, 0, 1])
  })

  it('手を見失った後は途中経過を捨てる', () => {
    const d = new SnapDetector()
    play(d, repeat(4, () => pose('press')), 30, 'right', 0)
    const ev = play(d, [() => pose('snapped')], 30, 'right', 1000)
    assert.equal(ev.length, 0)
  })

  it('手の大きさで正規化する（同じ動きを 2.5 倍の大きさでも判定、遠くの小さな手でも判定）', () => {
    for (const k of [0.4, 2.5]) {
      const d = new SnapDetector()
      const scaleSample = (s: HandSample): HandSample => {
        const f = (p: P) => ({ x: p.x * k, y: p.y * k })
        return { ...s, thumbTip: f(s.thumbTip), middleTip: f(s.middleTip), wrist: f(s.wrist), indexMcp: f(s.indexMcp), pinkyMcp: f(s.pinkyMcp), scale: s.scale * k }
      }
      const ev = play(d, [...repeat(4, () => scaleSample(pose('press'))), () => scaleSample(pose('snapped'))])
      assert.equal(ev.length, 1, `k=${k}`)
    }
  })
})
