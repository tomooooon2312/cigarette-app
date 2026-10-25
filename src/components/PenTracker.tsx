import { useCallback, useEffect, useRef, useState } from 'react'
import { useOpenCv } from '../hooks/useOpenCv'
import {
  CG_LABELS,
  CigaretteRenderer,
  DEFAULT_CIGARETTE,
  type CgChoice,
  type CgKind,
  type CigaretteLook,
  type CigarettePlacement,
  type CigaretteSettings,
} from '../lib/cigaretteRenderer'
import { DEFAULT_FIRE, FireController, type FireFrame, type FireSettings, type HandFireView } from '../lib/fireController'
import { FLAME_DURATION_MS, PREVIOUS_FLAME_DURATION_MS, type ActiveFlame } from '../lib/flameEffect'
import type { TapDebug } from '../lib/ashTap'
import { BURN_LIFETIME_MS, type CigaretteState } from '../lib/cigaretteLife'
import { DEFAULT_FAR, FAR_CRITERIA, MAX_ROIS, ROI_IMAGE_SIZE, CandidateMemory, buildRois, mergeDetections, roiSourceRect, type FarSettings, type Roi } from '../lib/farDetection'
import { FAR_HOLD_MS } from '../lib/penTracking'
import { HAND_CONNECTIONS, HandTracker, type TrackedHand } from '../lib/handTracker'
import type { IgnitionOutput } from '../lib/ignition'
import type { HoldState } from '../lib/handHold'
import { WAVE_MIN_REVERSALS, WAVE_MIN_SPEED, type WaveDebug } from '../lib/waveDetector'
import { LighterDetector } from '../lib/lighterDetector'
import type { SmallCandidate } from '../lib/penDetector'
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
import { CameraSwitcher, FACING_LABELS, cameraConstraints, defaultMirror, type CameraFacing } from '../lib/cameraSwitcher'
import { FILTERS, FILTER_IDS, cssFilter, vignetteCss, type FilterId } from '../lib/photoFilters'
import { canvasToJpeg, composePhoto, drawVideoFrame, photoFileName } from '../lib/photoCapture'
import { savePhoto } from '../lib/photoSaver'
import { scaleFace, type PosterFace } from '../lib/posterRenderer'
import { PosterEditor } from './PosterEditor'
import { GuideScreen } from './GuideScreen'
import { TabBar, type Screen } from './TabBar'
import type { SnapAttempt, SnapDebug } from '../lib/snapDetector'
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
  /** 親指と人差し指の距離（手の大きさで正規化、最初の手。STEP 9 までは親指と中指） */
  snapDistance: number | null
  /** 着火ジェスチャーのデバッグ（手ごとの段階・距離・接触時間など、灰落としのタップの状態、直近の評価の結果、成功の回数） */
  snapHands: (SnapDebug & { key: string; side: string; tap: TapDebug | null; hold: HandFireView | null; wave: WaveDebug | null })[]
  /** STEP 11：代表の人物のタバコ CG の全長 px（着火距離の px 表示） */
  cigaretteLength: number | null
  snapAttempts: SnapAttempt[]
  snapSuccesses: number
  /** STEP 10：炎の残り時間 */
  flameRemaining: { handKey: string | null; remainingMs: number; durationMs: number }[]
  /** STEP 10：タバコごとの燃焼の状態 */
  lives: { key: string; state: CigaretteState; burnMs: number; ash: number; exitCandidate: boolean; exited: boolean }[]
  /** STEP 10：人物ごとの、煙の向きに使った顔の向き・正面の度合い・横の向き */
  exhale: { personId: number; facing: number | null; frontal: number | null; side: number | null }[]
  ashParticles: number
  /** 遠距離認識：カメラの実際の解像度（MediaStreamTrack.getSettings）、ペン検出の時間 ms（全画面・ROI）、ROI の数、ROI で見つけた本数、予測中の本数 */
  cameraWidth: number
  cameraHeight: number
  detectMs: number
  roiMs: number
  rois: number
  roiPens: number
  predictedPens: number
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
  snapHands: [],
  cigaretteLength: null,
  snapAttempts: [],
  snapSuccesses: 0,
  flameRemaining: [],
  lives: [],
  exhale: [],
  ashParticles: 0,
  cameraWidth: 0,
  cameraHeight: 0,
  detectMs: 0,
  roiMs: 0,
  rois: 0,
  roiPens: 0,
  predictedPens: 0,
  persons: [],
  facesVisible: 0,
  pensTracked: 0,
  faceHz: 0,
  handHz: 0,
  particles: 0,
  penList: [],
}

/** STEP 9：撮影した写真（プレビュー中は blob と表示用の URL を持ち、保存・撮り直しで解放する） */
type Photo = {
  blob: Blob | null
  url: string | null
  thumb: string
  saved: boolean
  /** STEP 14：撮影時の顔（写真の座標）。ポスターの顔のパーツに使う */
  faces: PosterFace[]
}
type Toast = { kind: 'ok' | 'error' | 'info'; text: string }

/** 撮影した写真の小さな見本（下部の導線用）を作る。元の写真の blob は保持しない */
function makeThumb(source: HTMLCanvasElement): string {
  const t = document.createElement('canvas')
  const s = 96 / Math.max(source.width, source.height)
  t.width = Math.round(source.width * s)
  t.height = Math.round(source.height * s)
  t.getContext('2d')?.drawImage(source, 0, 0, t.width, t.height)
  const url = t.toDataURL('image/jpeg', 0.7)
  t.width = 0
  return url
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
  /** STEP 9：AR（タバコ CG・炎・煙・認識枠）を描く canvas。映像の canvas の上に重ね、フィルターをかけない */
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  /** STEP 9：カメラの切り替え（連打しても二重に開かない） */
  const switcherRef = useRef<CameraSwitcher | null>(null)
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
  // STEP 9：カメラの向き・切り替え中、フィルター、写真
  const [facing, setFacing] = useState<CameraFacing>('user')
  const [switching, setSwitching] = useState(false)
  const [filter, setFilter] = useState<FilterId>('normal')
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  /** STEP 14：映画ポスターの編集画面を開いているか */
  const [posterOpen, setPosterOpen] = useState(false)
  /** STEP 14：最後に検出した顔（表示座標）と時刻 */
  const posterFacesRef = useRef<{ faces: PosterFace[]; at: number }>({ faces: [], at: -Infinity })
  const [capturing, setCapturing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  /** STEP 15：表示中の画面（撮る / 設定 / 遊び方）。数値の調整は「設定」だけに出す */
  const [screen, setScreen] = useState<Screen>('camera')
  /** STEP 10：開発者向けの表示（デバッグ・調整）。通常のデモでは隠す */
  const [devMode, setDevMode] = useState(false)
  /** 遠距離認識モード（初期値 OFF） */
  const [far, setFar] = useState<FarSettings>(DEFAULT_FAR)
  /** 遠距離認識：ROI の画像を切り出す canvas（ROI_IMAGE_SIZE 四方。使い回す） */
  const roiCanvasRef = useRef<HTMLCanvasElement | null>(null)
  /** 遠距離認識：直前のフレームの顔（ROI を作るのに使う。顔の推論はペン検出の後なので 1 フレーム前の値） */
  const lastFacesRef = useRef<{ center: { x: number; y: number }; faceScale: number }[]>([])
  /** 遠距離認識：色の候補の ROI の空振りの記憶 */
  const candidateMemoryRef = useRef(new CandidateMemory())
  /** 遠距離認識：直前のフレームで見失っていた（held）ペンの位置 */
  const lastHeldRef = useRef<{ center: { x: number; y: number }; length: number }[]>([])

  // 描画ループからは ref 経由で最新値を読む（ループを張り直さないため）
  const settingsRef = useRef(settings)
  const trackingRef = useRef(tracking)
  const viewModeRef = useRef(viewMode)
  const overlayRef = useRef(overlay)
  const cigaretteSettingsRef = useRef(cigarette)
  const smokeSettingsRef = useRef(smoke)
  const fireSettingsRef = useRef(fire)
  const mirrorRef = useRef(mirror)
  const facingRef = useRef(facing)
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
  // 遠距離認識モード・開発者向けの表示（描画ループからは ref で読む）
  const farRef = useRef(far)
  const devModeRef = useRef(devMode)
  useEffect(() => {
    farRef.current = far
    devModeRef.current = devMode
    dirtyRef.current = true
  }, [far, devMode])
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
    const overlayCanvas = overlayCanvasRef.current
    overlayCanvas?.getContext('2d')?.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)

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

  /**
   * カメラの映像のトラックが終わったら（ケーブルが抜けた・他のアプリが使った等）カメラを止める。
   * STEP 9：切り替えで止めた古いカメラの終了は無視する（今の映像のトラックのときだけ反応する）
   */
  const watchTrackEnd = useCallback(
    (stream: MediaStream) => {
      const session = sessionRef.current
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (session !== sessionRef.current || streamRef.current !== stream) return
        stopCamera()
        setError('カメラが切断されました')
      })
    },
    [stopCamera],
  )

  /** STEP 9：座標系が変わる操作（左右反転・カメラの切り替え）の後に、追跡・煙・炎・AR の表示を初期化する */
  const resetTrackingAll = useCallback(() => {
    candidateMemoryRef.current.reset()
    lastHeldRef.current = []
    lastFacesRef.current = []
    resetPeople()
    handTrackerRef.current?.reset()
    fireRef.current.resetTracking()
    const overlayCanvas = overlayCanvasRef.current
    overlayCanvas?.getContext('2d')?.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)
    dirtyRef.current = true
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
      // STEP 9：選んでいるカメラ（初期はインカメラ）を開く
      const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(facingRef.current))
      if (!isCurrent()) {
        // 待機中に停止・アンマウントされた
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      watchTrackEnd(stream)

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
    // 遠距離認識：ペン検出の時間 ms（全画面・ROI。指数移動平均）
    let detectMs = 0
    let roiMs = 0
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
      // 処理解像度は「長い辺」を上限に縮める（iOS 対応：縦向きの iPhone のカメラは 720×1280 などになり、
      // 幅だけで縮めると横向きの約 3 倍の画素を処理してしまうため。横長の映像では従来と同じ）
      const scale = Math.min(1, perf.maxProcessWidth / Math.max(video.videoWidth, video.videoHeight))
      const width = Math.round(video.videoWidth * scale)
      const height = Math.round(video.videoHeight * scale)
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return

      // ミラーした映像そのものを解析するので、検出座標はそのまま表示座標として使える。
      // STEP 9：写真の合成（photoCapture.ts）と同じ変換で描く。CSS のフィルターは表示だけにかかり、この画素（OpenCV の入力）は元映像のまま
      drawVideoFrame(ctx, video, width, height, mirrorRef.current)
      // STEP 9：AR は映像と同じ大きさの別の canvas（透明）に描く
      const overlayCanvas = overlayCanvasRef.current
      if (!overlayCanvas) return
      if (overlayCanvas.width !== width || overlayCanvas.height !== height) {
        overlayCanvas.width = width
        overlayCanvas.height = height
      }
      const actx = overlayCanvas.getContext('2d')
      if (!actx) return
      actx.clearRect(0, 0, width, height)

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
      const detectStart = performance.now()
      const farOn = farRef.current.enabled && viewModeRef.current === 'camera'
      const smallCandidates: SmallCandidate[] = []
      const fullDetections = detector.detectColors(frameImage, settingsRef.current, colors, mode, {
        shape: shapeRef.current,
        hands: hands.map((h) => ({ points: h.landmarks, scale: h.sample.scale })),
        smallCandidates: farOn ? smallCandidates : undefined,
      })
      const detectEnd = performance.now()
      // 遠距離認識モード：小さく写った顔・手の近くだけ、カメラの映像から高解像度で切り出して小さいペンを探す
      let colored = fullDetections
      let rois: Roi[] = []
      let roiPens = 0
      // 全画面の検出で人数分のペンが見つかったときは ROI を調べない（近距離では追加の処理をしない）
      if (farOn && fullDetections.length < mode) {
        rois = buildRois(
          {
            faces: lastFacesRef.current,
            hands: hands.map((h) => ({ landmarks: h.landmarks, scale: h.sample.scale })),
            // 見失った直後のペン（予測で表示中）の位置。顔・手が小さすぎて MediaPipe で見つからないときの補助
            tracked: lastHeldRef.current,
            candidates: candidateMemoryRef.current.filter(smallCandidates, now),
            found: fullDetections.map((d) => d.pen),
          },
          width,
          height,
          MAX_ROIS[mode],
        )
        if (rois.length > 0) {
          const roiCanvas = (roiCanvasRef.current ??= Object.assign(document.createElement('canvas'), { width: ROI_IMAGE_SIZE, height: ROI_IMAGE_SIZE }))
          const rctx = roiCanvas.getContext('2d', { willReadFrequently: true })
          if (rctx) {
            const found = []
            for (const roi of rois) {
              const before = found.length
              // 処理解像度の座標（ミラー後）→ カメラの映像の座標。ミラーなら左右を反転して切り出す（表示・CG と同じ向き）
              const src = roiSourceRect(roi, width, scale, mirrorRef.current)
              rctx.setTransform(src.flip ? -1 : 1, 0, 0, 1, src.flip ? ROI_IMAGE_SIZE : 0, 0)
              rctx.drawImage(video, src.sx, src.sy, src.sw, src.sh, 0, 0, ROI_IMAGE_SIZE, ROI_IMAGE_SIZE)
              const roiImage = rctx.getImageData(0, 0, ROI_IMAGE_SIZE, ROI_IMAGE_SIZE)
              found.push(
                ...detector.detectInRoi(roiImage, roi, width, height, settingsRef.current, colors, mode, {
                  shape: shapeRef.current,
                  hands: hands.map((h) => ({ points: h.landmarks, scale: h.sample.scale })),
                }),
              )
              if (roi.kind === 'candidate' && found.length === before) candidateMemoryRef.current.miss(roi, now)
            }
            colored = mergeDetections(fullDetections, found, mode)
            roiPens = colored.length - fullDetections.length
          }
        }
      }
      const roiEnd = performance.now()
      detectMs = detectMs * 0.9 + (detectEnd - detectStart) * 0.1
      roiMs = roiMs * 0.9 + (roiEnd - detectEnd) * 0.1
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
          if (result.fresh) {
            faceSamples++
            // STEP 14：撮影したときの顔（ポスターの顔のパーツの配置に使う。表示座標）
            posterFacesRef.current = { faces: result.mouths.map((m) => m.poster), at: now }
          }
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
        // 遠距離認識モード：見失ったときの保持を長くし、保持中は直前の動きから位置を予測する（予測は検出と区別する）
        tracking: farRef.current.enabled
          ? { ...trackingRef.current, holdMs: Math.max(trackingRef.current.holdMs, FAR_HOLD_MS), predictHeld: true }
          : trackingRef.current,
        cigarette: cigaretteSettings,
        showCigarette: overlayMode !== 'frame',
      })
      for (const id of frame.removedPersonIds) fireRef.current.forget(String(id))
      lastFacesRef.current = frame.persons.flatMap((p) => (p.face ? [{ center: p.face.center, faceScale: p.face.faceScale }] : []))
      lastHeldRef.current = frame.pens.filter((p) => p.status === 'held').map((p) => ({ center: p.center, length: p.length }))

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
            thickness: p.placement!.thickness,
            ends: p.pen!.endpoints,
            measured: p.pen!.status === 'measured',
            hasAsh: p.placement!.kind !== 'pipe',
          })),
        settings: fireSettings,
        // STEP 10：複数人では、手の持ち主のタバコだけ灰を落とせる
        handOwners:
          mode === 1
            ? undefined
            : new Map([...frame.handOwners].map(([k, owner]) => [k, owner === null ? null : String(owner)])),
        // STEP 12：手が持っているかを調べるペン。人物のペンは CG の吸い口 → 火側の端、対応付けていないペンは両端（火側は不明）
        holdPens: [
          ...frame.persons.flatMap((p) =>
            p.pen && p.placement
              ? [{ key: `P${p.pen.id}`, owner: String(p.id), a: p.placement.mouthEnd, b: p.placement.emberEnd, emberKnown: true, measured: p.pen.status === 'measured' }]
              : [],
          ),
          ...frame.unassigned.map((u) => ({
            key: `P${u.pen.id}`,
            owner: null,
            a: u.pen.endpoints[0],
            b: u.pen.endpoints[1],
            emberKnown: false,
            measured: u.pen.status === 'measured',
          })),
        ],
      })
      const isLit = (personId: number) => fireFrame.ignitions.get(String(personId))?.state === 'LIT'

      // 重ね順：元映像（映像の canvas、フィルター）→ AR の canvas：タバコ CG → ライター CG → 炎 → 煙 → 認識枠・デバッグ表示
      const renderers = cigaretteRenderersRef.current
      const rendererKey = (pen: IdentifiedPen) => (mode === 1 ? 0 : pen.id)
      if (mode !== 1) {
        const keys = new Set(frame.pens.map(rendererKey))
        for (const key of [...renderers.keys()]) if (!keys.has(key)) renderers.delete(key)
      }
      const drawCigarette = (pen: IdentifiedPen, emberDir: PersonView['emberDir'], lit: boolean, kind: CgKind, look?: CigaretteLook) => {
        let renderer = renderers.get(rendererKey(pen))
        if (!renderer) {
          renderer = new CigaretteRenderer()
          renderers.set(rendererKey(pen), renderer)
        }
        renderer.draw(actx, pen, cigaretteSettings, now, emberDir, lit, kind, look)
      }
      if (overlayMode !== 'frame') {
        for (const p of frame.persons) {
          if (!p.pen) continue
          // STEP 10：燃え具合（巻紙の長さ・灰・シケモク）
          const life = fireFrame.lives.get(String(p.id))
          const look: CigaretteLook | undefined = life
            ? { progress: life.progress, ash: fireSettings.ash.enabled ? life.ash : 0, flash: life.flash, butt: life.state === 'BUTT' }
            : undefined
          drawCigarette(p.pen, p.emberDir, isLit(p.id), p.kind ?? 'cigarette', look)
        }
        // 人物に対応付けられないペン：未着火のタバコとして描く（着火・煙の対象にしない）
        for (const u of frame.unassigned) drawCigarette(u.pen, u.emberDir, false, u.kind)
      }
      if (fireFrame.lighter && overlayMode !== 'frame') drawLighter(actx, fireFrame.lighter, lighterPressedRef.current)
      fireRef.current.draw(actx, now)

      // 煙：人物ごとの状態機械が発生源を 1 つだけ選び、その人物の粒子として出す（未着火なら出さない）
      const smokes = people.updateSmoke(frame, {
        now,
        frameWidth: width,
        frameHeight: height,
        settings: smokeSettings,
        isLit,
        testBurst: smokeSettings.enabled && now < testBurstUntilRef.current,
      })
      people.drawSmoke(actx, smokeSettings)

      if (overlayMode !== 'cg') {
        for (const pen of frame.pens) drawDetection(actx, pen, colorLabel(colorSettingsRef.current.colors, pen))
      }
      if (fireFrame.lighter && overlayMode !== 'cg') drawLighterFrame(actx, fireFrame.lighter)
      // 遠距離認識の ROI（開発者向けの表示のときだけ）
      if (devModeRef.current && rois.length > 0) drawRois(actx, rois)
      if (smokeSettings.showDebug) {
        for (const p of frame.persons) {
          drawDebug(actx, {
            mouth: p.face,
            placement: p.placement,
            smokeSource: smokes.find((x) => x.personId === p.id)?.source ?? null,
            settings: smokeSettings,
          })
        }
        if (mode !== 1) drawPersonDebug(actx, frame)
      }
      // STEP 11：手の骨格・炎と火側の端の距離・着火距離の円（煙のデバッグ表示か、開発者向けの表示のとき）
      if (smokeSettings.showDebug || devModeRef.current) {
        drawFireDebug(actx, {
          hands,
          fire: fireFrame,
          placements: frame.persons.flatMap((p) => (p.placement ? [p.placement] : [])),
          pairs: frame.persons.flatMap((p) =>
            p.placement ? [{ placement: p.placement, ignition: fireFrame.ignitions.get(String(p.id)) ?? null }] : [],
          ),
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
          cigaretteLength: primary?.placement?.length ?? null,
          snapHands: hands.flatMap((h) => {
            const d = fireRef.current.snap.debug(h.key)
            return d
              ? [{ ...d, key: h.key, side: h.side, tap: fireRef.current.taps.debug(h.key), hold: fireFrame.handViews.get(h.key) ?? null, wave: fireRef.current.waves.debug(h.key) }]
              : []
          }),
          snapAttempts: fireRef.current.snap.recentAttempts,
          snapSuccesses: fireRef.current.snap.successes,
          flameRemaining: fireRef.current.flames.remaining(now),
          lives: [...fireFrame.lives].map(([key, l]) => ({
            key,
            state: l.state,
            burnMs: l.burnMs,
            ash: l.ash,
            exitCandidate: l.exitCandidate,
            exited: l.exited,
          })),
          exhale: smokes.map((x) => ({
            personId: x.personId,
            facing: x.facing,
            frontal: x.source?.kind === 'mouth' ? x.source.frontal : null,
            side: x.source?.kind === 'mouth' ? Math.sign(x.source.direction.x) : null,
          })),
          ashParticles: fireRef.current.ash.particleCount,
          cameraWidth: streamRef.current?.getVideoTracks()[0]?.getSettings().width ?? video.videoWidth,
          cameraHeight: streamRef.current?.getVideoTracks()[0]?.getSettings().height ?? video.videoHeight,
          detectMs,
          roiMs,
          rois: rois.length,
          roiPens,
          predictedPens: frame.pens.filter((p) => p.predicted).length,
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
  }, [cv, stopCamera, watchTrackEnd])

  // アンマウント時にカメラ・描画ループ・OpenCV の Mat をすべて解放
  useEffect(() => stopCamera, [stopCamera])

  /**
   * STEP 9：インカメラ・アウトカメラの切り替え。描画ループ・OpenCV・MediaPipe はそのまま使い、video の映像だけを差し替える。
   * 切り替え中は操作を受け付けず（連打しても 1 回）、失敗したら元のカメラに戻す。戻せなければカメラを止める。
   */
  const switchCamera = useCallback(async () => {
    const video = videoRef.current
    const old = streamRef.current
    if (!video || !old) return
    switcherRef.current ??= new CameraSwitcher((c) => navigator.mediaDevices.getUserMedia(c))
    const switcher = switcherRef.current
    if (switcher.busy) return
    const session = sessionRef.current
    const from = facingRef.current
    const target: CameraFacing = from === 'user' ? 'environment' : 'user'
    setSwitching(true)
    setToast(null)
    // 切り替え前のタバコ・炎・煙・追跡が新しいカメラの映像に残らないよう、先に消す
    resetTrackingAll()
    streamRef.current = null
    try {
      const result = await switcher.switchTo(target, { stream: old, facing: from })
      if (!result) return
      if (session !== sessionRef.current) {
        // 切り替え中にカメラが止められた
        result.stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = result.stream
      watchTrackEnd(result.stream)
      video.srcObject = result.stream
      await video.play()
      facingRef.current = result.facing
      setFacing(result.facing)
      // 左右反転はカメラに合わせる（インカメラは反転、アウトカメラは反転しない）。座標系が変わるので追跡を初期化する
      const nextMirror = defaultMirror(result.facing)
      mirrorRef.current = nextMirror
      setMirror(nextMirror)
      resetTrackingAll()
      if (result.restored) {
        setToast({ kind: 'error', text: `${FACING_LABELS[target]}に切り替えられなかったため、${FACING_LABELS[result.facing]}に戻しました` })
      }
    } catch (e) {
      if (session !== sessionRef.current) return
      stopCamera()
      setError(`カメラを切り替えられませんでした: ${cameraErrorMessage(e)}`)
    } finally {
      setSwitching(false)
    }
  }, [resetTrackingAll, stopCamera, watchTrackEnd])

  /** STEP 9：撮影。今の映像（フィルター）と AR を 1 枚に合成して、プレビューを開く */
  const takePhoto = async () => {
    const video = videoRef.current
    if (cameraStatus !== 'running' || switching || capturing || previewOpen || !video) return
    setCapturing(true)
    setToast(null)
    try {
      const canvas = composePhoto({ video, overlay: overlayCanvasRef.current, mirror: mirrorRef.current, filter })
      // STEP 14：直近 1 秒以内に検出した顔を、表示座標（処理解像度）から写真の座標へ
      const recent = posterFacesRef.current
      const frameWidth = overlayCanvasRef.current?.width ?? 0
      const faces =
        frameWidth > 0 && performance.now() - recent.at <= 1000 ? recent.faces.map((f) => scaleFace(f, canvas.width / frameWidth)) : []
      const blob = await canvasToJpeg(canvas)
      const thumb = makeThumb(canvas)
      // 合成に使った canvas のメモリをすぐに解放する
      canvas.width = 0
      canvas.height = 0
      setPhoto((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url)
        return { blob, url: URL.createObjectURL(blob), thumb, saved: false, faces }
      })
      setPreviewOpen(true)
    } catch (e) {
      setToast({ kind: 'error', text: `撮影できませんでした：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setCapturing(false)
    }
  }

  /** STEP 9：保存（iOS アプリは写真アプリ、Web 版はダウンロード）。保存したら写真のデータを解放する */
  const savePreviewPhoto = async () => {
    if (!photo?.blob || saving) return
    setSaving(true)
    try {
      const target = await savePhoto(photo.blob, photoFileName())
      setToast({ kind: 'ok', text: target === 'photos' ? '写真アプリに保存しました' : '画像をダウンロードしました' })
      if (photo.url) URL.revokeObjectURL(photo.url)
      setPhoto({ blob: null, url: null, thumb: photo.thumb, saved: true, faces: [] })
      setPreviewOpen(false)
      setPosterOpen(false)
    } catch (e) {
      setToast({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  /** STEP 9：撮り直す（撮った写真は保存せずに捨てる） */
  const retakePhoto = () => {
    if (saving) return
    if (photo?.url) URL.revokeObjectURL(photo.url)
    setPhoto(null)
    setPreviewOpen(false)
    setPosterOpen(false)
  }

  // 画面の通知は 3 秒で消す
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(timer)
  }, [toast])

  // アンマウント時に写真の URL を解放する
  const photoUrlRef = useRef<string | null>(null)
  useEffect(() => {
    photoUrlRef.current = photo?.url ?? null
  }, [photo])
  useEffect(
    () => () => {
      if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current)
    },
    [],
  )

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
    <div className={`pen-tracker screen-${screen}${running ? '' : ' is-idle'}`}>
      <div className="main-column">
      {/* STEP 9：上部の操作（フィルター・カメラの切り替え） */}
      <div className="top-bar">
        <div className="segmented filter-select" role="group" aria-label="フィルター">
          {FILTER_IDS.map((id) => (
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {FILTERS[id].label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="switch-camera"
          onClick={switchCamera}
          disabled={!running || switching}
          aria-label={`${FACING_LABELS[facing === 'user' ? 'environment' : 'user']}に切り替え`}
        >
          ⟲ {facing === 'user' ? 'アウト' : 'イン'}
        </button>
      </div>
      {/* 映像の比率に枠を合わせる（iOS 対応：縦向きの iPhone で映像が小さくならないように。起動前は 16:9） */}
      <div
        className={`stage${running ? '' : ' idle'}`}
        style={stats.frameWidth > 0 && stats.frameHeight > 0 ? { aspectRatio: `${stats.frameWidth} / ${stats.frameHeight}` } : undefined}
      >
        <video ref={videoRef} className="source-video" playsInline muted />
        <canvas
          ref={canvasRef}
          className={`output-canvas${picking ? ' picking' : ''}`}
          // STEP 9：フィルターは映像の canvas の表示だけにかける（canvas の画素＝ OpenCV の入力は元映像のまま）
          style={{ filter: viewMode === 'camera' ? cssFilter(filter) : 'none' }}
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
        {viewMode === 'camera' && vignetteCss(filter) && (
          <div className="vignette" style={{ background: vignetteCss(filter)! }} aria-hidden="true" />
        )}
        {/* STEP 9：AR（タバコ CG・炎・煙）はフィルターの上に重ねる */}
        <canvas ref={overlayCanvasRef} className="overlay-canvas" aria-hidden="true" />
        {picking && <div className="pick-hint">ペンの上をタップしてください</div>}
        {switching && <div className="stage-loading">カメラを切り替え中…</div>}
        {toast && !previewOpen && <div className={`toast toast-${toast.kind}`} role="status">{toast.text}</div>}
        {running && personMode === 1 && (
          <div className="stage-badges" aria-live="polite">
            <div className={`smoke-badge ignition-${ignitionState.toLowerCase()}`}>{STATE_LABELS[ignitionState] ?? ignitionState}</div>
            {smoke.enabled && stats.smoke && (
              <div className={`smoke-badge state-${stats.smoke.state.toLowerCase()}`}>
                {STATE_LABELS[stats.smoke.state] ?? stats.smoke.state}
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
                  <span style={{ color: personColor(p.id) }}>#{p.id}</span> {STATE_LABELS[p.ignition] ?? p.ignition}
                  {smoke.enabled && p.ignition === 'LIT' && ` · ${STATE_LABELS[p.smoke] ?? p.smoke}`}
                </div>
              ))}
            {stats.flames.length > 0 && <div className="smoke-badge flame-on">炎</div>}
          </div>
        )}
        {!running && (
          <div className="stage-home">
            <div className="vtitle">
              <h1>シブガレット</h1>
              <span className="vtitle-seal" aria-hidden="true">
                渋
              </span>
            </div>
            <p className="home-lead">
              ペンを、一本のタバコに。
              <br />
              指を鳴らして、火を灯す。
            </p>
            <button type="button" className="btn-primary big" onClick={startCamera} disabled={cvStatus !== 'ready' || cameraStatus === 'starting'}>
              {cameraStatus === 'starting' ? 'カメラを起動中…' : 'カメラを起動'}
            </button>
            {cvStatus === 'loading' && <p className="home-status">準備中（画像処理を読み込んでいます）…</p>}
            {cvStatus === 'error' && <p className="home-status error">画像処理の読み込みに失敗しました：{cvError}</p>}
            {error && <p className="home-status error">{error}</p>}
          </div>
        )}
      </div>
      {/* STEP 9：下部の操作（カメラの起動・撮影・最後に撮った写真） */}
      <div className="bottom-bar">
        {running || cameraStatus === 'starting' ? (
          <button type="button" className="camera-toggle" onClick={stopCamera} disabled={switching}>
            カメラ停止
          </button>
        ) : (
          // 起動は映像の上の「カメラを起動」から（下部の左は空けておく）
          <span />
        )}
        <button
          type="button"
          className="shutter"
          onClick={takePhoto}
          disabled={!running || switching || capturing || previewOpen}
          aria-label="撮影"
        >
          <span />
        </button>
        <button
          type="button"
          className="photo-thumb"
          disabled={!photo}
          aria-label="撮影した写真"
          onClick={() => {
            if (photo?.url) setPreviewOpen(true)
            else if (photo?.saved) setToast({ kind: 'info', text: '保存した写真は写真アプリで確認できます' })
          }}
        >
          {photo ? <img src={photo.thumb} alt="" /> : <span>写真</span>}
        </button>
      </div>
      </div>

      {/* STEP 15：設定の画面（数値・判定の調整）。上に小さく映像を出したまま調整できる */}
      {screen === 'settings' && (
      <section className="settings-screen" aria-label="設定">
      <header className="page-head">
        <h1>設定</h1>
        <p>判定の数値や色の調整。上の映像で効き目を確かめながら変えられます。</p>
      </header>
      <div className="panel">
        <label className="checkbox dev-toggle">
          <input type="checkbox" checked={devMode} onChange={(e) => setDevMode(e.target.checked)} />
          開発者向けの表示（着火ジェスチャー・灰落とし・シケモク・吐煙のデバッグと強制操作）
        </label>
        <div className="toolbar">
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
              {devMode && stats.ignition && ` · ${stats.ignition.reason}`}
            </dd>
            <dt>炎</dt>
            <dd>
              {stats.flames.length > 0 ? `表示中（${describeFlames(stats.flames)}）` : 'なし'}
              {devMode &&
                stats.flameRemaining.map((f, i) => (
                  <span key={i}>{` · 残り ${(f.remainingMs / 1000).toFixed(1)} / ${(f.durationMs / 1000).toFixed(1)}秒`}</span>
                ))}
            </dd>
            <dt>タバコの状態</dt>
            <dd>
              {stats.lives.length === 0
                ? '—'
                : stats.lives.map((l) => `${LIFE_LABELS[l.state]}（${(l.burnMs / 1000).toFixed(0)} / ${BURN_LIFETIME_MS / 1000}秒）`).join('、')}
            </dd>
            <dt>手</dt>
            <dd>
              {describeFaceStatus(handStatus, handResult?.error ?? null, running, handNeeded)}
              {handStatus === 'ready' &&
                ` · ${stats.hands} 本${stats.snapDistance !== null ? ` · 親指-人差し指 ×${stats.snapDistance.toFixed(2)}` : ''}`}
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
            着火ジェスチャー（親指と人差し指、MediaPipe Hand Landmarker）
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={fire.lighterEnabled}
              onChange={(e) => updateFire({ lighterEnabled: e.target.checked })}
            />
            長方形の小物をライターにする
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={fire.waveExtinguish}
              onChange={(e) => updateFire({ waveExtinguish: e.target.checked })}
            />
            手を振ると指先の火が消える
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
          <h3>着火ジェスチャー（親指と人差し指）</h3>
          <p className="note">
            炎の表示時間 {(FLAME_DURATION_MS / 1000).toFixed(1)} 秒（STEP 9 までは {(PREVIOUS_FLAME_DURATION_MS / 1000).toFixed(1)} 秒）。
          </p>
          <Slider
            label="接触距離"
            value={fire.snap.contactDistance}
            min={0.1}
            max={0.6}
            step={0.02}
            format={(v) => `×${v.toFixed(2)}`}
            onChange={(v) =>
              updateFire({
                snap: { ...fire.snap, contactDistance: v, releaseDistance: Math.max(fire.snap.releaseDistance, v + 0.15) },
              })
            }
          />
          <Slider
            label="接触の解除距離"
            value={fire.snap.contactExitDistance}
            min={0.1}
            max={1}
            step={0.02}
            format={(v) => `×${v.toFixed(2)}`}
            onChange={(v) => updateFire({ snap: { ...fire.snap, contactExitDistance: v } })}
          />
          <Slider
            label="離れる距離"
            value={fire.snap.releaseDistance}
            min={0.3}
            max={1.2}
            step={0.05}
            format={(v) => `×${v.toFixed(2)}`}
            onChange={(v) =>
              updateFire({
                snap: { ...fire.snap, releaseDistance: v, contactDistance: Math.min(fire.snap.contactDistance, v - 0.15) },
              })
            }
          />
          <Slider
            label="離れる速さ"
            value={fire.snap.minSpeed}
            min={0.5}
            max={6}
            step={0.1}
            format={(v) => `${v.toFixed(1)}/s`}
            onChange={(v) => updateFire({ snap: { ...fire.snap, minSpeed: v } })}
          />
          <Slider
            label="接触時間"
            value={fire.snap.minContactMs}
            min={0}
            max={300}
            step={10}
            format={(v) => `${v}ms`}
            onChange={(v) => updateFire({ snap: { ...fire.snap, minContactMs: v } })}
          />
          <Slider
            label="離す制限時間"
            value={fire.snap.maxReleaseMs}
            min={100}
            max={800}
            step={20}
            format={(v) => `${v}ms`}
            onChange={(v) => updateFire({ snap: { ...fire.snap, maxReleaseMs: v } })}
          />
          <Slider
            label="クールダウン"
            value={fire.snap.cooldownMs}
            min={200}
            max={3000}
            step={100}
            format={(v) => `${(v / 1000).toFixed(1)}秒`}
            onChange={(v) => updateFire({ snap: { ...fire.snap, cooldownMs: v } })}
          />
          {devMode && (
            <details className="snap-debug" open>
              <summary>着火ジェスチャー・灰落としのデバッグ（着火 成功 {stats.snapSuccesses} 回）</summary>
              <div className="toolbar fire-actions">
                <button
                  type="button"
                  disabled={!running}
                  onClick={() => {
                    // 着火ジェスチャーを使わずに炎だけを出す（手があれば人差し指の先端、無ければタバコの火側の端）
                    manualFlameRef.current = true
                    dirtyRef.current = true
                  }}
                >
                  炎を出す（テスト）
                </button>
                <button
                  type="button"
                  disabled={!running}
                  onClick={() => {
                    // 炎を使わずにタバコだけを着火する（シケモクは着火しない）
                    fireRef.current.lightAll(personsRef.current.personIds.map(String))
                    dirtyRef.current = true
                  }}
                >
                  タバコを着火（テスト）
                </button>
              </div>
              <dl className="readout">
                <dt>手の認識</dt>
                <dd>
                  {handStatus === 'ready'
                    ? `${stats.hands} 本 · 推論 ${stats.handHz.toFixed(0)} 回/秒`
                    : describeFaceStatus(handStatus, handResult?.error ?? null, running, handNeeded)}
                </dd>
                <dt>炎の有効時間</dt>
                <dd>
                  {stats.flameRemaining.length === 0
                    ? 'なし'
                    : stats.flameRemaining.map((f) => `残り ${(f.remainingMs / 1000).toFixed(1)} / ${(f.durationMs / 1000).toFixed(1)}秒`).join('、')}
                </dd>
                <dt>炎と火側の端</dt>
                <dd>
                  {stats.ignition?.flameDistance != null
                    ? `全長 ×${stats.ignition.flameDistance.toFixed(2)}（着火距離 ×${fire.ignition.igniteDistance.toFixed(2)}・${Math.round(stats.ignition.flameDistance * (stats.cigaretteLength ?? 0))}px / ${Math.round(fire.ignition.igniteDistance * (stats.cigaretteLength ?? 0))}px）`
                    : '—'}
                </dd>
                <dt>着火の判定</dt>
                <dd>{stats.ignition ? stats.ignition.reason : '—'}</dd>
              </dl>
              <ul>
                {stats.snapHands.length === 0 && <li>手が映っていません</li>}
                {stats.snapHands.map((h) => (
                  <li key={h.key}>
                    {h.key}（{h.side}・{h.mode === '3d' ? '3D' : '2D'}
                    {h.confidence !== null && `・信頼度 ${h.confidence.toFixed(2)}`}・間隔 {Math.round(h.intervalMs)}ms）：
                    {h.hold && `[${HOLD_LABELS[h.hold.state]}${h.hold.penKey ? `・${h.hold.penKey}` : ''}・握り ${h.hold.score.toFixed(2)}${h.hold.reason ? `・${h.hold.reason}` : ''}] `}
                    {h.unreliable ? '信頼度が低いため判定しない' : SNAP_STATUS_LABELS[h.status]}
                    {h.blocked && `（炎を止めた理由：${h.blocked}）`}
                    {h.holding && '（ペンをつまんでいる）'}
                    {` · 親指-人差し指 ×${h.distance.toFixed(2)} · 接触 ${Math.round(h.contactMs)}ms · 離れる速さ ${h.releaseSpeed.toFixed(1)}/s`}
                    {h.cooldownMs > 0 && ` · クールダウン残り ${(h.cooldownMs / 1000).toFixed(1)}秒`}
                    {h.wave && ` · 手を振る 折り返し ${h.wave.reversals}/${WAVE_MIN_REVERSALS} 速さ ${h.wave.peakSpeed.toFixed(1)}/${WAVE_MIN_SPEED}`}
                    {h.tap &&
                      ` · タップ ${h.tap.targetKey ? `${TAP_PHASE_LABELS[h.tap.phase]} ×${Number.isFinite(h.tap.distance) ? h.tap.distance.toFixed(2) : '—'} ${h.tap.taps}回` : '対象なし'}${h.tap.lastReason ? `（${h.tap.lastReason}）` : ''}`}
                  </li>
                ))}
              </ul>
              <ol className="snap-attempts">
                {stats.snapAttempts.map((a) => (
                  <li key={`${a.handKey}-${a.time}`} className={a.ok ? 'ok' : 'ng'}>
                    {a.ok ? '成功' : '失敗'}（{a.handKey}・{a.mode === '3d' ? '3D' : '2D'}・接触 {Math.round(a.contactMs)}ms・離れる速さ {a.speed.toFixed(1)}・手首 {a.wristSpeed.toFixed(1)}）
                    {!a.ok && `：${a.reasons.join('、')}`}
                  </li>
                ))}
              </ol>
              <p className="note">
                「接触 → 離す」を 1 回評価するたびに記録します（新しい順）。距離は 2D を基本にし、3D のワールドランドマークが安定していれば小さい方を使います。
              </p>
            </details>
          )}
          <h3>灰落とし（人差し指で 2 回トントン）</h3>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={fire.ash.enabled}
              onChange={(e) => updateFire({ ash: { ...fire.ash, enabled: e.target.checked } })}
            />
            灰を表示し、トントンで落とす
          </label>
          <Slider
            label="叩く距離"
            value={fire.ash.tapNear}
            min={0.02}
            max={0.4}
            step={0.02}
            format={(v) => `×${v.toFixed(2)}`}
            onChange={(v) => updateFire({ ash: { ...fire.ash, tapNear: v, tapFar: Math.max(fire.ash.tapFar, v + 0.08) } })}
          />
          <Slider
            label="離す距離"
            value={fire.ash.tapFar}
            min={0.1}
            max={0.8}
            step={0.02}
            format={(v) => `×${v.toFixed(2)}`}
            onChange={(v) => updateFire({ ash: { ...fire.ash, tapFar: v, tapNear: Math.min(fire.ash.tapNear, v - 0.08) } })}
          />
          <Slider
            label="叩く速さ"
            value={fire.ash.tapMinSpeed}
            min={0.2}
            max={5}
            step={0.1}
            format={(v) => `${v.toFixed(1)}/s`}
            onChange={(v) => updateFire({ ash: { ...fire.ash, tapMinSpeed: v } })}
          />
          <Slider
            label="タップ回数"
            value={fire.ash.taps}
            min={1}
            max={4}
            step={1}
            format={(v) => `${v}回`}
            onChange={(v) => updateFire({ ash: { ...fire.ash, taps: v } })}
          />
          <Slider
            label="タップの制限時間"
            value={fire.ash.tapWindowMs}
            min={400}
            max={2500}
            step={100}
            format={(v) => `${(v / 1000).toFixed(1)}秒`}
            onChange={(v) => updateFire({ ash: { ...fire.ash, tapWindowMs: v } })}
          />
          <Slider
            label="灰のクールダウン"
            value={fire.ash.cooldownMs}
            min={200}
            max={4000}
            step={100}
            format={(v) => `${(v / 1000).toFixed(1)}秒`}
            onChange={(v) => updateFire({ ash: { ...fire.ash, cooldownMs: v } })}
          />
          <Slider
            label="灰の成長速度"
            value={fire.ash.growthRate}
            min={0}
            max={0.03}
            step={0.001}
            format={(v) => `全長 ×${(v * 100).toFixed(1)}%/秒`}
            onChange={(v) => updateFire({ ash: { ...fire.ash, growthRate: v } })}
          />
          {devMode && (
            <div className="toolbar fire-actions">
              <button
                type="button"
                disabled={!running}
                onClick={() => {
                  fireRef.current.requestAshDrop()
                  dirtyRef.current = true
                }}
              >
                灰を落とす（テスト）
              </button>
              <button
                type="button"
                disabled={!running}
                onClick={() => {
                  fireRef.current.forceButt(personsRef.current.personIds.map(String))
                  personsRef.current.resetSmoke()
                  dirtyRef.current = true
                }}
              >
                強制シケモク化
              </button>
              <button
                type="button"
                disabled={!running}
                onClick={() => {
                  fireRef.current.renew(personsRef.current.personIds.map(String))
                  personsRef.current.resetSmoke()
                  dirtyRef.current = true
                }}
              >
                新品に戻す（強制リセット）
              </button>
            </div>
          )}
          {devMode && (
            <ul className="snap-debug">
              {stats.lives.map((l) => (
                <li key={l.key}>
                  人物 {l.key}：{LIFE_LABELS[l.state]} · 燃焼 {(l.burnMs / 1000).toFixed(1)} 秒 · 灰 全長 ×{l.ash.toFixed(3)}
                  {l.exitCandidate && ' · 画面の端で見失った（退出の候補）'}
                  {l.exited && ' · 退出を確定（次に映ったら新品）'}
                </li>
              ))}
              <li>落ちている灰の粒子 {stats.ashParticles} 個</li>
            </ul>
          )}
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
            着火ジェスチャー：親指と人差し指の先をくっつけてから素早く離すと、人差し指の先に炎が 5 秒出て、指先に追従します（手の大きさで正規化した距離で判定し、手のひら・手の甲・斜めのどれでも判定する想定。両手対応。ペンをつまんでいる指では判定しません）。着火中のタバコを人差し指で 2 回トントンと叩くと灰が落ちます。着火から 60 秒燃えるとシケモクになり、画面の外に出して戻すと新品になります。炎にタバコの火側の端を近づけると着火（LIT）し、着火後だけ吸う・吐くの煙が出ます。ライターは単色の長方形の小物（既定は青）を認識し、ボタンを押している間だけ火口に炎を出します。着火距離はタバコの全長に対する倍率。
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
          {devMode && (
            <ul className="snap-debug">
              {stats.exhale.length === 0 && <li>吐煙：人物がいません</li>}
              {stats.exhale.map((x) => (
                <li key={x.personId}>
                  人物 {x.personId}：顔の向き {x.facing === null ? '—' : `${x.facing >= 0 ? '+' : ''}${x.facing.toFixed(2)}`}
                  {x.frontal !== null
                    ? ` · 吐煙 正面 ${Math.round(x.frontal * 100)}% / 横（${x.side! > 0 ? '右' : '左'}）${Math.round((1 - x.frontal) * 100)}%`
                    : ' · 吐煙なし'}
                </li>
              ))}
            </ul>
          )}
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
            <dt>カメラ</dt>
            <dd>{running && stats.cameraWidth > 0 ? `${stats.cameraWidth}×${stats.cameraHeight}（実際の取得解像度）` : '—'}</dd>
            <dt>検出時間</dt>
            <dd>
              {running
                ? `全画面 ${stats.detectMs.toFixed(1)}ms${far.enabled ? ` · ROI ${stats.roiMs.toFixed(1)}ms（${stats.rois} 個、${ROI_IMAGE_SIZE}×${ROI_IMAGE_SIZE}）` : ''}`
                : '—'}
            </dd>
            {far.enabled && (
              <>
                <dt>遠距離</dt>
                <dd>{running ? `ROI で検出 ${stats.roiPens} 本 · 予測で表示中 ${stats.predictedPens} 本` : '—'}</dd>
              </>
            )}
          </dl>
          <label className="checkbox">
            <input type="checkbox" checked={far.enabled} onChange={(e) => setFar({ enabled: e.target.checked })} />
            遠距離認識モード（顔・手の近くを高解像度で探し、小さく写ったペンも認識する。実験的・初期値 OFF）
          </label>
          <p className="note">
            遠距離認識モード：全画面の検出は従来のまま行い、小さく写った顔・手の近く（最大 {MAX_ROIS[1]}〜{MAX_ROIS[3]} か所）だけ、カメラの映像から{' '}
            {ROI_IMAGE_SIZE}px 四方で切り出して探します。ROI 内は面積 {FAR_CRITERIA.minArea}px² 以上・縦横比 {FAR_CRITERIA.minAspect} 以上・形状スコア{' '}
            {FAR_CRITERIA.minScore} 以上（全画面より厳しい）。見失ったときは {FAR_HOLD_MS}ms まで、直前の動きから予測した位置に CG を薄くして表示します（予測は検出とは別に数えます）。重い場合は OFF にすると元の処理に戻ります。
          </p>
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
      </section>
      )}

      {screen === 'guide' && <GuideScreen onClose={() => setScreen('camera')} />}
      <TabBar current={screen} onSelect={setScreen} />

      {/* STEP 9：撮影した写真のプレビュー（保存 / 撮り直す） */}
      {previewOpen && photo?.url && (
        <div className="photo-preview" role="dialog" aria-modal="true" aria-label="撮影した写真">
          <img src={photo.url} alt="撮影した写真" />
          <div className="photo-actions">
            <button type="button" onClick={retakePhoto} disabled={saving}>
              撮り直す
            </button>
            <button type="button" onClick={() => setPosterOpen(true)} disabled={saving || !photo.blob}>
              ポスターにする
            </button>
            <button type="button" className="primary" onClick={savePreviewPhoto} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
          {toast && !posterOpen && <div className={`toast toast-${toast.kind}`} role="status">{toast.text}</div>}
        </div>
      )}
      {/* STEP 14：映画ポスターにする（作風の選択・AI のタイトル生成・文字の編集・保存 / 共有） */}
      {previewOpen && posterOpen && photo?.blob && (
        <>
          <PosterEditor photo={photo.blob} faces={photo.faces} onClose={() => setPosterOpen(false)} onToast={setToast} />
          {toast && <div className={`toast toast-${toast.kind} poster-toast`} role="status">{toast.text}</div>}
        </>
      )}
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

/** STEP 15：撮る画面の状態の表示（着火・煙の状態を日本語で） */
const STATE_LABELS: Record<string, string> = {
  UNLIT: '未着火',
  LIT: '着火中',
  IDLE: '待機',
  SMOKING: '吸っている',
  EXHALING: '吐いている',
}

/** STEP 10：表示用のラベル */
const LIFE_LABELS: Record<CigaretteState, string> = { NEW: '新品', BURNING: '燃焼中', BUTT: 'シケモク' }
/** STEP 11：着火ジェスチャーの表示用の状態 */
const SNAP_STATUS_LABELS: Record<SnapDebug['status'], string> = {
  open: '離れている',
  contact: '接触中',
  releasing: '離脱中',
  success: '成功',
  failed: '失敗',
  cooldown: 'クールダウン',
  blocked: '判定しない（タバコを持つ手）',
  waitOpen: '指を開くまで待機（持つのをやめた直後）',
}
/** STEP 12：手がタバコを持っているかの表示 */
const HOLD_LABELS: Record<HoldState, string> = { FREE: 'FREE', HOLDING: 'HOLDING', UNKNOWN: 'UNKNOWN' }
const TAP_PHASE_LABELS: Record<TapDebug['phase'], string> = { far: '離れている', between: '近づいている', near: '叩いた位置' }

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

const ROI_COLORS: Record<Roi['kind'], string> = {
  face: 'rgba(64, 196, 255, 0.9)',
  hand: 'rgba(105, 240, 174, 0.9)',
  track: 'rgba(255, 215, 64, 0.9)',
  candidate: 'rgba(255, 128, 171, 0.9)',
}
const ROI_LABELS: Record<Roi['kind'], string> = { face: '顔', hand: '手', track: '追跡', candidate: '色の候補' }

/** 遠距離認識の ROI（探索範囲）の枠 */
function drawRois(ctx: CanvasRenderingContext2D, rois: Roi[]) {
  ctx.save()
  ctx.lineWidth = 1.5
  ctx.setLineDash([6, 4])
  ctx.font = 'bold 11px system-ui, sans-serif'
  for (const r of rois) {
    ctx.strokeStyle = ROI_COLORS[r.kind]
    ctx.strokeRect(r.x, r.y, r.size, r.size)
    ctx.fillStyle = ctx.strokeStyle
    ctx.fillText(`ROI ${ROI_LABELS[r.kind]}`, r.x + 4, r.y + 13)
  }
  ctx.restore()
}

/** デバッグ表示：手の骨格、親指-人差し指の距離、炎の位置、着火距離の円、ライターの火口 */
function drawFireDebug(
  ctx: CanvasRenderingContext2D,
  d: {
    hands: TrackedHand[]
    fire: FireFrame
    placements: CigarettePlacement[]
    /** STEP 11：タバコ CG の配置と、その着火状態 */
    pairs: { placement: CigarettePlacement; ignition: IgnitionOutput | null }[]
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
    // STEP 10：着火ジェスチャーは親指と人差し指の距離
    const { thumbTip, indexTip } = hand.sample
    if (indexTip) {
      ctx.strokeStyle = '#ffd740'
      ctx.beginPath()
      ctx.moveTo(thumbTip.x, thumbTip.y)
      ctx.lineTo(indexTip.x, indexTip.y)
      ctx.stroke()
    }
    const dist = d.snapDistance(hand.key)
    ctx.fillStyle = '#ffd740'
    const hold = d.fire.handViews.get(hand.key)
    ctx.fillText(
      `${hand.key} ${hold ? hold.state : ''}${hold?.penKey ? `→${hold.penKey}` : ''} ${dist !== null ? `×${dist.toFixed(2)}` : ''}`,
      thumbTip.x + 6,
      thumbTip.y - 6,
    )
    // STEP 9：炎を出す位置（人差し指の先端）
    const tip = hand.sample.indexTip
    if (tip) {
      ctx.strokeStyle = '#ff6d00'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(tip.x, tip.y, 6, 0, Math.PI * 2)
      ctx.stroke()
    }
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
    // STEP 11：着火判定に使う炎の線分（根元〜先端）
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(f.base.x, f.base.y)
    ctx.lineTo(f.tip.x, f.tip.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(f.base.x, f.base.y, 4, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.fillText(f.source, f.base.x + 8, f.base.y + 4)
  }
  // STEP 11：タバコごとに、火側の端から最も近い炎の点までの線と距離（着火距離内なら緑）
  for (const { placement: target, ignition: ig } of d.pairs) {
    if (!ig?.nearestFlamePoint || ig.flameDistance === null) continue
    const near = ig.flameDistance <= d.igniteDistance
    ctx.strokeStyle = near ? '#69f0ae' : '#ff5252'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(target.emberEnd.x, target.emberEnd.y)
    ctx.lineTo(ig.nearestFlamePoint.x, ig.nearestFlamePoint.y)
    ctx.stroke()
    ctx.fillStyle = ctx.strokeStyle
    ctx.fillText(`×${ig.flameDistance.toFixed(2)} / ×${d.igniteDistance.toFixed(2)}`, target.emberEnd.x + 8, target.emberEnd.y + 16)
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
