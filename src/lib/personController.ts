import { CigaretteOrienter } from './cigaretteOrientation'
import {
  chooseCgKind,
  placeCigarette,
  type CgKind,
  type CigarettePlacement,
  type CigaretteSettings,
} from './cigaretteRenderer'
import { FaceTrackManager, type TrackedFace } from './faceTracks'
import type { TrackedHand } from './handTracker'
import { MultiPenTracker, type IdentifiedPen, type PenInfo } from './multiPenTracker'
import type { Mouth } from './mouthTracker'
import { DEFAULT_ASSIGN, PenAssigner, handOwner, type AssignSettings, type PenOwnership } from './penAssignment'
import type { PenDetection, Point2 } from './penGeometry'
import type { TrackingSettings } from './penTracking'
import { MAX_PARTICLES, SmokeEffect, resolveSmokeSource, type SmokeSettings, type SmokeSource } from './smokeEffect'
import { SmokeStateMachine, type SmokeFsmOutput } from './smokeStateMachine'

/** STEP 5：同時に扱う人数（1 人モードは STEP 4 までと同じ動作） */
export type PersonMode = 1 | 2 | 3

/** 1 人モードの人物 ID（顔の有無にかかわらず常に存在する） */
export const SOLO_PERSON_ID = 1
/** 複数人のときの、全員分の煙の粒子数の上限（1 人あたり MAX_PARTICLES を超えない） */
export const MULTI_PARTICLE_BUDGET = 900

/** 着火していないときの煙の状態（状態機械は止めておく） */
export const UNLIT_SMOKE: SmokeFsmOutput = { state: 'IDLE', emitter: 'none', exhaleReady: false, inhaleMs: 0 }

/** 人物ごとの状態（人物 A の操作が人物 B に影響しないよう、煙の状態機械と粒子を人物ごとに持つ） */
type PersonRecord = {
  id: number
  smokeFsm: SmokeStateMachine
  smoke: SmokeEffect
  /** 口元の煙を噴き出す向き（顔がほぼ正面のときは直前の向きを使う） */
  exhaleSide: number
  /** STEP 10：煙の向きに使う、時間で平滑化した顔の向き（−1〜1）と、その更新時刻 */
  exhaleFacing: number
  exhaleFacingAt: number | null
  /** 最後に顔を検出した時刻 */
  lastSeenAt: number
  lastSmoke: SmokeFsmOutput
}

/** 1 フレーム分の人物の情報（描画・UI 用） */
export type PersonView = {
  id: number
  /** 口元（見失って validMs を過ぎたら null） */
  face: TrackedFace | null
  /** 対応付けたペン（無ければ null） */
  pen: IdentifiedPen | null
  ownership: PenOwnership | null
  /** タバコ CG の配置（ペンが無い、または CG を表示しないときは null） */
  placement: CigarettePlacement | null
  /** タバコの向き（吸い口 → 火）。自動方向補正が OFF なら null */
  emberDir: Point2 | null
  /** STEP 6：CG の種類（ペンが無ければ null） */
  kind: CgKind | null
  /** 吸い口と唇の中心の距離（顔の大きさで正規化） */
  filterDistance: number | null
  lastSeenAt: number
}

/** 人物に対応付けられていないペン（複数人モードのみ）。CG は未着火で描き、着火・煙の対象にしない */
export type UnassignedPen = {
  pen: IdentifiedPen
  placement: CigarettePlacement | null
  emberDir: Point2 | null
  kind: CgKind
  ownership: PenOwnership | null
}

export type TrackInput = {
  now: number
  mode: PersonMode
  /** ペン検出器の今フレームの結果 */
  measuredPens: PenDetection[]
  /** STEP 6：measuredPens と同じ順番の検出色・形状スコア（無ければ省略） */
  penInfo?: PenInfo[]
  /** 顔の推論結果（fresh = false のフレームは空） */
  mouths: Mouth[]
  mouthsFresh: boolean
  hands: TrackedHand[]
  tracking: TrackingSettings
  cigarette: CigaretteSettings
  /** タバコ CG を表示するか（重ね表示が「認識枠」のみなら false。従来どおり着火・煙の判定もしない） */
  showCigarette: boolean
  assign?: AssignSettings
}

export type TrackFrame = {
  persons: PersonView[]
  unassigned: UnassignedPen[]
  pens: IdentifiedPen[]
  /** 口元が有効な顔の数 */
  facesVisible: number
  /** このフレームで追跡データを破棄した人物 ID（着火状態の破棄に使う） */
  removedPersonIds: number[]
  /** STEP 10：手のキー → 持ち主の人物 ID（1 人モードは全員その人物。複数人で曖昧なら null） */
  handOwners: Map<string, number | null>
}

export type SmokeInput = {
  now: number
  frameWidth: number
  frameHeight: number
  settings: SmokeSettings
  /** 人物が着火済みか */
  isLit: (personId: number) => boolean
  /** デバッグ用の「煙をテスト発生」中 */
  testBurst: boolean
}

export type PersonSmoke = {
  personId: number
  state: SmokeFsmOutput
  source: SmokeSource | null
  /** STEP 10：煙の向きに使った、平滑化した顔の向き（−1 左 〜 0 正面 〜 1 右。顔が無ければ null） */
  facing: number | null
}

/** STEP 10：煙の向きに使う顔の向きの平滑化の時定数 ms（急に向きが切り替わらないように） */
export const EXHALE_FACING_TAU_MS = 180

/**
 * STEP 5：複数人の顔・ペン・手の追跡と、人物ごとの状態の管理。
 *
 * 1. 顔：FaceTrackManager で顔ごとの追跡 ID（＝人物 ID）を維持する。
 * 2. ペン：MultiPenTracker でペンごとの追跡 ID を維持する。
 * 3. 対応付け：PenAssigner でペンと人物を一対一に対応付ける（曖昧なら直前の対応を保持、または未割当）。
 * 4. 人物ごとに タバコの向き・煙の状態機械・煙の粒子 を独立して持つ（着火状態は FireController が人物 ID ごとに持つ）。
 * 5. 顔の追跡データが破棄された（画面外に出て一定時間たった）人物は、状態と粒子を解放する。
 *
 * 1 人モードでは、人物は常に 1 人（SOLO_PERSON_ID）で、検出した 1 本のペンと 1 つの顔をその人物のものとみなす
 * （距離による対応付けをしない）。これは STEP 4 までの動作と同じ。
 */
export class PersonController {
  readonly faces = new FaceTrackManager()
  readonly pens = new MultiPenTracker()
  readonly assigner = new PenAssigner()
  private readonly persons = new Map<number, PersonRecord>()
  /** タバコの向きはペンごとに保持する（同じペンの向きがフレーム間で入れ替わらないように） */
  private readonly orienters = new Map<number, CigaretteOrienter>()
  /** 自動選択の CG の種類（ペンごと。しきい値付近でちらつかないよう直前の種類を覚える） */
  private readonly kinds = new Map<number, CgKind>()
  private mode: PersonMode = 1

  /** 人数モードの変更・カメラ停止・左右反転の切り替え時に、追跡と人物の状態をすべて捨てる。捨てた人物 ID を返す */
  reset(): number[] {
    const removed = [...this.persons.keys()]
    for (const p of this.persons.values()) p.smoke.clear()
    this.faces.reset()
    this.pens.reset()
    this.assigner.reset()
    this.persons.clear()
    this.orienters.clear()
    this.kinds.clear()
    return removed
  }

  get currentMode(): PersonMode {
    return this.mode
  }

  /** 状態を覚えている人物 ID */
  get personIds(): number[] {
    return [...this.persons.keys()]
  }

  /** 人物ごとの煙の状態機械（消火時のリセットなど） */
  resetSmoke(personId?: number): void {
    for (const p of this.persons.values()) {
      if (personId === undefined || p.id === personId) p.smokeFsm.reset()
    }
  }

  clearSmoke(): void {
    for (const p of this.persons.values()) {
      p.smoke.clear()
      p.smokeFsm.reset()
    }
  }

  get particleCount(): number {
    let n = 0
    for (const p of this.persons.values()) n += p.smoke.particleCount
    return n
  }

  track(input: TrackInput): TrackFrame {
    const { now, mode } = input
    const removedPersonIds: number[] = []
    if (mode !== this.mode) {
      removedPersonIds.push(...this.reset())
      this.mode = mode
    }
    const faces = this.faces.update(input.mouths, input.mouthsFresh, now, mode)
    const pens = this.pens.update(input.measuredPens, now, input.tracking, mode, input.penInfo)

    // ペンと人物の対応付け
    let ownerships: PenOwnership[]
    const personIds: number[] = []
    const faceOf = new Map<number, TrackedFace>()
    if (mode === 1) {
      personIds.push(SOLO_PERSON_ID)
      if (faces[0]) faceOf.set(SOLO_PERSON_ID, faces[0])
      ownerships = pens.slice(0, 1).map((pen) => ({
        penId: pen.id,
        personId: SOLO_PERSON_ID,
        distance: null,
        ambiguous: false,
        handOwner: null,
      }))
    } else {
      for (const f of faces) faceOf.set(f.id, f)
      personIds.push(...this.faces.rememberedIds)
      ownerships = this.assigner.update(
        pens.map((p) => ({ id: p.id, endpoints: p.endpoints, thickness: p.thickness, velocity: p.velocity })),
        faces.map((f) => ({ id: f.id, mouth: f.center, faceScale: f.faceScale, velocity: f.velocity })),
        input.hands.map((h) => ({ points: h.landmarks, wrist: h.sample.wrist, scale: h.sample.scale })),
        this.faces.rememberedIds,
        now,
        input.assign ?? DEFAULT_ASSIGN,
      )
    }

    // 人物の状態：新しい人物は作り、追跡データが破棄された人物は解放する
    const alive = new Set(personIds)
    for (const id of [...this.persons.keys()]) {
      if (alive.has(id)) continue
      this.persons.get(id)!.smoke.clear()
      this.persons.delete(id)
      this.assigner.forgetPerson(id)
      removedPersonIds.push(id)
    }
    for (const id of personIds) {
      let record = this.persons.get(id)
      if (!record) {
        record = {
          id,
          smokeFsm: new SmokeStateMachine(),
          smoke: new SmokeEffect(),
          exhaleSide: 1,
          exhaleFacing: 0,
          exhaleFacingAt: null,
          lastSeenAt: now,
          lastSmoke: UNLIT_SMOKE,
        }
        this.persons.set(id, record)
      }
      if (faceOf.has(id)) record.lastSeenAt = now
    }
    const limit = mode === 1 ? MAX_PARTICLES : Math.min(MAX_PARTICLES, Math.floor(MULTI_PARTICLE_BUDGET / Math.max(this.persons.size, 1)))
    for (const p of this.persons.values()) p.smoke.maxParticles = limit

    // ペンごとの向き（持ち主の口元に近い端をフィルターにする）と CG の配置。
    // 1 人モードは従来どおり向きを 1 つだけ持つ（ペンを見失って再検出しても直前の向きを引き継ぐ）
    const orienterKey = (pen: IdentifiedPen) => (mode === 1 ? 0 : pen.id)
    const penKeys = new Set(pens.map(orienterKey))
    for (const key of [...this.orienters.keys()]) if (mode !== 1 && !penKeys.has(key)) this.orienters.delete(key)
    for (const key of [...this.kinds.keys()]) if (mode !== 1 && !penKeys.has(key)) this.kinds.delete(key)
    const ownerOf = new Map(ownerships.map((o) => [o.penId, o]))
    const layout = (pen: IdentifiedPen, face: TrackedFace | null) => {
      let orienter = this.orienters.get(orienterKey(pen))
      if (!orienter) {
        orienter = new CigaretteOrienter()
        this.orienters.set(orienterKey(pen), orienter)
      }
      const emberDir = input.cigarette.autoOrient ? orienter.update(pen, face) : null
      let kind: CgKind
      if (input.cigarette.kind === 'auto') {
        kind = chooseCgKind(pen.length / Math.max(pen.thickness, 1), this.kinds.get(orienterKey(pen)) ?? null)
        this.kinds.set(orienterKey(pen), kind)
      } else {
        kind = input.cigarette.kind
      }
      const placement = input.showCigarette ? placeCigarette(pen, input.cigarette, emberDir, kind) : null
      return { emberDir, placement, kind }
    }

    const persons: PersonView[] = personIds.map((id) => {
      const face = faceOf.get(id) ?? null
      const ownership = ownerships.find((o) => o.personId === id) ?? null
      const pen = ownership ? (pens.find((p) => p.id === ownership.penId) ?? null) : null
      const { emberDir, placement, kind } = pen ? layout(pen, face) : { emberDir: null, placement: null, kind: null }
      const filterDistance =
        face && placement
          ? Math.hypot(placement.mouthEnd.x - face.center.x, placement.mouthEnd.y - face.center.y) / face.faceScale
          : null
      return { id, face, pen, ownership, placement, emberDir, kind, filterDistance, lastSeenAt: this.persons.get(id)!.lastSeenAt }
    })
    const unassigned: UnassignedPen[] = pens
      .filter((p) => !persons.some((v) => v.pen?.id === p.id))
      .map((pen) => ({ pen, ...layout(pen, null), ownership: ownerOf.get(pen.id) ?? null }))

    // STEP 10：手の持ち主（灰落としで、その人のタバコだけを叩けるようにする）
    const handOwners = new Map<string, number | null>()
    const assignPersons = faces.map((f) => ({ id: f.id, mouth: f.center, faceScale: f.faceScale, velocity: f.velocity }))
    for (const h of input.hands) {
      handOwners.set(
        h.key,
        mode === 1 ? SOLO_PERSON_ID : handOwner({ points: h.landmarks, wrist: h.sample.wrist, scale: h.sample.scale }, assignPersons),
      )
    }

    return { persons, unassigned, pens, facesVisible: faces.length, removedPersonIds, handOwners }
  }

  /** 人物ごとに煙の状態機械を進め、粒子を更新する（描画は drawSmoke） */
  updateSmoke(frame: TrackFrame, input: SmokeInput): PersonSmoke[] {
    const { now, settings } = input
    const out: PersonSmoke[] = []
    for (const view of frame.persons) {
      const record = this.persons.get(view.id)
      if (!record) continue
      let state: SmokeFsmOutput = UNLIT_SMOKE
      let source: SmokeSource | null = null
      // STEP 10：顔の向きを時間で平滑化してから煙の向きに使う（正面 ↔ 斜め ↔ 横が急に切り替わらない）
      let facing: number | null = null
      if (view.face) {
        const dt = record.exhaleFacingAt === null ? Infinity : Math.max(now - record.exhaleFacingAt, 0)
        const a = 1 - Math.exp(-dt / EXHALE_FACING_TAU_MS)
        record.exhaleFacing += (view.face.facing - record.exhaleFacing) * a
        record.exhaleFacingAt = now
        facing = record.exhaleFacing
      } else {
        record.exhaleFacingAt = null
      }
      if (settings.enabled) {
        const sourceInput = {
          emberEnd: view.placement?.emberEnd ?? null,
          cigaretteThickness: view.placement?.thickness ?? 0,
          mouth: view.face && facing !== null ? { center: view.face.center, width: view.face.width, facing } : null,
          frameWidth: input.frameWidth,
        }
        if (input.isLit(view.id)) {
          state = record.smokeFsm.update(
            {
              now,
              faceSampleId: view.face?.sampleId ?? null,
              penVisible: view.placement !== null && view.pen?.status === 'measured',
              filterDistance: view.filterDistance,
              pucker: view.face?.pucker ?? 0,
              funnel: view.face?.funnel ?? 0,
            },
            settings,
          )
          source = resolveSmokeSource(state.emitter, sourceInput, record.exhaleSide)
        } else {
          // STEP 4：未着火では煙の状態機械を止め、煙を出さない
          record.smokeFsm.reset()
        }
        if (input.testBurst && (view.face || this.mode === 1)) {
          // デバッグ用：状態機械の発生源を口元の煙で置き換える（発生源は常に 1 つ）。1 人モードで顔が無ければ画面中央から
          source = resolveSmokeSource(
            'mouth',
            {
              ...sourceInput,
              mouth: view.face ?? {
                center: { x: input.frameWidth / 2, y: input.frameHeight * 0.45 },
                width: input.frameWidth * 0.1,
                facing: 0,
              },
            },
            record.exhaleSide,
          )
        }
        // 正面（横向きの成分がほぼ無い）のときは、直前の横の向きを保つ
        if (source?.kind === 'mouth' && source.frontal < 0.5) record.exhaleSide = Math.sign(source.direction.x) || 1
      }
      record.smoke.update(now, source, settings)
      record.lastSmoke = state
      out.push({ personId: view.id, state, source, facing })
    }
    return out
  }

  drawSmoke(ctx: CanvasRenderingContext2D, settings: SmokeSettings): void {
    for (const p of this.persons.values()) p.smoke.draw(ctx, settings)
  }
}
