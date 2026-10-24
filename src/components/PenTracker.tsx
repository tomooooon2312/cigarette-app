import { useCallback, useEffect, useRef, useState } from 'react'
import { useOpenCv } from '../hooks/useOpenCv'
import {
  CG_LABELS,
  CigaretteRenderer,
  DEFAULT_CIGARETTE,
  type CgChoice,
  type CgKind,
  type CigarettePlacement,
  type CigaretteSettings,
} from '../lib/cigaretteRenderer'
import { DEFAULT_FIRE, FireController, type FireFrame, type FireSettings } from '../lib/fireController'
import type { ActiveFlame } from '../lib/flameEffect'
import { HAND_CONNECTIONS, HandTracker, type TrackedHand } from '../lib/handTracker'
import type { IgnitionOutput } from '../lib/ignition'
import { LighterDetector } from '../lib/lighterDetector'
import { drawLighter } from '../lib/lighterRenderer'
import { MouthTracker, type Mouth } from '../lib/mouthTracker'
import type { IdentifiedPen } from '../lib/multiPenTracker'
import { effectivePerf, loadLevel } from '../lib/performanceProfile'
import {
  BUILTIN_COLORS,
  activeColors,
  clientToCanvas,
  estimateColor,
  hsvToCss,
  loadColorSettings,
  saveColorSettings,
  type ColorEstimate,
  type ColorSettings,
  type PenColor,
} from '../lib/penColors'
import { DEFAULT_SHAPE, type ShapeSettings } from '../lib/penShape'
import {
  PersonController,
  SOLO_PERSON_ID,
  type PersonMode,
  type PersonView,
  type TrackFrame,
} from '../lib/personController'
import { describeCvError } from '../lib/opencv'
import {
  DEFAULT_SETTINGS,
  PenDetector,
  type DetectorSettings,
  type HsvRange,
  type PenDetection,
} from '../lib/penDetector'
import { DEFAULT_TRACKING, type TrackedPen, type TrackingSettings } from '../lib/penTracking'
import {
  DEFAULT_SMOKE,
  SMOKE_PRESETS,
  type SmokePresetId,
  type SmokeSettings,
  type SmokeSource,
  type SmokeStyle,
} from '../lib/smokeEffect'
import type { SmokeFsmOutput, SmokeState } from '../lib/smokeStateMachine'
import './PenTracker.css'

/** 元映像 / マスク（全色の和、白黒）/ 色マスク（STEP 6：色ごとに色分け） */
type ViewMode = 'camera' | 'mask' | 'colorMask'
/** 映像の上に重ねるもの：タバコ CG / 認識枠 / 両方 */
type OverlayMode = 'cg' | 'frame' | 'both'
type CameraStatus = 'idle' | 'starting' | 'running'
type FaceStatus = 'off' | 'loading' | 'ready' | 'error'

type Stats = {
  fps: number
  detection: TrackedPen | null
  frameWidth: number
  frameHeight: number
  mouthFound: boolean
  /** 吸い口と唇の中心の距離（顔の大きさで正規化）。顔かタバコが無ければ null */
  filterDistance: number | null
  pucker: number
  funnel: number
  smoke: SmokeFsmOutput | null
  /** STEP 4：着火・炎・ライター・手 */
  ignition: IgnitionOutput | null
  flames: ActiveFlame['source'][]
  lighterFound: boolean
  hands: number
  /** 親指と中指の距離（手の大きさで正規化、最初の手） */
  snapDistance: number | null
  /** STEP 5：複数人 */
  persons: PersonStat[]
  /** 口元が有効な顔の数・追跡中のペンの数 */
  facesVisible: number
  pensTracked: number
  /** STEP 6：追跡中のペンの色・形状スコア・CG の種類 */
  penList: { id: number; colorId: string | null; score: number | null; kind: CgKind | null; personId: number | null }[]
  /** 処理負荷の表示用：実測の推論頻度（回/秒）、煙の粒子数 */
  faceHz: number
  handHz: number
  particles: number
}

/** 人物ごとの状態（UI 表示用） */
type PersonStat = {
  id: number
  face: 'measured' | 'held' | 'lost'
  penId: number | null
  ignition: 'UNLIT' | 'LIT'
  smoke: SmokeState
  exhaleReady: boolean
  filterDistance: number | null
  ambiguous: boolean
  handOwner: number | null
}

/** 処理解像度の上限幅は performanceProfile（人数に応じて変える。1 人モードは 640） */
/** 「煙をテスト発生」で口元の煙を出す時間 ms */
const TEST_BURST_MS = 1200
/** React state への反映間隔（毎フレーム再レンダリングしないため） */
const UI_UPDATE_INTERVAL_MS = 100

const EMPTY_STATS: Stats = {
  fps: 0,
  detection: null,
  frameWidth: 0,
  frameHeight: 0,
  mouthFound: false,
  filterDistance: null,
  pucker: 0,
  funnel: 0,
  smoke: null,
  ignition: null,
  flames: [],
  lighterFound: false,
  hands: 0,
  snapDistance: null,
  persons: [],
  facesVisible: 0,
  pensTracked: 0,
  faceHz: 0,
  handHz: 0,
  particles: 0,
  penList: [],
}

/** 「画面をタップして色を登録」で推定した色（登録前に名前と範囲を編集する） */
type PendingColor = { estimate: ColorEstimate; name: string; hsv: HsvRange; at: { x: number; y: number } }

/** 人物ごとの表示色（デバッグ表示・バッジ） */
const PERSON_COLORS = ['#40c4ff', '#ff4081', '#b2ff59']
const personColor = (id: number) => PERSON_COLORS[(id - 1) % PERSON_COLORS.length]

export function PenTracker() {
  const { cv, status: cvStatus, error: cvError } = useOpenCv()

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const detectorRef = useRef<PenDetector | null>(null)
  /** タバコ CG の描画（指の切り抜きの記憶をペンごとに持つ。1 人モードは 1 つだけ） */
  const cigaretteRenderersRef = useRef(new Map<number, CigaretteRenderer>())
  const mouthTrackerRef = useRef<MouthTracker | null>(null)
  /** 「煙をテスト発生」で口元の煙を出し続ける終了時刻 */
  const testBurstUntilRef = useRef(0)
  /** STEP 5：顔・ペンの追跡 ID、対応付け、人物ごとの向き・煙の状態機械・煙の粒子 */
  const personsRef = useRef(new PersonController())
  const fireRef = useRef(new FireController())
  const handTrackerRef = useRef<HandTracker | null>(null)
  const lighterDetectorRef = useRef<LighterDetector | null>(null)
  /** 「ライター着火」ボタンを押している間 true */
  const lighterPressedRef = useRef(false)
  /** 「指先に炎を出す」が押された（描画ループで 1 回だけ処理する） */
  const manualFlameRef = useRef(false)
  // start/stop のたびに進める世代番号。非同期処理が古いセッションに属するかの判定に使う
  const sessionRef = useRef(0)

  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<DetectorSettings>(DEFAULT_SETTINGS)
  const [tracking, setTracking] = useState<TrackingSettings>(DEFAULT_TRACKING)
  const [viewMode, setViewMode] = useState<ViewMode>('camera')
  const [overlay, setOverlay] = useState<OverlayMode>('cg')
  const [cigarette, setCigarette] = useState<CigaretteSettings>(DEFAULT_CIGARETTE)
  const [smoke, setSmoke] = useState<SmokeSettings>(DEFAULT_SMOKE)
  // 読み込み結果のみを state に持ち、「読み込み中 / 停止中」は描画時に導出する
  const [faceResult, setFaceResult] = useState<
    { status: 'ready'; error: null } | { status: 'error'; error: string } | null
  >(null)
  const [fire, setFire] = useState<FireSettings>(DEFAULT_FIRE)
  const [handResult, setHandResult] = useState<
    { status: 'ready'; error: null } | { status: 'error'; error: string } | null
  >(null)
  const [lighterPressed, setLighterPressed] = useState(false)
  const [mirror, setMirror] = useState(true)
  // STEP 6：ペンの色（ブラウザに保存）と形状判定
  const [colorSettings, setColorSettings] = useState<ColorSettings>(loadColorSettings)
  const [shape, setShape] = useState<ShapeSettings>(DEFAULT_SHAPE)
  /** タップで色を拾うモード */
  const [picking, setPicking] = useState(false)
  const [pendingColor, setPendingColor] = useState<PendingColor | null>(null)
  const [personMode, setPersonMode] = useState<PersonMode>(1)
  const [autoPerf, setAutoPerf] = useState(true)
  const [stats, setStats] = useState<Stats>(EMPTY_STATS)

  // 描画ループからは ref 経由で最新値を読む（ループを張り直さないため）
  const settingsRef = useRef(settings)
  const trackingRef = useRef(tracking)
  const viewModeRef = useRef(viewMode)
  const overlayRef = useRef(overlay)
  const cigaretteSettingsRef = useRef(cigarette)
  const smokeSettingsRef = useRef(smoke)
  const fireSettingsRef = useRef(fire)
  const mirrorRef = useRef(mirror)
  const personModeRef = useRef(personMode)
  const autoPerfRef = useRef(autoPerf)
  const colorSettingsRef = useRef(colorSettings)
  const shapeRef = useRef(shape)
  /** 直近のカメラフレーム（ミラー後・CG を描く前）。タップした位置の色を拾うのに使う */
  const lastFrameRef = useRef<ImageData | null>(null)
  const dirtyRef = useRef(true)
  useEffect(() => {
    settingsRef.current = settings
    trackingRef.current = tracking
    viewModeRef.current = viewMode
    overlayRef.current = overlay
    cigaretteSettingsRef.current = cigarette
    smokeSettingsRef.current = smoke
    fireSettingsRef.current = fire
    personModeRef.current = personMode
    autoPerfRef.current = autoPerf
    colorSettingsRef.current = colorSettings
    shapeRef.current = shape
    dirtyRef.current = true
  }, [settings, tracking, viewMode, overlay, cigarette, smoke, fire, personMode, autoPerf, colorSettings, shape])
  // 色の設定（カスタム色・各色の範囲・認識モード）はブラウザに保存する
  useEffect(() => saveColorSettings(colorSettings), [colorSettings])

  /**
   * 顔・ペン・人物の追跡をすべて捨てる。着火状態は 1 人モードの人物だけ残し（STEP 4 と同じ）、
   * 複数人モードの人物の着火状態は人物 ID と一緒に捨てる（同じ ID は再利用しないため、残しても使われない）。
   */
  const resetPeople = useCallback(() => {
    for (const id of personsRef.current.reset()) {
      if (id !== SOLO_PERSON_ID || personModeRef.current !== 1) fireRef.current.forget(String(id))
    }
    cigaretteRenderersRef.current.clear()
  }, [])

  useEffect(() => {
    mirrorRef.current = mirror
    dirtyRef.current = true
    // 反転を切り替えると座標系が変わるため、追跡状態を引き継がない
    resetPeople()
    handTrackerRef.current?.reset()
    fireRef.current.resetTracking()
  }, [mirror, resetPeople])

  const stopCamera = useCallback(() => {
    sessionRef.current += 1
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null

    const video = videoRef.current
    if (video) {
      video.pause()
      video.srcObject = null
    }
    const canvas = canvasRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)

    detectorRef.current?.dispose()
    detectorRef.current = null
    lighterDetectorRef.current?.dispose()
    lighterDetectorRef.current = null
    fireRef.current.resetTracking()
    lighterPressedRef.current = false
    setLighterPressed(false)
    resetPeople()
    setCameraStatus('idle')
    setStats(EMPTY_STATS)
  }, [resetPeople])

  const startCamera = useCallback(async () => {
    if (!cv || streamRef.current) return
    const session = ++sessionRef.current
    const isCurrent = () => session === sessionRef.current
    setError(null)
    setCameraStatus('starting')

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          'このブラウザはカメラAPIに対応していません（HTTPS または localhost で開いてください）',
        )
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      })
      if (!isCurrent()) {
        // 待機中に停止・アンマウントされた
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (!isCurrent()) return
        stopCamera()
        setError('カメラが切断されました')
      })

      const video = videoRef.current
      if (!video) throw new Error('video 要素が見つかりません')
      video.srcObject = stream
      await video.play()
      if (!isCurrent()) return

      detectorRef.current = new PenDetector(cv)
      lighterDetectorRef.current = new LighterDetector(cv)
      dirtyRef.current = true
      setCameraStatus('running')
    } catch (e) {
      if (!isCurrent()) return
      stopCamera()
      setError(cameraErrorMessage(e))
      return
    }

    let lastVideoTime = -1
    let fpsFrames = 0
    let fpsStartedAt = performance.now()
    let fps = 0
    let lastUiUpdate = 0
    // 推論頻度の実測（処理負荷の表示用）
    let faceSamples = 0
    let handSamples = 0
    let faceHz = 0
    let handHz = 0

    const renderFrame = (now: number) => {
      const video = videoRef.current
      const canvas = canvasRef.current
      const detector = detectorRef.current
      if (!video || !canvas || !detector) return
      if (video.readyState < video.HAVE_CURRENT_DATA || video.videoWidth === 0) return
      // 新しいカメラフレームも設定変更も無ければ処理を省略
      if (video.currentTime === lastVideoTime && !dirtyRef.current) return
      lastVideoTime = video.currentTime
      dirtyRef.current = false

      const mode = personModeRef.current
      const smokeSettings = smokeSettingsRef.current
      const cigaretteSettings = cigaretteSettingsRef.current
      const fireSettings = fireSettingsRef.current
      // STEP 5：人数に応じて処理解像度と推論間隔を調整する（1 人モードは従来どおり）
      const perf = effectivePerf(mode, autoPerfRef.current, smokeSettings.inferenceIntervalMs, fireSettings.handIntervalMs)
      const scale = Math.min(1, perf.maxProcessWidth / video.videoWidth)
      const width = Math.round(video.videoWidth * scale)
      const height = Math.round(video.videoHeight * scale)
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return

      // ミラーした映像そのものを解析するので、検出座標はそのまま表示座標として使える
      ctx.save()
      if (mirrorRef.current) {
        ctx.translate(width, 0)
        ctx.scale(-1, 1)
      }
      ctx.drawImage(video, 0, 0, width, height)
      ctx.restore()

      // 手の推論はペン検出より先に行う（STEP 6：手の近くの細長い物体をペンとして優先するため）
      let hands: TrackedHand[] = []
      let handsFresh = false
      const handTracker = handTrackerRef.current
      if (handTracker && handsWanted(fireSettingsRef.current, shapeRef.current)) {
        try {
          const result = handTracker.update(video, now, width, height, mirrorRef.current, perf.handIntervalMs)
          hands = result.hands
          handsFresh = result.fresh
          if (result.fresh) handSamples++
        } catch (e) {
          // 手の推論の失敗でペン検出・CG 合成まで止めない
          handTracker.close()
          handTrackerRef.current = null
          setHandResult({ status: 'error', error: e instanceof Error ? e.message : String(e) })
        }
      }


      // ペン：HSV 変換は 1 回だけ行い、認識する色ごとにマスク・輪郭抽出・結合・形状判定をして、最大で人数分を検出する
      const frameImage = ctx.getImageData(0, 0, width, height)
      lastFrameRef.current = frameImage
      const colors = activeColors(colorSettingsRef.current)
      const colored = detector.detectColors(frameImage, settingsRef.current, colors, mode, {
        shape: shapeRef.current,
        hands: hands.map((h) => ({ points: h.landmarks, scale: h.sample.scale })),
      })
      const measuredPens = colored.map((c) => c.pen)
      const penInfo = colored.map((c) => ({ colorId: c.colorId, score: c.score?.total ?? null }))
      // ライター：ペン検出で作った HSV 画像を共有し、ペンの画素（全色のマスク）を除外して長方形を探す
      const lighterDetector = lighterDetectorRef.current
      const lighterMeasured =
        fireSettings.lighterEnabled && lighterDetector && detector.hsv
          ? lighterDetector.detect(detector.hsv, detector.mask, fireSettings.lighter)
          : null
      if (viewModeRef.current === 'mask' && detector.mask) {
        cv.imshow(canvas, detector.mask)
      } else if (viewModeRef.current === 'colorMask') {
        const overlay = detector.colorMaskImage(colors)
        if (overlay) cv.imshow(canvas, overlay)
      }
      // 顔推論は CG を描く前に行う（タバコの向きを先に決めるため）
      let mouths: Mouth[] = []
      let mouthsFresh = false
      const mouthTracker = mouthTrackerRef.current
      if (mouthTracker) {
        try {
          const result = mouthTracker.update(video, now, width, height, mirrorRef.current, perf.faceIntervalMs)
          mouths = result.mouths
          mouthsFresh = result.fresh
          if (result.fresh) faceSamples++
        } catch (e) {
          // 顔検出の失敗でペン検出・CG 合成まで止めない
          mouthTracker.close()
          mouthTrackerRef.current = null
          setFaceResult({ status: 'error', error: e instanceof Error ? e.message : String(e) })
        }
      }
      // 顔・ペンの追跡 ID、ペンと人物の対応付け、人物ごとのタバコの向きと CG の配置
      const overlayMode = overlayRef.current
      const people = personsRef.current
      const frame = people.track({
        now,
        mode,
        measuredPens,
        penInfo,
        mouths,
        mouthsFresh,
        hands,
        tracking: trackingRef.current,
        cigarette: cigaretteSettings,
        showCigarette: overlayMode !== 'frame',
      })
      for (const id of frame.removedPersonIds) fireRef.current.forget(String(id))

      // 炎と着火：指パッチン・ライター・手動の炎と、人物ごとのタバコの火側の端の距離から UNLIT / LIT を決める
      const manualFlameRequested = manualFlameRef.current
      manualFlameRef.current = false
      const fireFrame: FireFrame = fireRef.current.update({
        now,
        frameWidth: width,
        frameHeight: height,
        hands,
        handsFresh,
        lighterMeasured,
        lighterPressed: lighterPressedRef.current,
        manualFlameRequested,
        cigarettes: frame.persons
          .filter((p) => p.placement)
          .map((p) => ({
            key: String(p.id),
            emberEnd: p.placement!.emberEnd,
            mouthEnd: p.placement!.mouthEnd,
            length: p.placement!.length,
          })),
        settings: fireSettings,
      })
      const isLit = (personId: number) => fireFrame.ignitions.get(String(personId))?.state === 'LIT'

      // 重ね順：元映像 → タバコ CG → ライター CG → 炎 → 煙 → 認識枠・デバッグ表示
      const renderers = cigaretteRenderersRef.current
      const rendererKey = (pen: IdentifiedPen) => (mode === 1 ? 0 : pen.id)
      if (mode !== 1) {
        const keys = new Set(frame.pens.map(rendererKey))
        for (const key of [...renderers.keys()]) if (!keys.has(key)) renderers.delete(key)
      }
      const drawCigarette = (pen: IdentifiedPen, emberDir: PersonView['emberDir'], lit: boolean, kind: CgKind) => {
        let renderer = renderers.get(rendererKey(pen))
        if (!renderer) {
          renderer = new CigaretteRenderer()
          renderers.set(rendererKey(pen), renderer)
        }
        renderer.draw(ctx, pen, cigaretteSettings, now, emberDir, lit, kind)
      }
      if (overlayMode !== 'frame') {
        for (const p of frame.persons) if (p.pen) drawCigarette(p.pen, p.emberDir, isLit(p.id), p.kind ?? 'cigarette')
        // 人物に対応付けられないペン：未着火のタバコとして描く（着火・煙の対象にしない）
        for (const u of frame.unassigned) drawCigarette(u.pen, u.emberDir, false, u.kind)
      }
      if (fireFrame.lighter && overlayMode !== 'frame') drawLighter(ctx, fireFrame.lighter, lighterPressedRef.current)
      fireRef.current.draw(ctx, now)

      // 煙：人物ごとの状態機械が発生源を 1 つだけ選び、その人物の粒子として出す（未着火なら出さない）
      const smokes = people.updateSmoke(frame, {
        now,
        frameWidth: width,
        frameHeight: height,
        settings: smokeSettings,
        isLit,
        testBurst: smokeSettings.enabled && now < testBurstUntilRef.current,
      })
      people.drawSmoke(ctx, smokeSettings)

      if (overlayMode !== 'cg') {
        for (const pen of frame.pens) drawDetection(ctx, pen, colorLabel(colorSettingsRef.current.colors, pen))
      }
      if (fireFrame.lighter && overlayMode !== 'cg') drawLighterFrame(ctx, fireFrame.lighter)
      if (smokeSettings.showDebug) {
        for (const p of frame.persons) {
          drawDebug(ctx, {
            mouth: p.face,
            placement: p.placement,
            smokeSource: smokes.find((x) => x.personId === p.id)?.source ?? null,
            settings: smokeSettings,
          })
        }
        if (mode !== 1) drawPersonDebug(ctx, frame)
        drawFireDebug(ctx, {
          hands,
          fire: fireFrame,
          placements: frame.persons.flatMap((p) => (p.placement ? [p.placement] : [])),
          igniteDistance: fireSettings.ignition.igniteDistance,
          snapDistance: (key) => fireRef.current.snap.debug(key)?.distance ?? null,
        })
      }

      fpsFrames++
      const elapsed = now - fpsStartedAt
      if (elapsed >= 1000) {
        fps = (fpsFrames * 1000) / elapsed
        faceHz = (faceSamples * 1000) / elapsed
        handHz = (handSamples * 1000) / elapsed
        fpsFrames = 0
        faceSamples = 0
        handSamples = 0
        fpsStartedAt = now
      }
      if (now - lastUiUpdate >= UI_UPDATE_INTERVAL_MS) {
        lastUiUpdate = now
        // 従来の表示項目は、代表の人物（1 人モードではその人物、複数人ではタバコを持つ最初の人物）の値
        const primary = frame.persons.find((p) => p.pen) ?? frame.persons[0] ?? null
        const smokeOf = (id: number): SmokeFsmOutput | null =>
          smokeSettings.enabled ? (smokes.find((x) => x.personId === id)?.state ?? null) : null
        setStats({
          fps,
          detection: primary?.pen ?? frame.unassigned[0]?.pen ?? null,
          frameWidth: width,
          frameHeight: height,
          mouthFound: primary?.face != null,
          filterDistance: primary?.filterDistance ?? null,
          pucker: primary?.face?.pucker ?? 0,
          funnel: primary?.face?.funnel ?? 0,
          smoke: primary ? smokeOf(primary.id) : null,
          ignition: primary ? (fireFrame.ignitions.get(String(primary.id)) ?? null) : fireFrame.ignition,
          flames: fireFrame.flames.map((f) => f.source),
          lighterFound: fireFrame.lighter !== null,
          hands: hands.length,
          snapDistance: hands[0] ? (fireRef.current.snap.debug(hands[0].key)?.distance ?? null) : null,
          persons: frame.persons.map((p) => ({
            id: p.id,
            face: p.face ? p.face.status : 'lost',
            penId: p.pen?.id ?? null,
            ignition: isLit(p.id) ? 'LIT' : 'UNLIT',
            smoke: smokeOf(p.id)?.state ?? 'IDLE',
            exhaleReady: smokeOf(p.id)?.exhaleReady ?? false,
            filterDistance: p.filterDistance,
            ambiguous: p.ownership?.ambiguous ?? false,
            handOwner: p.ownership?.handOwner ?? null,
          })),
          facesVisible: frame.facesVisible,
          pensTracked: frame.pens.length,
          faceHz,
          handHz,
          particles: people.particleCount,
          penList: frame.pens.map((pen) => {
            const owner = frame.persons.find((p) => p.pen?.id === pen.id)
            return {
              id: pen.id,
              colorId: pen.colorId,
              score: pen.score,
              kind: owner?.kind ?? frame.unassigned.find((u) => u.pen.id === pen.id)?.kind ?? null,
              personId: owner?.id ?? null,
            }
          }),
        })
      }
    }

    const tick = (now: number) => {
      if (!isCurrent()) return
      try {
        renderFrame(now)
      } catch (e) {
        stopCamera()
        setError(`画像処理でエラーが発生しました: ${describeCvError(cv, e)}`)
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [cv, stopCamera])

  // アンマウント時にカメラ・描画ループ・OpenCV の Mat をすべて解放
  useEffect(() => stopCamera, [stopCamera])

  // 口元検出（MediaPipe Face Landmarker）は、カメラ動作中かつ煙か自動方向補正が有効なとき
  // （STEP 5：複数人モードでは人物を顔で区別するので常に）だけ読み込む
  const faceNeeded = smoke.enabled || cigarette.autoOrient || personMode > 1
  useEffect(() => {
    if (cameraStatus !== 'running' || !faceNeeded) return
    let cancelled = false
    let tracker: MouthTracker | null = null
    const people = personsRef.current
    MouthTracker.create(personModeRef.current).then(
      (created) => {
        if (cancelled) {
          created.close()
          return
        }
        tracker = created
        mouthTrackerRef.current = created
        setFaceResult({ status: 'ready', error: null })
      },
      (e: unknown) => {
        if (cancelled) return
        setFaceResult({ status: 'error', error: e instanceof Error ? e.message : String(e) })
      },
    )
    return () => {
      cancelled = true
      tracker?.close()
      if (mouthTrackerRef.current === tracker) mouthTrackerRef.current = null
      people.clearSmoke()
      setFaceResult(null)
    }
  }, [cameraStatus, faceNeeded])

  // 手の推論（MediaPipe Hand Landmarker）は、カメラ動作中かつ指パッチン認識が有効なとき
  // （STEP 6：または形状判定で「手の近くの物を優先」が有効なとき）だけ読み込む
  const handNeeded = handsWanted(fire, shape)
  useEffect(() => {
    if (cameraStatus !== 'running' || !handNeeded) return
    let cancelled = false
    let tracker: HandTracker | null = null
    const fireController = fireRef.current
    HandTracker.create(personModeRef.current * 2).then(
      (created) => {
        if (cancelled) {
          created.close()
          return
        }
        tracker = created
        handTrackerRef.current = created
        setHandResult({ status: 'ready', error: null })
      },
      (e: unknown) => {
        if (cancelled) return
        setHandResult({ status: 'error', error: e instanceof Error ? e.message : String(e) })
      },
    )
    return () => {
      cancelled = true
      tracker?.close()
      if (handTrackerRef.current === tracker) handTrackerRef.current = null
      fireController.snap.reset()
      setHandResult(null)
    }
  }, [cameraStatus, handNeeded])

  // STEP 5：人数モードに合わせて、同時に検出する顔（人数）と手（人数 × 2）の数を変える（推論器は作り直さない）
  useEffect(() => {
    const onError = (e: unknown) => setError(`人数の切り替えに失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    mouthTrackerRef.current?.setNumFaces(personMode).catch(onError)
    handTrackerRef.current?.setNumHands(personMode * 2).catch(onError)
    dirtyRef.current = true
  }, [personMode, faceResult, handResult])

  // 煙を OFF にしたら、出ている煙と状態をすぐに消す
  useEffect(() => {
    if (smoke.enabled) return
    personsRef.current.clearSmoke()
  }, [smoke.enabled])

  const selectedColor =
    colorSettings.colors.find((c) => c.id === colorSettings.selectedId) ?? colorSettings.colors[0]
  const updateColor = (id: string, patch: Partial<PenColor>) =>
    setColorSettings((prev) => ({ ...prev, colors: prev.colors.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))
  const registerPendingColor = () => {
    if (!pendingColor) return
    const { estimate } = pendingColor
    const id = `custom-${Date.now().toString(36)}`
    const [r, g, b] = hsvToRgb(estimate.h, estimate.s, estimate.v)
    const color: PenColor = {
      id,
      name: pendingColor.name.trim() || `カスタム${colorSettings.colors.filter((c) => !c.builtin).length + 1}`,
      hsv: pendingColor.hsv,
      swatch: `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`,
      builtin: false,
      enabled: true,
      achromatic: estimate.achromatic,
    }
    setColorSettings((prev) => ({ ...prev, selectedId: id, colors: [...prev.colors, color] }))
    setPendingColor(null)
  }

  const updateSetting = (key: keyof DetectorSettings, value: number) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value }
      // S/V は min ≤ max を保つ（H は折り返し指定のため制約しない）
      if (key === 'sMin' && next.sMin > next.sMax) next.sMax = next.sMin
      if (key === 'sMax' && next.sMax < next.sMin) next.sMin = next.sMax
      if (key === 'vMin' && next.vMin > next.vMax) next.vMax = next.vMin
      if (key === 'vMax' && next.vMax < next.vMin) next.vMin = next.vMax
      return next
    })
  }

  const running = cameraStatus === 'running'
  const faceStatus: FaceStatus =
    !running || !faceNeeded ? 'off' : (faceResult?.status ?? 'loading')
  const handStatus: FaceStatus =
    !running || !handNeeded ? 'off' : (handResult?.status ?? 'loading')
  const detection = stats.detection
  const ignitionState = stats.ignition?.state ?? 'UNLIT'

  const setLighterHeld = (held: boolean) => {
    lighterPressedRef.current = held
    setLighterPressed(held)
  }
  const updateFire = (patch: Partial<FireSettings>) => setFire((prev) => ({ ...prev, ...patch }))

  return (
    <div className="pen-tracker">
      <div className="stage">
        <video ref={videoRef} className="source-video" playsInline muted />
        <canvas
          ref={canvasRef}
          className={`output-canvas${picking ? ' picking' : ''}`}
          onPointerDown={(e) => {
            if (!picking) return
            const canvas = canvasRef.current
            const frame = lastFrameRef.current
            if (!canvas || !frame) return
            const at = clientToCanvas({ x: e.clientX, y: e.clientY }, canvas.getBoundingClientRect(), canvas)
            if (!at) return
            // タップ位置のまわり（画面幅の約 1.2%、最小 4px）の画素の中央値から色を推定する
            const estimate = estimateColor(frame.data, frame.width, frame.height, at, Math.max(4, frame.width * 0.012))
            if (!estimate) return
            setPicking(false)
            setPendingColor({ estimate, hsv: estimate.range, at, name: '' })
          }}
        />
        {picking && <div className="pick-hint">ペンの上をタップしてください</div>}
        {running && personMode === 1 && (
          <div className="stage-badges" aria-live="polite">
            <div className={`smoke-badge ignition-${ignitionState.toLowerCase()}`}>{ignitionState}</div>
            {smoke.enabled && stats.smoke && (
              <div className={`smoke-badge state-${stats.smoke.state.toLowerCase()}`}>
                {stats.smoke.state}
                {stats.smoke.exhaleReady && stats.smoke.state !== 'EXHALING' && <span> · 吐ける</span>}
              </div>
            )}
            {stats.flames.length > 0 && <div className="smoke-badge flame-on">炎</div>}
          </div>
        )}
        {running && personMode > 1 && (
          <div className="stage-badges" aria-live="polite">
            <div className="smoke-badge">
              認識 {stats.facesVisible}/{personMode} 人
            </div>
            {stats.persons
              .filter((p) => p.face !== 'lost')
              .map((p) => (
                <div
                  key={p.id}
                  className={`smoke-badge person-badge ignition-${p.ignition.toLowerCase()}`}
                  style={{ borderColor: personColor(p.id) }}
                >
                  <span style={{ color: personColor(p.id) }}>#{p.id}</span> {p.ignition}
                  {smoke.enabled && p.ignition === 'LIT' && ` · ${p.smoke}`}
                </div>
              ))}
            {stats.flames.length > 0 && <div className="smoke-badge flame-on">炎</div>}
          </div>
        )}
        {!running && (
          <div className="stage-placeholder">
            {cvStatus === 'loading' && 'OpenCV.js を読み込み中…'}
            {cvStatus === 'error' && `OpenCV.js の読み込みに失敗しました: ${cvError}`}
            {cvStatus === 'ready' &&
              (cameraStatus === 'starting' ? 'カメラを起動中…' : 'カメラは停止中です')}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="toolbar">
          {running || cameraStatus === 'starting' ? (
            <button type="button" onClick={stopCamera}>
              カメラ停止
            </button>
          ) : (
            <button type="button" onClick={startCamera} disabled={cvStatus !== 'ready'}>
              カメラ起動
            </button>
          )}
          <div className="segmented" role="group" aria-label="表示切替">
            <button
              type="button"
              aria-pressed={viewMode === 'camera'}
              onClick={() => setViewMode('camera')}
            >
              元映像
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'mask'}
              onClick={() => setViewMode('mask')}
            >
              マスク
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'colorMask'}
              onClick={() => setViewMode('colorMask')}
            >
              色マスク
            </button>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={mirror}
              onChange={(e) => setMirror(e.target.checked)}
            />
            左右反転
          </label>
          <div className="segmented" role="group" aria-label="人数モード">
            {([1, 2, 3] as const).map((n) => (
              <button key={n} type="button" aria-pressed={personMode === n} onClick={() => setPersonMode(n)}>
                {n}人
              </button>
            ))}
          </div>
        </div>

        {error && <p className="error">{error}</p>}

        {personMode > 1 && (
          <section>
            <h2>複数人（{personMode}人モード）</h2>
            <dl className="readout">
              <dt>認識</dt>
              <dd>{running ? `顔 ${stats.facesVisible}人 / ペン ${stats.pensTracked}本` : '—'}</dd>
              <dt>処理負荷</dt>
              <dd>{running ? describeLoad(stats, personMode) : '—'}</dd>
            </dl>
            {running && stats.persons.length === 0 && <p className="note">顔を認識すると人物として表示します。</p>}
            <ul className="person-list">
              {stats.persons.map((p) => (
                <li key={p.id}>
                  <span className="person-id" style={{ color: personColor(p.id) }}>
                    #{p.id}
                  </span>
                  <span>{p.face === 'measured' ? '検出中' : p.face === 'held' ? '見失い中' : '画面外'}</span>
                  <span>{p.penId !== null ? `ペン P${p.penId}` : 'ペンなし'}</span>
                  <span className={`person-state ignition-${p.ignition.toLowerCase()}`}>{p.ignition}</span>
                  {smoke.enabled && <span>{p.smoke}{p.exhaleReady && p.smoke !== 'EXHALING' ? '（吐ける）' : ''}</span>}
                  <span className="person-actions">
                    <button
                      type="button"
                      onClick={() => {
                        fireRef.current.ignition(String(p.id)).light()
                        dirtyRef.current = true
                      }}
                    >
                      着火
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        fireRef.current.ignition(String(p.id)).extinguish()
                        personsRef.current.resetSmoke(p.id)
                        dirtyRef.current = true
                      }}
                    >
                      消火
                    </button>
                  </span>
                  {smoke.showDebug && (
                    <span className="person-debug">
                      口元距離 {p.filterDistance !== null ? `×${p.filterDistance.toFixed(2)}` : '—'}
                      {p.ambiguous && ' · 対応が曖昧（直前を保持）'}
                      {p.handOwner !== null && ` · 手: #${p.handOwner}`}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <label className="checkbox">
              <input type="checkbox" checked={autoPerf} onChange={(e) => setAutoPerf(e.target.checked)} />
              負荷の自動調整（人数に応じて推論間隔・処理解像度を調整）
            </label>
            <p className="note">
              人物は顔ごとの追跡 ID（#番号）で区別し、ペン（P番号）は口元・手・直前の対応から一対一で割り当てます。2 人の中間など判断できないペンは未割当（未着火の CG のみ）にします。顔が隠れても 3 秒間は同じ ID を保持し、それを過ぎると状態を破棄します。人数を切り替えると追跡と着火状態をリセットします。詳細はデバッグ表示を ON にすると表示します。
            </p>
          </section>
        )}

        <section>
          <div className="section-head">
            <h2>ペンの色・CG</h2>
          </div>
          <div className="segmented" role="group" aria-label="認識する色の数">
            <button
              type="button"
              aria-pressed={colorSettings.mode === 'single'}
              onClick={() => setColorSettings((prev) => ({ ...prev, mode: 'single' }))}
            >
              1色のみ
            </button>
            <button
              type="button"
              aria-pressed={colorSettings.mode === 'all'}
              onClick={() => setColorSettings((prev) => ({ ...prev, mode: 'all' }))}
            >
              全色同時
            </button>
          </div>
          <div className="color-chips" role="group" aria-label="認識する色">
            {colorSettings.colors.map((c) => (
              <div key={c.id} className={`color-chip${colorSettings.selectedId === c.id ? ' selected' : ''}`}>
                <button
                  type="button"
                  aria-pressed={colorSettings.selectedId === c.id}
                  onClick={() => setColorSettings((prev) => ({ ...prev, selectedId: c.id }))}
                >
                  <span className="swatch" style={{ background: c.swatch }} />
                  {c.name}
                  {c.achromatic && <span className="tag">実験的</span>}
                </button>
                {colorSettings.mode === 'all' && (
                  <input
                    type="checkbox"
                    aria-label={`${c.name}を同時認識に含める`}
                    checked={c.enabled}
                    onChange={(e) => updateColor(c.id, { enabled: e.target.checked })}
                  />
                )}
              </div>
            ))}
          </div>
          <p className="note">
            {colorSettings.mode === 'single'
              ? `「${selectedColor.name}」だけを認識します。`
              : `チェックした色（${activeColors(colorSettings).map((c) => c.name).join('・') || 'なし'}）を同時に認識します。同時に表示するペンは人数モードの人数まで（1人モードでは最もペンらしい 1 本）。`}
            HSV の範囲は下の「HSV 検出範囲」で、選択中の色ごとに調整できます。
          </p>
          <div className="toolbar">
            <button type="button" disabled={!running} aria-pressed={picking} onClick={() => setPicking((v) => !v)}>
              {picking ? 'タップ待ち…（取り消す）' : '画面をタップして色を登録'}
            </button>
            {!selectedColor.builtin && (
              <button
                type="button"
                onClick={() =>
                  setColorSettings((prev) => ({
                    ...prev,
                    selectedId: 'pink',
                    colors: prev.colors.filter((c) => c.id !== prev.selectedId),
                  }))
                }
              >
                「{selectedColor.name}」を削除
              </button>
            )}
          </div>
          {pendingColor && (
            <div className="pending-color">
              <div className="pending-head">
                <span
                  className="swatch large"
                  style={{ background: hsvToCss(pendingColor.estimate.h, pendingColor.estimate.s, pendingColor.estimate.v) }}
                />
                <span>
                  推定 H{pendingColor.estimate.h} S{pendingColor.estimate.s} V{pendingColor.estimate.v}（{pendingColor.estimate.samples} 画素の中央値）
                </span>
              </div>
              {pendingColor.estimate.achromatic && (
                <p className="error">
                  彩度が低い色（黒・白・グレー）です。色相で背景と区別できないため、明度・彩度の範囲と、より厳しい形状判定で検出します。精度は不十分で、未対応（実験的）の扱いです。
                </p>
              )}
              <label className="text-field">
                <span>名前</span>
                <input
                  type="text"
                  maxLength={20}
                  placeholder="例：黄色のペン"
                  value={pendingColor.name}
                  onChange={(e) => setPendingColor((prev) => prev && { ...prev, name: e.target.value })}
                />
              </label>
              <HsvEditor
                value={pendingColor.hsv}
                onChange={(hsv) => setPendingColor((prev) => prev && { ...prev, hsv })}
              />
              <div className="toolbar">
                <button type="button" onClick={registerPendingColor}>
                  登録する
                </button>
                <button type="button" onClick={() => setPendingColor(null)}>
                  キャンセル
                </button>
              </div>
            </div>
          )}
          <h3>形でペンを見分ける</h3>
          <label className="checkbox">
            <input type="checkbox" checked={shape.enabled} onChange={(e) => setShape((prev) => ({ ...prev, enabled: e.target.checked }))} />
            形状スコアで判定する（細長さ・直線性・幅の均一性・面積・大きさ）
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={shape.useHands}
              disabled={!shape.enabled}
              onChange={(e) => setShape((prev) => ({ ...prev, useHands: e.target.checked }))}
            />
            手に持たれている物を優先する（MediaPipe Hand Landmarker）
          </label>
          <Slider
            label="最小スコア"
            value={shape.minScore}
            min={0}
            max={0.95}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(v) => setShape((prev) => ({ ...prev, minScore: v }))}
          />
          <dl className="readout">
            <dt>検出中</dt>
            <dd>
              {running && stats.penList.length > 0
                ? stats.penList
                    .map((p) => {
                      const color = colorSettings.colors.find((c) => c.id === p.colorId)?.name ?? '—'
                      const score = p.score !== null ? ` スコア ${p.score.toFixed(2)}` : ''
                      const kind = p.kind ? ` → ${CG_LABELS[p.kind]}` : ''
                      return `P${p.id} ${color}${score}${kind}`
                    })
                    .join(' / ')
                : '—'}
            </dd>
          </dl>
          <h3>CG の種類</h3>
          <div className="segmented" role="group" aria-label="CG の種類">
            {(['cigarette', 'cigar', 'pipe', 'auto'] as CgChoice[]).map((k) => (
              <button key={k} type="button" aria-pressed={cigarette.kind === k} onClick={() => setCigarette((prev) => ({ ...prev, kind: k }))}>
                {CG_LABELS[k]}
              </button>
            ))}
          </div>
          <p className="note">
            CG の種類はペンの色とは独立した設定です。自動は、ペンの 全長 / 太さ が 9 以上ならタバコ、5.5〜9 なら葉巻、5.5 未満ならパイプ（しきい値の前後では直前の種類を保ちます）。色を「色マスク」表示で確認できます。
          </p>
        </section>

        <section>
          <div className="section-head">
            <h2>タバコ CG</h2>
            <button type="button" className="link" onClick={() => setCigarette(DEFAULT_CIGARETTE)}>
              初期値に戻す
            </button>
          </div>
          <div className="toolbar">
            <div className="segmented" role="group" aria-label="重ね表示">
              {(
                [
                  ['cg', 'CG'],
                  ['frame', '認識枠'],
                  ['both', '両方'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={overlay === mode}
                  onClick={() => setOverlay(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setCigarette((prev) => ({ ...prev, flipped: !prev.flipped }))}
            >
              向きを反転
            </button>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={cigarette.autoOrient}
              onChange={(e) => setCigarette((prev) => ({ ...prev, autoOrient: e.target.checked }))}
            />
            口元に近い端をフィルターにする（自動方向補正）
          </label>
          <Slider
            label="拡大率"
            value={cigarette.scale}
            min={0.5}
            max={2}
            step={0.05}
            format={(v) => `×${v.toFixed(2)}`}
            onChange={(v) => setCigarette((prev) => ({ ...prev, scale: v }))}
          />
          <Slider
            label="太さ"
            value={cigarette.thicknessRatio}
            min={0.5}
            max={2}
            step={0.05}
            format={(v) => `×${v.toFixed(2)}`}
            onChange={(v) => setCigarette((prev) => ({ ...prev, thicknessRatio: v }))}
          />
          <Slider
            label="位置(軸)"
            value={cigarette.axialOffset}
            min={-0.5}
            max={0.5}
            step={0.01}
            format={(v) => `${(v * 100).toFixed(0)}%`}
            onChange={(v) => setCigarette((prev) => ({ ...prev, axialOffset: v }))}
          />
          <Slider
            label="位置(垂直)"
            value={cigarette.perpOffset}
            min={-2}
            max={2}
            step={0.05}
            format={(v) => `×${v.toFixed(2)}`}
            onChange={(v) => setCigarette((prev) => ({ ...prev, perpOffset: v }))}
          />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={cigarette.fingerOcclusion}
              onChange={(e) =>
                setCigarette((prev) => ({ ...prev, fingerOcclusion: e.target.checked }))
              }
            />
            分断のすき間（指の位置）では CG を切り抜く
          </label>
          <p className="note">
            位置(軸)はペン全長、位置(垂直)・太さはペンの太さに対する比率。自動方向補正が ON のとき「向きを反転」は自動で決めた向きをさらに反転します。CG は元のペンの上に重ねて描くだけで、ペン自体は消していません（CG からはみ出した部分は見えます）。
          </p>
        </section>

        <section>
          <div className="section-head">
            <h2>着火・炎</h2>
            <button type="button" className="link" onClick={() => setFire(DEFAULT_FIRE)}>
              初期値に戻す
            </button>
          </div>
          <dl className="readout">
            <dt>タバコ</dt>
            <dd>
              {ignitionState}
              {stats.ignition?.flameDistance != null &&
                `（炎まで 全長 ×${stats.ignition.flameDistance.toFixed(2)}）`}
            </dd>
            <dt>炎</dt>
            <dd>{stats.flames.length > 0 ? `表示中（${describeFlames(stats.flames)}）` : 'なし'}</dd>
            <dt>手</dt>
            <dd>
              {describeFaceStatus(handStatus, handResult?.error ?? null, running, handNeeded)}
              {handStatus === 'ready' &&
                ` · ${stats.hands} 本${stats.snapDistance !== null ? ` · 親指-中指 ×${stats.snapDistance.toFixed(2)}` : ''}`}
            </dd>
            <dt>ライター</dt>
            <dd>{!fire.lighterEnabled ? '無効' : running ? (stats.lighterFound ? '検出中' : '未検出') : '—'}</dd>
          </dl>
          <div className="toolbar fire-actions">
            <button
              type="button"
              disabled={!running}
              onClick={() => {
                // 1 人モードはその人物、複数人モードは認識中の全員
                fireRef.current.lightAll(personsRef.current.personIds.map(String))
                dirtyRef.current = true
              }}
            >
              手動着火
            </button>
            <button
              type="button"
              disabled={!running}
              onClick={() => {
                fireRef.current.extinguishAll()
                personsRef.current.resetSmoke()
                dirtyRef.current = true
              }}
            >
              消火
            </button>
            <button
              type="button"
              disabled={!running}
              onClick={() => {
                manualFlameRef.current = true
                dirtyRef.current = true
              }}
            >
              指先に炎を出す
            </button>
          </div>
          <button
            type="button"
            className={`lighter-button${lighterPressed ? ' pressed' : ''}`}
            disabled={!running || !fire.lighterEnabled}
            aria-pressed={lighterPressed}
            onPointerDown={(e) => {
              // 指がボタンの外へずれても離すまで「押している」とみなす（取得できない環境では無視）
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
                /* ポインタキャプチャ非対応 */
              }
              setLighterHeld(true)
            }}
            onPointerUp={() => setLighterHeld(false)}
            onPointerCancel={() => setLighterHeld(false)}
            onLostPointerCapture={() => setLighterHeld(false)}
            onContextMenu={(e) => e.preventDefault()}
          >
            {lighterPressed ? 'ライター点火中…' : 'ライター着火（押している間）'}
          </button>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={fire.snapEnabled}
              onChange={(e) => updateFire({ snapEnabled: e.target.checked })}
            />
            指パッチン認識（MediaPipe Hand Landmarker）
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={fire.lighterEnabled}
              onChange={(e) => updateFire({ lighterEnabled: e.target.checked })}
            />
            長方形の小物をライターにする
          </label>
          <Slider
            label="着火距離"
            value={fire.ignition.igniteDistance}
            min={0.05}
            max={1}
            step={0.05}
            format={(v) => `×${v.toFixed(2)}`}
            onChange={(v) => updateFire({ ignition: { ...fire.ignition, igniteDistance: v } })}
          />
          <h3>指パッチン</h3>
          <Slider
            label="接触距離"
            value={fire.snap.contactDistance}
            min={0.1}
            max={0.8}
            step={0.05}
            format={(v) => `×${v.toFixed(2)}`}
            onChange={(v) =>
              updateFire({
                snap: { ...fire.snap, contactDistance: v, releaseDistance: Math.max(fire.snap.releaseDistance, v + 0.1) },
              })
            }
          />
          <Slider
            label="弾く距離"
            value={fire.snap.releaseDistance}
            min={0.3}
            max={1.5}
            step={0.05}
            format={(v) => `×${v.toFixed(2)}`}
            onChange={(v) =>
              updateFire({
                snap: { ...fire.snap, releaseDistance: v, contactDistance: Math.min(fire.snap.contactDistance, v - 0.1) },
              })
            }
          />
          <Slider
            label="弾く速さ"
            value={fire.snap.minSpeed}
            min={0.5}
            max={10}
            step={0.5}
            format={(v) => `${v.toFixed(1)}/s`}
            onChange={(v) => updateFire({ snap: { ...fire.snap, minSpeed: v } })}
          />
          <Slider
            label="手の推論間隔"
            value={fire.handIntervalMs}
            max={200}
            step={1}
            format={(v) => (v === 0 ? '毎フレーム' : `${v}ms`)}
            onChange={(v) => updateFire({ handIntervalMs: v })}
          />
          <h3>ライターの色・形</h3>
          {(
            [
              ['hMin', 'H 最小', 0, 179, 1],
              ['hMax', 'H 最大', 0, 179, 1],
              ['sMin', 'S 最小', 0, 255, 1],
              ['vMin', 'V 最小', 0, 255, 1],
              ['minArea', '最小面積', 100, 10000, 100],
              ['minRectangularity', '長方形らしさ', 0.5, 1, 0.01],
            ] as const
          ).map(([key, label, min, max, step]) => (
            <Slider
              key={key}
              label={label}
              value={fire.lighter[key]}
              min={min}
              max={max}
              step={step}
              onChange={(v) => updateFire({ lighter: { ...fire.lighter, [key]: v } })}
            />
          ))}
          <p className="note">
            指パッチン：親指と中指を押し付けてから素早く弾くと、親指の先に炎が出ます（手の大きさで正規化、両手対応、0.9 秒のクールダウン）。炎にタバコの火側の端を近づけると着火（LIT）し、着火後だけ吸う・吐くの煙が出ます。ライターは単色の長方形の小物（既定は青）を認識し、ボタンを押している間だけ火口に炎を出します。着火距離はタバコの全長に対する倍率。
          </p>
        </section>

        <section>
          <div className="section-head">
            <h2>煙（吸う・吐く）</h2>
            <button
              type="button"
              className="link"
              onClick={() => setSmoke((prev) => ({ ...DEFAULT_SMOKE, enabled: prev.enabled }))}
            >
              初期値に戻す
            </button>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={smoke.enabled}
              onChange={(e) => setSmoke((prev) => ({ ...prev, enabled: e.target.checked }))}
            />
            煙エフェクトを有効にする
          </label>
          <dl className="readout">
            <dt>顔検出</dt>
            <dd>{describeFaceStatus(faceStatus, faceResult?.error ?? null, running, faceNeeded)}</dd>
            <dt>動作状態</dt>
            <dd>
              {smoke.enabled && stats.smoke
                ? `${stats.smoke.state}${stats.smoke.exhaleReady ? '（吐ける）' : ''}`
                : '—'}
            </dd>
            <dt>口元距離</dt>
            <dd>
              {stats.filterDistance !== null
                ? `顔幅 ×${stats.filterDistance.toFixed(2)}`
                : running && faceStatus === 'ready'
                  ? stats.mouthFound
                    ? 'タバコ未検出'
                    : '顔未検出'
                  : '—'}
            </dd>
          </dl>
          <ScoreMeter label="mouthPucker" value={stats.pucker} threshold={smoke.puckerThreshold} />
          <ScoreMeter label="mouthFunnel" value={stats.funnel} threshold={smoke.funnelThreshold} />
          <Slider
            label="吸う距離"
            value={smoke.enterDistance}
            min={0.05}
            max={1.5}
            step={0.05}
            format={(v) => `×${v.toFixed(2)}`}
            onChange={(v) =>
              setSmoke((prev) => ({
                ...prev,
                enterDistance: v,
                leaveDistance: Math.max(prev.leaveDistance, v + 0.05),
              }))
            }
          />
          <Slider
            label="離す距離"
            value={smoke.leaveDistance}
            min={0.1}
            max={2}
            step={0.05}
            format={(v) => `×${v.toFixed(2)}`}
            onChange={(v) =>
              setSmoke((prev) => ({
                ...prev,
                leaveDistance: v,
                enterDistance: Math.min(prev.enterDistance, v - 0.05),
              }))
            }
          />
          <Slider
            label="すぼめ(Pucker)"
            value={smoke.puckerThreshold}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(v) => setSmoke((prev) => ({ ...prev, puckerThreshold: v }))}
          />
          <Slider
            label="すぼめ(Funnel)"
            value={smoke.funnelThreshold}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(v) => setSmoke((prev) => ({ ...prev, funnelThreshold: v }))}
          />
          <h3>煙の見た目</h3>
          <div className="segmented preset" role="group" aria-label="煙のプリセット">
            {(Object.keys(SMOKE_PRESETS) as SmokePresetId[]).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={smoke.preset === id}
                onClick={() => setSmoke((prev) => ({ ...prev, ...SMOKE_PRESETS[id].style, preset: id }))}
              >
                {SMOKE_PRESETS[id].label}
              </button>
            ))}
          </div>
          {(
            [
              ['amount', '煙の量', 0, 3, 0.05, (v: number) => `${Math.round(v * 100)}%`],
              ['speed', '煙の速度', 0.5, 4, 0.1, (v: number) => `×${v.toFixed(1)}`],
              ['spread', '煙の広がり', 0.5, 3, 0.1, (v: number) => `×${v.toFixed(1)}`],
              ['density', '煙の濃さ', 0, 1, 0.05, (v: number) => `${Math.round(v * 100)}%`],
            ] as const
          ).map(([key, label, min, max, step, format]) => (
            <Slider
              key={key}
              label={label}
              value={smoke[key as keyof SmokeStyle]}
              min={min}
              max={max}
              step={step}
              format={format}
              onChange={(v) => setSmoke((prev) => ({ ...prev, [key]: v, preset: 'custom' }))}
            />
          ))}
          <button
            type="button"
            disabled={!running || !smoke.enabled}
            onClick={() => {
              testBurstUntilRef.current = performance.now() + TEST_BURST_MS
            }}
          >
            煙をテスト発生
          </button>
          <Slider
            label="推論間隔"
            value={smoke.inferenceIntervalMs}
            min={33}
            max={250}
            step={1}
            format={(v) => `${v}ms`}
            onChange={(v) => setSmoke((prev) => ({ ...prev, inferenceIntervalMs: v }))}
          />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={smoke.showDebug}
              onChange={(e) => setSmoke((prev) => ({ ...prev, showDebug: e.target.checked }))}
            />
            デバッグ表示（顔ランドマーク・ペンの両端・煙の発生位置）
          </label>
          <p className="note">
            距離は顔幅（両目の外側の端の距離）に対する倍率。吸い口が「吸う距離」以内に入ると SMOKING（火から煙）、十分に吸ってから「離す距離」より離し、口を「ふー」の形にすぼめると EXHALING（口から煙）になります。口の形による擬似的な判定で、実際の息は検出していません。
          </p>
        </section>

        <section>
          <h2>検出結果</h2>
          <dl className="readout">
            <dt>状態</dt>
            <dd>{running ? describeStatus(detection) : '—'}</dd>
            <dt>中心</dt>
            <dd>
              {detection
                ? `(${detection.center.x.toFixed(0)}, ${detection.center.y.toFixed(0)}) px`
                : '—'}
            </dd>
            <dt>角度</dt>
            <dd>{detection ? `${detection.angleDeg.toFixed(1)}°` : '—'}</dd>
            <dt>長さ</dt>
            <dd>{detection ? `${detection.length.toFixed(0)} px` : '—'}</dd>
            <dt>太さ</dt>
            <dd>{detection ? `${detection.thickness.toFixed(0)} px` : '—'}</dd>
            <dt>面積</dt>
            <dd>{detection ? `${detection.area.toFixed(0)} px²` : '—'}</dd>
            <dt>縦横比</dt>
            <dd>{detection ? detection.aspectRatio.toFixed(2) : '—'}</dd>
            <dt>処理</dt>
            <dd>
              {running
                ? `${stats.frameWidth}×${stats.frameHeight} / ${stats.fps.toFixed(1)} fps`
                : '—'}
            </dd>
          </dl>
          <p className="note">
            座標は表示画像（左右反転後）基準。角度は右方向 0°・時計回り正（0〜180°）。
          </p>
        </section>

        <section>
          <div className="section-head">
            <h2>HSV 検出範囲（{selectedColor.name}）</h2>
            <button
              type="button"
              className="link"
              onClick={() => {
                // 組み込みの色は既定の範囲に戻す（カスタム色の範囲はそのまま）。形状フィルタ・追跡も初期値に戻す
                const builtin = BUILTIN_COLORS.find((c) => c.id === selectedColor.id)
                if (builtin) updateColor(builtin.id, { hsv: builtin.hsv })
                setSettings(DEFAULT_SETTINGS)
                setTracking(DEFAULT_TRACKING)
              }}
            >
              初期値に戻す
            </button>
          </div>
          <HsvEditor value={selectedColor.hsv} onChange={(hsv) => updateColor(selectedColor.id, { hsv })} />
        </section>

        <section>
          <h2>形状フィルタ</h2>
          <Slider
            label="最小面積"
            value={settings.minArea}
            min={50}
            max={5000}
            step={50}
            onChange={(v) => updateSetting('minArea', v)}
          />
          <Slider
            label="最小縦横比"
            value={settings.minAspectRatio}
            min={1}
            max={8}
            step={0.1}
            onChange={(v) => updateSetting('minAspectRatio', v)}
          />
        </section>

        <section>
          <h2>分断時の結合</h2>
          <Slider
            label="最大すき間"
            value={settings.maxGapRatio}
            min={0}
            max={8}
            step={0.5}
            format={(v) => `×${v.toFixed(1)}`}
            onChange={(v) => updateSetting('maxGapRatio', v)}
          />
          <Slider
            label="最大角度差"
            value={settings.maxAngleDiff}
            max={45}
            format={(v) => `${v}°`}
            onChange={(v) => updateSetting('maxAngleDiff', v)}
          />
          <p className="note">
            すき間はペンの太さに対する倍率。指で分断された輪郭を、同じ向き・同一直線上・太さが同程度のときだけ 1 本に結合します。
          </p>
        </section>

        <section>
          <h2>追跡</h2>
          <Slider
            label="平滑化"
            value={tracking.smoothing}
            max={0.9}
            step={0.1}
            onChange={(v) => setTracking((prev) => ({ ...prev, smoothing: v }))}
          />
          <Slider
            label="保持時間"
            value={tracking.holdMs}
            max={1000}
            step={50}
            format={(v) => `${v}ms`}
            onChange={(v) => setTracking((prev) => ({ ...prev, holdMs: v }))}
          />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={tracking.lengthCompletion}
              onChange={(e) =>
                setTracking((prev) => ({ ...prev, lengthCompletion: e.target.checked }))
              }
            />
            片側が隠れたとき直前の全長で補完
          </label>
        </section>
      </div>
    </div>
  )
}

/** HSV 範囲の編集（H は 0/179 をまたぐ範囲に対応。S/V は 最小 ≤ 最大 を保つ） */
function HsvEditor({ value, onChange }: { value: HsvRange; onChange: (v: HsvRange) => void }) {
  const set = (key: keyof HsvRange, v: number) => {
    const next = { ...value, [key]: v }
    if (key === 'sMin' && next.sMin > next.sMax) next.sMax = next.sMin
    if (key === 'sMax' && next.sMax < next.sMin) next.sMin = next.sMax
    if (key === 'vMin' && next.vMin > next.vMax) next.vMax = next.vMin
    if (key === 'vMax' && next.vMax < next.vMin) next.vMin = next.vMax
    onChange(next)
  }
  return (
    <>
      <div className="hue-swatches" aria-hidden="true">
        <span style={{ background: hueColor(value.hMin) }} />
        <span style={{ background: hueColor(value.hMax) }} />
      </div>
      <Slider label="H 最小" value={value.hMin} max={179} onChange={(v) => set('hMin', v)} />
      <Slider label="H 最大" value={value.hMax} max={179} onChange={(v) => set('hMax', v)} />
      {value.hMin > value.hMax && (
        <p className="note">H 最小 &gt; H 最大 のため、{value.hMin}〜179 と 0〜{value.hMax} を検出します（赤など）。</p>
      )}
      <Slider label="S 最小" value={value.sMin} max={255} onChange={(v) => set('sMin', v)} />
      <Slider label="S 最大" value={value.sMax} max={255} onChange={(v) => set('sMax', v)} />
      <Slider label="V 最小" value={value.vMin} max={255} onChange={(v) => set('vMin', v)} />
      <Slider label="V 最大" value={value.vMax} max={255} onChange={(v) => set('vMax', v)} />
    </>
  )
}

/** OpenCV の HSV → RGB（登録した色の表示用） */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const hh = (h * 2) / 60
  const c = (v / 255) * (s / 255)
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const m = v / 255 - c
  const [r, g, b] =
    hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x]
  return [r, g, b].map((t) => Math.round((t + m) * 255)) as [number, number, number]
}

type SliderProps = {
  label: string
  value: number
  min?: number
  max: number
  step?: number
  format?: (value: number) => string
  onChange: (value: number) => void
}

function Slider({ label, value, min = 0, max, step = 1, format, onChange }: SliderProps) {
  return (
    <label className="slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output>{format ? format(value) : step < 1 ? value.toFixed(1) : value}</output>
    </label>
  )
}

/** OpenCV の H（0-179）を CSS の色相（0-358°）に変換 */
function hueColor(h: number): string {
  return `hsl(${h * 2}deg 90% 55%)`
}

/** 手の推論が必要か：指パッチン認識、または形状判定で手の位置を使うとき */
function handsWanted(fire: FireSettings, shape: ShapeSettings): boolean {
  return fire.snapEnabled || (shape.enabled && shape.useHands)
}

/** ペンの色名と形状スコア（認識枠・デバッグ表示用） */
function colorLabel(colors: PenColor[], pen: IdentifiedPen): string {
  const name = colors.find((c) => c.id === pen.colorId)?.name ?? ''
  return `P${pen.id} ${name}${pen.score !== null ? ` ${pen.score.toFixed(2)}` : ''}`
}

function describeFlames(sources: ActiveFlame['source'][]): string {
  const label = { snap: '指パッチン', lighter: 'ライター', manual: '手動' } as const
  return [...new Set(sources)].map((s) => label[s]).join('・')
}

/** 認識枠表示：ライターとして検出した長方形 */
function drawLighterFrame(ctx: CanvasRenderingContext2D, d: PenDetection) {
  ctx.save()
  ctx.lineWidth = 2.5
  ctx.strokeStyle = '#448aff'
  strokeQuad(ctx, d.corners)
  ctx.font = '13px system-ui, sans-serif'
  ctx.fillStyle = '#448aff'
  ctx.fillText(`ライター ${d.angleDeg.toFixed(0)}° ${d.length.toFixed(0)}×${d.thickness.toFixed(0)}`, d.center.x + 8, d.center.y)
  ctx.restore()
}

/** デバッグ表示：手の骨格、親指-中指の距離、炎の位置、着火距離の円、ライターの火口 */
function drawFireDebug(
  ctx: CanvasRenderingContext2D,
  d: {
    hands: TrackedHand[]
    fire: FireFrame
    placements: CigarettePlacement[]
    igniteDistance: number
    snapDistance: (key: string) => number | null
  },
) {
  ctx.save()
  ctx.font = 'bold 12px system-ui, sans-serif'
  for (const hand of d.hands) {
    const lm = hand.landmarks
    ctx.strokeStyle = 'rgba(105, 240, 174, 0.8)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(lm[a].x, lm[a].y)
      ctx.lineTo(lm[b].x, lm[b].y)
    }
    ctx.stroke()
    const { thumbTip, middleTip } = hand.sample
    ctx.strokeStyle = '#ffd740'
    ctx.beginPath()
    ctx.moveTo(thumbTip.x, thumbTip.y)
    ctx.lineTo(middleTip.x, middleTip.y)
    ctx.stroke()
    const dist = d.snapDistance(hand.key)
    ctx.fillStyle = '#ffd740'
    ctx.fillText(`${hand.side} ${dist !== null ? `×${dist.toFixed(2)}` : ''}`, thumbTip.x + 6, thumbTip.y - 6)
  }
  for (const placement of d.placements) {
    ctx.strokeStyle = 'rgba(255, 82, 82, 0.9)'
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.arc(placement.emberEnd.x, placement.emberEnd.y, d.igniteDistance * placement.length, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
  }
  for (const f of d.fire.flames) {
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(f.position.x, f.position.y, 5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.fillText(f.source, f.position.x + 8, f.position.y + 4)
  }
  if (d.fire.lighterNozzle) {
    ctx.fillStyle = '#448aff'
    ctx.beginPath()
    ctx.arc(d.fire.lighterNozzle.x, d.fire.lighterNozzle.y, 4, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/** STEP 5 のデバッグ表示：人物 ID（口元）、ペン ID、顔とペンの対応（線）、未割当のペン */
function drawPersonDebug(ctx: CanvasRenderingContext2D, frame: TrackFrame) {
  ctx.save()
  ctx.font = 'bold 14px system-ui, sans-serif'
  ctx.lineWidth = 2.5
  for (const p of frame.persons) {
    const color = personColor(p.id)
    if (p.face) {
      const { x, y } = p.face.center
      ctx.fillStyle = color
      ctx.fillText(`#${p.id}${p.face.status === 'held' ? '（見失い中）' : ''}`, x - 14, y - p.face.faceScale * 0.9)
    }
    if (p.pen) {
      ctx.fillStyle = color
      ctx.fillText(`P${p.pen.id}→#${p.id}${p.ownership?.ambiguous ? '?' : ''}`, p.pen.center.x + 8, p.pen.center.y + 20)
      if (p.face && p.placement) {
        ctx.strokeStyle = color
        ctx.beginPath()
        ctx.moveTo(p.face.center.x, p.face.center.y)
        ctx.lineTo(p.placement.mouthEnd.x, p.placement.mouthEnd.y)
        ctx.stroke()
      }
    }
  }
  for (const u of frame.unassigned) {
    ctx.strokeStyle = 'rgba(200, 200, 200, 0.9)'
    ctx.setLineDash([6, 5])
    strokeQuad(ctx, u.pen.corners)
    ctx.setLineDash([])
    ctx.fillStyle = '#e0e0e0'
    ctx.fillText(`P${u.pen.id} 未割当${u.ownership?.ambiguous ? '（曖昧）' : ''}`, u.pen.center.x + 8, u.pen.center.y + 20)
  }
  ctx.restore()
}

/** 処理負荷の表示：実測 fps・推論頻度・粒子数と、fps からの目安 */
function describeLoad(stats: Stats, mode: PersonMode): string {
  const level = { low: '軽い', medium: '中', high: '重い' }[loadLevel(stats.fps)]
  return `${level}（${stats.fps.toFixed(0)} fps · 顔 ${stats.faceHz.toFixed(0)}Hz×最大${mode}人 · 手 ${stats.handHz.toFixed(0)}Hz · 粒子 ${stats.particles} · ${stats.frameWidth}×${stats.frameHeight}）`
}

function describeFaceStatus(
  status: FaceStatus,
  error: string | null,
  running: boolean,
  enabled: boolean,
): string {
  if (!enabled) return '無効'
  if (!running) return '—'
  switch (status) {
    case 'loading':
      return '読み込み中…'
    case 'ready':
      return '動作中'
    case 'error':
      return `エラー: ${error ?? '不明'}`
    default:
      return '—'
  }
}

/** 顔ランドマーク、タバコの両端（F=フィルター / E=火）、煙の発生位置、距離しきい値の円を描く（調整用） */
function drawDebug(
  ctx: CanvasRenderingContext2D,
  d: {
    mouth: Mouth | null
    placement: CigarettePlacement | null
    smokeSource: SmokeSource | null
    settings: SmokeSettings
  },
) {
  const { mouth, placement, smokeSource, settings } = d
  ctx.save()
  ctx.font = 'bold 13px system-ui, sans-serif'
  if (mouth) {
    ctx.fillStyle = '#40c4ff'
    for (const p of mouth.debugPoints) ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3)
    ctx.beginPath()
    ctx.arc(mouth.center.x, mouth.center.y, 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#40c4ff'
    ctx.lineWidth = 1.5
    ctx.setLineDash([6, 5])
    for (const r of [settings.enterDistance, settings.leaveDistance]) {
      ctx.beginPath()
      ctx.arc(mouth.center.x, mouth.center.y, r * mouth.faceScale, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.setLineDash([])
    if (placement) {
      ctx.beginPath()
      ctx.moveTo(mouth.center.x, mouth.center.y)
      ctx.lineTo(placement.mouthEnd.x, placement.mouthEnd.y)
      ctx.stroke()
    }
  }
  if (placement) {
    for (const [p, label, color] of [
      [placement.mouthEnd, 'F', '#ffb74d'],
      [placement.emberEnd, 'E', '#ff5252'],
    ] as const) {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillText(label, p.x + 7, p.y - 7)
    }
  }
  if (smokeSource) {
    const { x, y } = smokeSource.position
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(x - 8, y)
    ctx.lineTo(x + 8, y)
    ctx.moveTo(x, y - 8)
    ctx.lineTo(x, y + 8)
    ctx.stroke()
  }
  ctx.restore()
}

function ScoreMeter({ label, value, threshold }: { label: string; value: number; threshold: number }) {
  return (
    <div className="score-meter">
      <span>{label}</span>
      <div className="score-bar" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={value}>
        <div
          className={value >= threshold ? 'fill over' : 'fill'}
          style={{ width: `${Math.min(value, 1) * 100}%` }}
        />
        <div className="threshold" style={{ left: `${threshold * 100}%` }} />
      </div>
      <output>{value.toFixed(2)}</output>
    </div>
  )
}

function describeStatus(d: TrackedPen | null): string {
  if (!d) return '未検出'
  if (d.status === 'held') return '見失い中（直前の結果を保持）'
  const parts = [d.segments.length > 1 ? `検出中（${d.segments.length} 領域を結合）` : '検出中']
  if (d.lengthCompleted) parts.push('長さ補完')
  return parts.join('・')
}

function strokeQuad(ctx: CanvasRenderingContext2D, corners: PenDetection['corners']) {
  ctx.beginPath()
  corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.closePath()
  ctx.stroke()
}

function drawDetection(ctx: CanvasRenderingContext2D, d: TrackedPen, label = '') {
  const held = d.status === 'held'
  const color = held ? '#ff9800' : '#00e676'
  ctx.save()

  // 結合した各輪郭（分断時のみ）
  if (d.segments.length > 1) {
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#00b8d4'
    for (const segment of d.segments) strokeQuad(ctx, segment.corners)
  }

  // ペン全体の回転枠。保持中・長さ補完中は破線
  ctx.lineWidth = 3
  ctx.strokeStyle = color
  ctx.setLineDash(held || d.lengthCompleted ? [8, 6] : [])
  strokeQuad(ctx, d.corners)
  ctx.setLineDash([])

  ctx.lineWidth = 2
  ctx.strokeStyle = '#ffeb3b'
  ctx.beginPath()
  ctx.moveTo(d.endpoints[0].x, d.endpoints[0].y)
  ctx.lineTo(d.endpoints[1].x, d.endpoints[1].y)
  ctx.stroke()

  ctx.fillStyle = '#ffeb3b'
  for (const p of [d.center, ...d.endpoints]) {
    ctx.beginPath()
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.font = '14px system-ui, sans-serif'
  ctx.fillStyle = color
  const suffix = (d.segments.length > 1 ? `  ×${d.segments.length}` : '') + (label ? `  ${label}` : '')
  ctx.fillText(
    `${d.angleDeg.toFixed(0)}°  L${d.length.toFixed(0)}  T${d.thickness.toFixed(0)}${suffix}`,
    d.center.x + 8,
    d.center.y - 8,
  )
  ctx.restore()
}

function cameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
        return 'カメラの使用が許可されていません。ブラウザ/macOS のカメラ権限を確認してください。'
      case 'NotFoundError':
        return 'カメラが見つかりません。'
      case 'NotReadableError':
        return 'カメラを使用できません（他のアプリが使用中の可能性があります）。'
      case 'OverconstrainedError':
        return '要求した解像度・カメラ条件を満たすデバイスがありません。'
    }
  }
  return error instanceof Error ? error.message : String(error)
}
