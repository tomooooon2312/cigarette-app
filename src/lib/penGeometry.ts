/**
 * ペン候補（輪郭）の幾何計算と、指などで分断された候補の結合。
 * OpenCV に依存しない純粋関数のみで構成する。
 */

export type Point2 = { x: number; y: number }
export type Quad = [Point2, Point2, Point2, Point2]

/** ピンク色の輪郭 1 つ分の計測値 */
export type PenSegment = {
  /** 輪郭面積 px² */
  area: number
  /** 輪郭の重心（モーメントから算出） */
  centroid: Point2
  /** 回転矩形の中心 */
  center: Point2
  /** 回転矩形の長軸角度（0〜180°） */
  angleDeg: number
  length: number
  thickness: number
  aspectRatio: number
  corners: Quad
  /** 重心まわりの 2 次中心モーメント（結合時の主軸計算に使う） */
  mu20: number
  mu11: number
  mu02: number
}

export type PenDetection = {
  /** 処理画像（＝表示画像、ミラー適用後）上の中心座標 px。分断時は隠れた部分も含めたペン全体の中心 */
  center: Point2
  /** 長軸の角度。画像右方向を 0°、時計回り（y 下向き）を正とした 0〜180° */
  angleDeg: number
  /** 全長 px（分断時は両端間の距離＝隠れた部分を含む） */
  length: number
  /** 太さ px */
  thickness: number
  /** 見えている輪郭面積の合計 px² */
  area: number
  aspectRatio: number
  /** 回転矩形の 4 頂点（表示座標） */
  corners: Quad
  /** 長軸の両端点（ペン先/後端の区別はまだしない） */
  endpoints: [Point2, Point2]
  /** このペンを構成する輪郭候補（1 なら従来どおりの単独輪郭） */
  segments: PenSegment[]
  frameWidth: number
  frameHeight: number
}

export type MergeSettings = {
  /** 結合を許すギャップ長の上限（ペンの太さに対する倍率） */
  maxGapRatio: number
  /** 結合を許す長軸方向の差の上限（度） */
  maxAngleDiff: number
}

export type FilterSettings = {
  /** 結合後の合計面積の下限 px² */
  minArea: number
  /** 結合後の 全長 / 太さ の下限 */
  minAspectRatio: number
}

/** 候補の中心がペンの軸線から外れてよい距離（太さに対する倍率） */
export const MAX_PERP_OFFSET_RATIO = 0.75
/** 太さの差が小さい場合に軸ずれを判定する最小許容幅 px */
const MIN_PERP_TOLERANCE_PX = 3
/** 候補の、軸と垂直方向の幅が許される範囲（ペンの太さに対する倍率） */
export const THICKNESS_RATIO_RANGE: [number, number] = [0.4, 1.8]
/** これ以上細長いグループのみ軸方向が信頼できるとみなし、結合の基準にする */
const AXIS_RELIABLE_ASPECT = 1.5
/** これ以上細長い候補のみ、自身の向きを方向差判定に使う（短い切れ端は向きが不安定なため） */
const SEGMENT_ORIENTATION_ASPECT = 2
/** 計算量を抑えるため、面積上位の候補のみを結合対象にする */
const MAX_CANDIDATES = 12

const dot = (a: Point2, b: Point2) => a.x * b.x + a.y * b.y
const sub = (a: Point2, b: Point2): Point2 => ({ x: a.x - b.x, y: a.y - b.y })

export function unitFromAngle(deg: number): Point2 {
  const rad = (deg * Math.PI) / 180
  return { x: Math.cos(rad), y: Math.sin(rad) }
}

/** 向きを持たない軸の角度（0〜180°） */
export function axisAngleDeg(u: Point2): number {
  const deg = (Math.atan2(u.y, u.x) * 180) / Math.PI
  return ((deg % 180) + 180) % 180
}

/** 向きを持たない 2 軸の角度差（0〜90°） */
export function axisAngleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 180
  return d > 90 ? 180 - d : d
}

/** OpenCV の minAreaRect の値から、長軸を基準にした候補を作る */
export function segmentFromRect(
  rect: { cx: number; cy: number; w: number; h: number; angle: number },
  moments: { m00: number; m10: number; m01: number; mu20: number; mu11: number; mu02: number },
): PenSegment {
  const length = Math.max(rect.w, rect.h)
  const thickness = Math.min(rect.w, rect.h)
  // minAreaRect の angle は width 辺の向き。長辺側の向きに揃えて 0〜180° に正規化する
  const angleDeg = axisAngleDeg(unitFromAngle(rect.w >= rect.h ? rect.angle : rect.angle + 90))
  const center = { x: rect.cx, y: rect.cy }
  const area = Math.abs(moments.m00)
  return {
    area,
    centroid: area > 0 ? { x: moments.m10 / moments.m00, y: moments.m01 / moments.m00 } : center,
    center,
    angleDeg,
    length,
    thickness,
    aspectRatio: length / Math.max(thickness, 1),
    corners: rectCorners(center, unitFromAngle(angleDeg), length, thickness),
    mu20: moments.mu20,
    mu11: moments.mu11,
    mu02: moments.mu02,
  }
}

export function rectCorners(center: Point2, u: Point2, length: number, thickness: number): Quad {
  const n = { x: -u.y, y: u.x }
  const hl = length / 2
  const ht = thickness / 2
  const at = (a: number, b: number): Point2 => ({
    x: center.x + u.x * a + n.x * b,
    y: center.y + u.y * a + n.y * b,
  })
  return [at(-hl, -ht), at(hl, -ht), at(hl, ht), at(-hl, ht)]
}

/**
 * 中心・軸方向・寸法からペンの検出結果を組み立てる。
 * normalizeDirection=true のときは軸ベクトルを 0〜180° 側に揃える（endpoints の順序が角度で決まる）。
 */
export function penFromAxis(
  params: {
    center: Point2
    u: Point2
    length: number
    thickness: number
    area: number
    segments: PenSegment[]
    frameWidth: number
    frameHeight: number
  },
  normalizeDirection = true,
): PenDetection {
  const { center, length, thickness } = params
  let u = params.u
  if (normalizeDirection && (u.y < 0 || (u.y === 0 && u.x < 0))) u = { x: -u.x, y: -u.y }
  const hl = length / 2
  return {
    center,
    angleDeg: axisAngleDeg(u),
    length,
    thickness,
    area: params.area,
    aspectRatio: length / Math.max(thickness, 1),
    corners: rectCorners(center, u, length, thickness),
    endpoints: [
      { x: center.x - u.x * hl, y: center.y - u.y * hl },
      { x: center.x + u.x * hl, y: center.y + u.y * hl },
    ],
    segments: params.segments,
    frameWidth: params.frameWidth,
    frameHeight: params.frameHeight,
  }
}

type GroupGeometry = {
  /** 軸線上の基準点 */
  origin: Point2
  u: Point2
  n: Point2
  /** origin からの軸方向の範囲 */
  a0: number
  a1: number
  thickness: number
  area: number
  reliable: boolean
}

/**
 * グループの軸を求める。
 * 単独輪郭は従来どおり minAreaRect の軸、複数輪郭は各輪郭のモーメントを合成した主軸を使う。
 * モーメントは平行軸の定理で合成できるため、ギャップを除いた「見えている部分全体」の向きが正確に得られる。
 */
function groupAxis(members: PenSegment[]): { origin: Point2; u: Point2 } {
  if (members.length === 1) {
    return { origin: members[0].center, u: unitFromAngle(members[0].angleDeg) }
  }
  let total = 0
  let sx = 0
  let sy = 0
  for (const s of members) {
    total += s.area
    sx += s.area * s.centroid.x
    sy += s.area * s.centroid.y
  }
  const cx = sx / total
  const cy = sy / total
  let mu20 = 0
  let mu02 = 0
  let mu11 = 0
  for (const s of members) {
    const dx = s.centroid.x - cx
    const dy = s.centroid.y - cy
    mu20 += s.mu20 + s.area * dx * dx
    mu02 += s.mu02 + s.area * dy * dy
    mu11 += s.mu11 + s.area * dx * dy
  }
  const theta = 0.5 * Math.atan2(2 * mu11, mu20 - mu02)
  return { origin: { x: cx, y: cy }, u: { x: Math.cos(theta), y: Math.sin(theta) } }
}

function project(points: Quad, origin: Point2, axis: Point2): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const p of points) {
    const t = dot(sub(p, origin), axis)
    if (t < lo) lo = t
    if (t > hi) hi = t
  }
  return [lo, hi]
}

function measureGroup(members: PenSegment[]): GroupGeometry {
  const { origin, u } = groupAxis(members)
  const n = { x: -u.y, y: u.x }
  let a0 = Infinity
  let a1 = -Infinity
  let area = 0
  let weightedWidth = 0
  for (const s of members) {
    const [s0, s1] = project(s.corners, origin, u)
    const [p0, p1] = project(s.corners, origin, n)
    a0 = Math.min(a0, s0)
    a1 = Math.max(a1, s1)
    area += s.area
    weightedWidth += s.area * (p1 - p0)
  }
  // 単独輪郭は minAreaRect の短辺、複数は軸に垂直な幅の面積加重平均
  const thickness = members.length === 1 ? members[0].thickness : weightedWidth / Math.max(area, 1)
  return {
    origin,
    u,
    n,
    a0,
    a1,
    thickness,
    area,
    reliable: (a1 - a0) / Math.max(thickness, 1) >= AXIS_RELIABLE_ASPECT,
  }
}

/** 候補をグループに結合できる場合はギャップ長（重なりは負値）、できない場合は null */
function mergeGap(g: GroupGeometry, s: PenSegment, settings: MergeSettings): number | null {
  if (!g.reliable) return null

  // 太さ：軸に垂直な幅がペンの太さと同程度であること（大きなピンク物体を除外）
  const [p0, p1] = project(s.corners, g.origin, g.n)
  const width = p1 - p0
  if (width < g.thickness * THICKNESS_RATIO_RANGE[0] || width > g.thickness * THICKNESS_RATIO_RANGE[1]) {
    return null
  }

  // 同一直線上：候補の重心が軸線の近くにあること（平行に並んだ別物体を除外）
  const offset = Math.abs(dot(sub(s.centroid, g.origin), g.n))
  if (offset > Math.max(g.thickness * MAX_PERP_OFFSET_RATIO, MIN_PERP_TOLERANCE_PX)) return null

  // 距離：軸方向のすき間が指 2 本分程度以内であること
  const [b0, b1] = project(s.corners, g.origin, g.u)
  const gap = Math.max(b0 - g.a1, g.a0 - b1)
  if (gap > settings.maxGapRatio * g.thickness) return null

  // 方向：十分細長い候補は自身の向きも一致していること
  if (
    s.aspectRatio >= SEGMENT_ORIENTATION_ASPECT &&
    axisAngleDiff(s.angleDeg, axisAngleDeg(g.u)) > settings.maxAngleDiff
  ) {
    return null
  }
  return gap
}

/**
 * STEP 5：複数ペン検出で、結合後のグループがこの縦横比を超える結合はしない。
 * 1 本のペンは縦横比 10〜15 程度なので、同一直線上に端を向け合った 2 本のペンを 1 本に結合しないための上限。
 * findPen（1 本検出）には適用しない（従来の挙動を変えないため）。
 */
export const MULTI_PEN_MAX_MERGED_ASPECT = 22

type Group = { members: PenSegment[]; geom: GroupGeometry }

/**
 * STEP 6：候補（結合後のペン）の評価関数。ペンらしくなければ null、そうでなければスコア（total が 0〜1）を返す。
 * 指定すると、評価を通った候補のうち「面積 × スコア」が最大のものを採用する（指定しなければ従来どおり面積が最大のもの）。
 */
export type PenEvaluator<S extends { total: number }> = (pen: PenDetection) => S | null

type ScoredGroup<S> = Group & { pen: PenDetection | null; score: S | null }

/**
 * 輪郭候補からペン 1 本を推定する（findPens と共通の 1 回分の探索）。
 * 面積の大きい候補から順に基準とし、条件を満たす候補をギャップの小さい順に貪欲に結合する。
 * 結合後に面積・縦横比のフィルタを通ったグループのうち、合計面積が最大のものを採用する。
 */
function findBestGroup<S extends { total: number }>(
  candidates: PenSegment[],
  settings: MergeSettings & FilterSettings,
  maxMergedAspect: number,
  frameWidth: number,
  frameHeight: number,
  evaluate?: PenEvaluator<S>,
): ScoredGroup<S> | null {
  let best: ScoredGroup<S> | null = null
  let bestRank = -Infinity

  for (const anchor of candidates) {
    if (best?.members.includes(anchor)) continue
    const members = [anchor]
    const rest = candidates.filter((s) => s !== anchor)
    let geom = measureGroup(members)

    for (;;) {
      let pick = -1
      let pickGap = Infinity
      rest.forEach((s, i) => {
        const gap = mergeGap(geom, s, settings)
        if (gap === null || gap >= pickGap) return
        if (Number.isFinite(maxMergedAspect)) {
          const merged = measureGroup([...members, s])
          if ((merged.a1 - merged.a0) / Math.max(merged.thickness, 1) > maxMergedAspect) return
        }
        pick = i
        pickGap = gap
      })
      if (pick < 0) break
      members.push(rest.splice(pick, 1)[0])
      geom = measureGroup(members)
    }

    const length = geom.a1 - geom.a0
    if (geom.area < settings.minArea) continue
    if (length / Math.max(geom.thickness, 1) < settings.minAspectRatio) continue
    if (!evaluate) {
      if (!best || geom.area > best.geom.area) best = { members, geom, pen: null, score: null }
      continue
    }
    const pen = groupToDetection({ members, geom }, frameWidth, frameHeight)
    const score = evaluate(pen)
    if (!score) continue
    const rank = geom.area * score.total
    if (rank > bestRank) {
      bestRank = rank
      best = { members, geom, pen, score }
    }
  }
  return best
}

function groupToDetection({ geom, members }: Group, frameWidth: number, frameHeight: number): PenDetection {
  const mid = (geom.a0 + geom.a1) / 2
  return penFromAxis({
    center: { x: geom.origin.x + geom.u.x * mid, y: geom.origin.y + geom.u.y * mid },
    u: geom.u,
    length: geom.a1 - geom.a0,
    thickness: geom.thickness,
    area: geom.area,
    segments: members,
    frameWidth,
    frameHeight,
  })
}

/** 輪郭候補からペン 1 本を推定する（STEP 1.1 からの単独ペン検出。結果は STEP 5 以前と同じ） */
export function findPen(
  segments: PenSegment[],
  settings: MergeSettings & FilterSettings,
  frameWidth: number,
  frameHeight: number,
): PenDetection | null {
  const candidates = [...segments].sort((a, b) => b.area - a.area).slice(0, MAX_CANDIDATES)
  const best = findBestGroup(candidates, settings, Infinity, frameWidth, frameHeight)
  return best ? groupToDetection(best, frameWidth, frameHeight) : null
}

/**
 * STEP 5：輪郭候補から最大 maxPens 本のペンを推定する（合計面積の大きい順）。
 * findPen と同じ探索を、採用したペンの輪郭を除いた残りの候補で繰り返す。各輪郭はどれか 1 本にしか属さない。
 * maxPens = 1 のときは findPen と同じ結果になる（縦横比の上限も適用しない）。
 * maxPens ≥ 2 のときは、端を向け合った 2 本を 1 本に結合しないよう MULTI_PEN_MAX_MERGED_ASPECT を適用する。
 */
export function findPens(
  segments: PenSegment[],
  settings: MergeSettings & FilterSettings,
  frameWidth: number,
  frameHeight: number,
  maxPens: number,
): PenDetection[] {
  return findScoredPens(segments, settings, frameWidth, frameHeight, maxPens).map((r) => r.pen)
}

/**
 * STEP 6：findPens に評価関数（形状スコアなど）を加えたもの。evaluate を省略すると findPens と同じ結果。
 * 評価で除外された候補は採用しないが、その輪郭は次の探索の候補に残す（別の組み合わせで結合できる可能性があるため）。
 */
export function findScoredPens<S extends { total: number }>(
  segments: PenSegment[],
  settings: MergeSettings & FilterSettings,
  frameWidth: number,
  frameHeight: number,
  maxPens: number,
  evaluate?: PenEvaluator<S>,
): { pen: PenDetection; score: S | null }[] {
  const maxMergedAspect = maxPens > 1 ? MULTI_PEN_MAX_MERGED_ASPECT : Infinity
  // 複数本では候補の上限を本数に応じて広げる（1 本のときは findPen と同じ 12）
  let candidates = [...segments]
    .sort((a, b) => b.area - a.area)
    .slice(0, MAX_CANDIDATES * Math.max(1, Math.min(maxPens, 3)))
  const pens: { pen: PenDetection; score: S | null }[] = []
  while (pens.length < maxPens && candidates.length > 0) {
    const best = findBestGroup(candidates.slice(0, MAX_CANDIDATES), settings, maxMergedAspect, frameWidth, frameHeight, evaluate)
    if (!best) break
    pens.push({ pen: best.pen ?? groupToDetection(best, frameWidth, frameHeight), score: best.score })
    candidates = candidates.filter((s) => !best.members.includes(s))
  }
  return pens
}
