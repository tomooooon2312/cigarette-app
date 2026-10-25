import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CameraSwitcher, cameraConstraints, defaultMirror } from '../src/lib/cameraSwitcher.ts'
import { FLAME_LOST_HOLD_MS, FireController, DEFAULT_FIRE, type FireFrameInput } from '../src/lib/fireController.ts'
import type { TrackedHand } from '../src/lib/handTracker.ts'
import { composePhoto, photoFileName, photoSize, videoTransform, type ComposeStep } from '../src/lib/photoCapture.ts'
import { FILTERS, FILTER_IDS, applyFilter, cssFilter, filterAffine, vignetteCss } from '../src/lib/photoFilters.ts'
import { blobToBase64, savePhoto, type SaveDeps } from '../src/lib/photoSaver.ts'
import type { HandSample } from '../src/lib/snapDetector.ts'

/** トラックを止めたかを記録する、偽の MediaStream */
function fakeStream(name: string) {
  const track = { stopped: false, stop() { this.stopped = true } }
  return { name, track, getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream & { name: string; track: { stopped: boolean } }
}

describe('カメラの切り替え（CameraSwitcher）', () => {
  it('今のカメラを止めてから、目的の向きのカメラを開く', async () => {
    const asked: string[] = []
    const old = fakeStream('front')
    const sw = new CameraSwitcher(async (c) => {
      asked.push(String((c.video as MediaTrackConstraints).facingMode))
      assert.equal(old.track.stopped, true, '新しいカメラを開く前に止める（iOS は同時に 1 つだけ）')
      return fakeStream('back')
    })
    const r = await sw.switchTo('environment', { stream: old, facing: 'user' })
    assert.deepEqual(asked, ['environment'])
    assert.equal(r!.facing, 'environment')
    assert.equal(r!.restored, false)
    assert.equal((r!.stream as unknown as { name: string }).name, 'back')
  })

  it('目的のカメラを開けなければ、元のカメラに戻す', async () => {
    const sw = new CameraSwitcher(async (c) => {
      if ((c.video as MediaTrackConstraints).facingMode === 'environment') throw new Error('NotFoundError')
      return fakeStream('front-again')
    })
    const r = await sw.switchTo('environment', { stream: fakeStream('front'), facing: 'user' })
    assert.equal(r!.facing, 'user')
    assert.equal(r!.restored, true)
  })

  it('元のカメラにも戻せなければ例外（呼び出し側でカメラを止める）', async () => {
    const sw = new CameraSwitcher(async () => {
      throw new Error('NotReadableError')
    })
    await assert.rejects(sw.switchTo('environment', { stream: fakeStream('front'), facing: 'user' }))
    assert.equal(sw.busy, false, '失敗しても次の切り替えを受け付ける')
  })

  it('切り替え中に連打されても、カメラは 1 回しか開かない', async () => {
    let calls = 0
    const releases: (() => void)[] = []
    const sw = new CameraSwitcher(
      () =>
        new Promise((resolve) => {
          calls++
          releases.push(() => resolve(fakeStream('back')))
        }),
    )
    const first = sw.switchTo('environment', { stream: fakeStream('front'), facing: 'user' })
    // 2 回目・3 回目は待たずにすぐ null が返る（切り替え中は何もしない）
    const pendingOrNull = (p: Promise<unknown>) => Promise.race([p, new Promise((r) => setTimeout(() => r('待ち続けている'), 20))])
    assert.equal(await pendingOrNull(sw.switchTo('environment', { stream: null, facing: 'user' })), null)
    assert.equal(await pendingOrNull(sw.switchTo('user', { stream: null, facing: 'environment' })), null)
    releases.forEach((r) => r())
    assert.ok(await first)
    assert.equal(calls, 1)
  })

  it('左右反転の既定：インカメラは反転、アウトカメラは反転しない。要求の解像度は従来と同じ', () => {
    assert.equal(defaultMirror('user'), true)
    assert.equal(defaultMirror('environment'), false)
    const v = cameraConstraints('environment').video as MediaTrackConstraints
    assert.deepEqual([v.facingMode, v.width, v.height], ['environment', { ideal: 1280 }, { ideal: 720 }])
  })
})

describe('フィルター（photoFilters）', () => {
  it('Normal は何も変えない（CSS も none）', () => {
    const data = new Uint8ClampedArray([10, 200, 30, 255, 250, 5, 128, 255])
    applyFilter(data, 'normal')
    assert.deepEqual([...data], [10, 200, 30, 255, 250, 5, 128, 255])
    assert.equal(cssFilter('normal'), 'none')
    assert.equal(vignetteCss('normal'), null)
  })

  it('Noir はモノクロ（R = G = B）で、コントラストが強い', () => {
    const data = new Uint8ClampedArray([200, 40, 40, 255, 40, 40, 200, 255, 128, 128, 128, 255])
    applyFilter(data, 'noir')
    for (let i = 0; i < data.length; i += 4) {
      assert.ok(Math.abs(data[i] - data[i + 1]) <= 1 && Math.abs(data[i + 1] - data[i + 2]) <= 1, `${[...data.slice(i, i + 3)]}`)
    }
    // 中間の灰色（128）は、コントラスト 1.55・明るさ 0.9 で少し暗くなる
    assert.ok(Math.abs(data[8] - Math.round(((128 / 255 - 0.5) * 1.55 + 0.5) * 0.9 * 255)) <= 1)
  })

  it('Sepia は茶色（R ≥ G ≥ B）に寄る。Vintage は彩度が下がる', () => {
    const data = new Uint8ClampedArray([60, 120, 220, 255])
    applyFilter(data, 'sepia')
    assert.ok(data[0] >= data[1] && data[1] >= data[2], `${[...data]}`)
    const v = new Uint8ClampedArray([230, 40, 40, 255])
    applyFilter(v, 'vintage')
    const sat = (r: number, g: number, b: number) => (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(r, g, b)
    assert.ok(sat(v[0], v[1], v[2]) < sat(230, 40, 40))
  })

  it('画素の変換は、CSS の filter と同じパラメータを同じ順にかけた結果（1 つの行列にまとめても同じ）', () => {
    for (const id of FILTER_IDS) {
      const ops = FILTERS[id].ops
      // CSS の文字列は ops から作る（表示と写真で同じ値）
      assert.equal(cssFilter(id), ops.length ? ops.map((o) => `${o.kind}(${o.amount})`).join(' ') : 'none')
      // 1 つずつかけた結果と、まとめた行列の結果が同じ（色の範囲の中の値で確認）
      const { m, b } = filterAffine(id)
      const rgb = [0.4, 0.5, 0.6]
      let step = [...rgb]
      for (const op of ops) {
        const single = filterAffineOf(op)
        step = [0, 1, 2].map((r) => single.m[r * 3] * step[0] + single.m[r * 3 + 1] * step[1] + single.m[r * 3 + 2] * step[2] + single.b[r])
      }
      const all = [0, 1, 2].map((r) => m[r * 3] * rgb[0] + m[r * 3 + 1] * rgb[1] + m[r * 3 + 2] * rgb[2] + b[r])
      all.forEach((x, i) => assert.ok(Math.abs(x - step[i]) < 1e-9, `${id}`))
    }
  })
})

/** テスト用：1 つの関数だけのフィルターの行列（FILTERS に 1 要素だけの定義を足して求める） */
function filterAffineOf(op: (typeof FILTERS)['sepia']['ops'][number]) {
  const key = '__single' as never
  ;(FILTERS as Record<string, unknown>)[key] = { label: '', ops: [op], vignette: 0 }
  try {
    return filterAffine(key)
  } finally {
    delete (FILTERS as Record<string, unknown>)[key]
  }
}

/** 描画の呼び出しを記録する偽の canvas */
function fakeCanvas(log: string[]) {
  const ctx = {
    save: () => log.push('save'),
    restore: () => log.push('restore'),
    setTransform: (...a: number[]) => log.push(`setTransform(${a.join(',')})`),
    drawImage: (src: { name?: string }, ...a: number[]) => log.push(`drawImage(${src.name ?? 'src'},${a.join(',')})`),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(128) }),
    putImageData: () => log.push('putImageData'),
    translate: () => {},
    scale: () => {},
    fillRect: () => log.push('vignette'),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    fillStyle: '',
  }
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement
}

describe('写真の合成（photoCapture）', () => {
  it('表示と保存で共通の変換：ミラーなら左右反転（x → width − x）', () => {
    const [a, , , d, e] = videoTransform(640, true)
    assert.deepEqual([a, d, e], [-1, 1, 640])
    assert.deepEqual(videoTransform(640, false), [1, 0, 0, 1, 0, 0])
  })

  it('写真の大きさは映像と同じ縦横比（長い辺は 1920px まで）', () => {
    assert.deepEqual(photoSize(1280, 720, 1920), { width: 1280, height: 720 })
    assert.deepEqual(photoSize(2160, 3840, 1920), { width: 1080, height: 1920 })
  })

  it('元映像 → フィルター → 周辺減光 → AR の順に合成し、AR は写真の大きさに合わせて重ねる', () => {
    const log: string[] = []
    const steps: ComposeStep[] = []
    const video = { name: 'video', videoWidth: 1280, videoHeight: 720 } as unknown as HTMLVideoElement
    const overlay = { name: 'overlay', width: 640, height: 360 } as unknown as HTMLCanvasElement
    const canvas = composePhoto({ video, overlay, mirror: true, filter: 'noir', createCanvas: () => fakeCanvas(log) }, steps)
    assert.deepEqual(steps, ['video', 'filter', 'vignette', 'overlay'])
    assert.deepEqual([canvas.width, canvas.height], [1280, 720])
    assert.ok(log.includes('setTransform(-1,0,0,1,1280,0)'), '映像は表示と同じくミラー')
    assert.ok(log.indexOf('drawImage(video,0,0,1280,720)') < log.indexOf('putImageData'))
    assert.equal(log.at(-1), 'drawImage(overlay,0,0,1280,720)', 'AR は最後（フィルターの上）')
  })

  it('Normal ではフィルター・周辺減光をかけない。カメラの映像が無ければ撮影できない', () => {
    const log: string[] = []
    const steps: ComposeStep[] = []
    const video = { name: 'video', videoWidth: 640, videoHeight: 480 } as unknown as HTMLVideoElement
    composePhoto({ video, overlay: null, mirror: false, filter: 'normal', createCanvas: () => fakeCanvas(log) }, steps)
    assert.deepEqual(steps, ['video', 'vignette'])
    assert.ok(!log.includes('putImageData') && !log.includes('vignette'))
    assert.throws(() => composePhoto({ video: { videoWidth: 0, videoHeight: 0 } as HTMLVideoElement, overlay: null, mirror: false, filter: 'normal', createCanvas: () => fakeCanvas([]) }))
  })

  it('ファイル名に日時を入れる', () => {
    assert.equal(photoFileName(new Date(2026, 9, 25, 9, 5, 7)), 'shibugarette_20261025_090507.jpg')
  })
})

describe('写真の保存（photoSaver）', () => {
  const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x41])], { type: 'image/jpeg' })
  const deps = (native: boolean, save: SaveDeps['saveToPhotos'] = async () => {}) => {
    const calls: string[] = []
    const d: SaveDeps = {
      isNative: () => native,
      saveToPhotos: async (b64) => {
        calls.push(`photos:${b64}`)
        return save(b64)
      },
      download: (_b, name) => calls.push(`download:${name}`),
      toBase64: blobToBase64,
    }
    return { d, calls }
  }

  it('iOS アプリでは写真アプリに保存する（base64 で渡す）', async () => {
    const { d, calls } = deps(true)
    assert.equal(await savePhoto(blob, 'a.jpg', d), 'photos')
    assert.deepEqual(calls, [`photos:${Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x41]).toString('base64')}`])
  })

  it('Web 版ではダウンロードする', async () => {
    const { d, calls } = deps(false)
    assert.equal(await savePhoto(blob, 'a.jpg', d), 'download')
    assert.deepEqual(calls, ['download:a.jpg'])
  })

  it('写真への追加が許可されていないときは、設定の場所を案内する', async () => {
    const { d } = deps(true, async () => {
      throw Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' })
    })
    await assert.rejects(savePhoto(blob, 'a.jpg', d), /設定 → シブガレット → 写真/)
  })
})

/** 人差し指の先端（indexTip）と親指の先端。press でくっつけ、snapped で離すと着火ジェスチャーになる */
function hand(phase: 'press' | 'snapped' | 'open', at: { x: number; y: number }, time: number, key = 'right'): TrackedHand {
  const p = (x: number, y: number) => ({ x: at.x + x, y: at.y + y })
  // STEP 10：着火ジェスチャーは親指と人差し指。press で人差し指の先端を親指の先端にくっつける
  const sample: HandSample = {
    time,
    thumbTip: p(-60, -55),
    wrist: p(0, 60),
    indexMcp: p(-30, -40),
    pinkyMcp: p(35, -30),
    indexTip: phase === 'press' ? p(-58, -52) : p(-40, -150),
    scale: 100,
  }
  return { key, side: 'right', landmarks: [], sample, sampleId: 0 }
}
const FRAME = 33
function input(now: number, hands: TrackedHand[]): FireFrameInput {
  return {
    now,
    frameWidth: 640,
    frameHeight: 480,
    hands,
    handsFresh: true,
    lighterMeasured: null,
    lighterPressed: false,
    manualFlameRequested: false,
    cigarette: null,
    settings: { ...DEFAULT_FIRE, lighterEnabled: false },
  }
}
function snapAt(fire: FireController, at: { x: number; y: number }) {
  let t = 0
  for (let i = 0; i < 4; i++) fire.update(input((t += FRAME), [hand('press', at, t)]))
  const out = fire.update(input((t += FRAME), [hand('snapped', at, t)]))
  return { out, t }
}

describe('人差し指の先端の炎（FireController）', () => {
  it('指パッチンの炎は人差し指の先端に出て、指先に追従する（炎の位置と着火判定の位置は同じ炎のもの）', () => {
    const fire = new FireController()
    const { out, t } = snapAt(fire, { x: 300, y: 300 })
    assert.equal(out.flames.length, 1)
    // 炎の着火判定の位置は、炎の根元（人差し指の先端）から炎の高さの 45% 上（描画している炎の胴体）
    const size = out.flames[0].size
    assert.ok(Math.abs(out.flames[0].position.x - 260) < 1e-6 && Math.abs(out.flames[0].position.y - (150 - size * 0.45)) < 1e-6)
    const moved = fire.update(input(t + FRAME, [hand('open', { x: 340, y: 320 }, t + FRAME)]))
    assert.ok(Math.abs(moved.flames[0].position.x - 300) < 1e-6, '指先に追従')
    assert.ok(Math.abs(size - 90) < 1e-6, '炎の大きさは手の大きさ（100px）の 0.9 倍')
  })

  it('別の手の指先へ急に飛び移らない（1 フレームで手の大きさの 1.5 倍以上動いたら追従しない）', () => {
    const fire = new FireController()
    const { t } = snapAt(fire, { x: 300, y: 300 })
    const jumped = fire.update(input(t + FRAME, [hand('open', { x: 600, y: 100 }, t + FRAME)]))
    assert.ok(Math.abs(jumped.flames[0].position.x - 260) < 1e-6, '元の位置に残る')
  })

  it('手を見失ったら短時間だけ位置を保持し、その後フェードアウトして消える', () => {
    const fire = new FireController()
    const { t } = snapAt(fire, { x: 300, y: 300 })
    const held = fire.update(input(t + FLAME_LOST_HOLD_MS - 50, []))
    assert.equal(held.flames.length, 1)
    assert.equal(held.flames[0].intensity, 1, '保持中は薄くならない')
    const fading = fire.update(input(t + FLAME_LOST_HOLD_MS + 100, []))
    assert.ok(fading.flames.length === 0 || fading.flames[0].intensity < 1)
    const gone = fire.update(input(t + FLAME_LOST_HOLD_MS + 600, []))
    assert.equal(gone.flames.length, 0)
  })
})
