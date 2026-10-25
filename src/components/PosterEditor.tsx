import { useEffect, useRef, useState } from 'react'
import { canvasToJpeg, posterFileName } from '../lib/photoCapture'
import { savePhoto } from '../lib/photoSaver'
import { loadPosterEndpoint, requestPosterCopy, savePosterEndpoint } from '../lib/posterApi'
import { COPY_LIMITS, HINT_MAX, POSTER_COPY_SPECS, POSTER_STYLE_IDS, fallbackCopy, type PosterCopy, type PosterStyleId } from '../lib/posterCopy'
import { POSTER_HEIGHT, POSTER_WIDTH, renderPoster, type PosterFace } from '../lib/posterRenderer'
import './PosterEditor.css'

type Props = {
  /** 撮影した AR 写真 */
  photo: Blob
  /** 撮影時の顔（写真の座標） */
  faces: PosterFace[]
  onClose: () => void
  /** 保存・共有の結果の通知 */
  onToast: (t: { kind: 'ok' | 'error' | 'info'; text: string }) => void
}

type AiState = { status: 'idle' | 'loading' | 'done'; source: 'gemini' | 'fallback' | null; reason: string }

/**
 * STEP 14：撮影した写真を映画ポスター風にする画面。
 * 作風を選ぶ → （任意）AI でタイトル・キャッチコピーを生成 → 文字を編集 → 保存・共有。
 * 作風ごとに文字を覚えておくので、作風を行き来しても編集した文字は消えない。
 */
export function PosterEditor({ photo, faces, onClose, onToast }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [style, setStyle] = useState<PosterStyleId>('hollywood')
  // 演出の乱数の種（編集中は同じ配置）と、作風ごとの最初の文字（定型文）
  const [seed] = useState(() => Math.random())
  const [copies, setCopies] = useState<Record<PosterStyleId, PosterCopy>>(
    () => Object.fromEntries(POSTER_STYLE_IDS.map((id) => [id, fallbackCopy(id, seed)])) as Record<PosterStyleId, PosterCopy>,
  )
  const [ai, setAi] = useState<AiState>({ status: 'idle', source: null, reason: '' })
  const [hint, setHint] = useState('')
  const [endpoint, setEndpoint] = useState(loadPosterEndpoint)
  const [busy, setBusy] = useState(false)
  const copy = copies[style]
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function'

  // 写真を読み込む
  useEffect(() => {
    const url = URL.createObjectURL(photo)
    const img = new Image()
    // 読み込みの途中で取り消した（写真が変わった・開発時の StrictMode の 2 回目の実行）ときは、結果を使わない
    let cancelled = false
    img.onload = () => {
      if (cancelled) return
      setLoadError(null)
      setImage(img)
    }
    img.onerror = () => {
      if (!cancelled) setLoadError('写真を読み込めませんでした')
    }
    img.src = url
    return () => {
      cancelled = true
      img.onload = null
      img.onerror = null
      URL.revokeObjectURL(url)
    }
  }, [photo])

  // 作風・文字が変わったら描き直す（文字の入力中は少し待ってから）
  useEffect(() => {
    if (!image) return
    const timer = setTimeout(() => {
      const ctx = canvasRef.current?.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      try {
        renderPoster(ctx, { photo: image, photoWidth: image.naturalWidth, photoHeight: image.naturalHeight, faces, style, copy, seed })
      } catch (e) {
        setLoadError(`ポスターを描けませんでした：${e instanceof Error ? e.message : String(e)}`)
      }
    }, 120)
    return () => clearTimeout(timer)
  }, [image, faces, style, copy, seed])

  const editCopy = (key: keyof PosterCopy, value: string) => {
    setCopies((prev) => ({ ...prev, [style]: { ...prev[style], [key]: [...value].slice(0, COPY_LIMITS[key]).join('') } }))
  }

  const generate = async () => {
    if (ai.status === 'loading') return
    const target = style
    setAi({ status: 'loading', source: null, reason: '' })
    savePosterEndpoint(endpoint)
    const result = await requestPosterCopy(target, hint, endpoint)
    setCopies((prev) => ({ ...prev, [target]: result.copy }))
    setAi({ status: 'done', source: result.source, reason: result.reason })
  }

  const toBlob = async () => {
    const canvas = canvasRef.current
    if (!canvas) throw new Error('ポスターがまだできていません')
    return canvasToJpeg(canvas, 0.92)
  }

  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      const target = await savePhoto(await toBlob(), posterFileName())
      onToast({ kind: 'ok', text: target === 'photos' ? 'ポスターを写真アプリに保存しました' : 'ポスターをダウンロードしました' })
    } catch (e) {
      onToast({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const share = async () => {
    if (busy) return
    setBusy(true)
    try {
      const file = new File([await toBlob()], posterFileName(), { type: 'image/jpeg' })
      if (!navigator.canShare({ files: [file] })) throw new Error('この環境では画像を共有できません。保存してから共有してください')
      await navigator.share({ files: [file], title: copy.title })
    } catch (e) {
      // 共有の画面を閉じただけ（AbortError）は通知しない
      if (!(e instanceof Error && e.name === 'AbortError')) onToast({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="poster-editor" role="dialog" aria-modal="true" aria-label="映画ポスターにする">
      <div className="poster-preview">
        {loadError ? <p className="poster-error">{loadError}</p> : <canvas ref={canvasRef} width={POSTER_WIDTH} height={POSTER_HEIGHT} aria-label="ポスターのプレビュー" />}
      </div>
      <div className="poster-panel">
        <div className="poster-styles" role="radiogroup" aria-label="作風">
          {POSTER_STYLE_IDS.map((id) => (
            <button key={id} type="button" role="radio" aria-checked={style === id} className={style === id ? 'selected' : ''} onClick={() => setStyle(id)}>
              <strong>{POSTER_COPY_SPECS[id].label}</strong>
              <span>{POSTER_COPY_SPECS[id].description}</span>
            </button>
          ))}
        </div>
        {faces.length === 0 && (style === 'lazyCat' || style === 'chaosClown' || style === 'gentlemanChef') && (
          <p className="poster-note">撮影時に顔が見つからなかったため、顔のパーツ（猫耳・メイク・前髪など）は付きません。</p>
        )}
        <div className="poster-ai">
          <input type="text" value={hint} maxLength={HINT_MAX} placeholder="お題（任意）例：雨の渋谷・最後の一本" onChange={(e) => setHint(e.target.value)} aria-label="AI へのお題" />
          <button type="button" onClick={generate} disabled={ai.status === 'loading'}>
            {ai.status === 'loading' ? '生成中…' : 'AI でタイトル生成'}
          </button>
        </div>
        {ai.status === 'done' && (
          <p className={`poster-note ${ai.source === 'gemini' ? 'ok' : ''}`}>{ai.source === 'gemini' ? 'Gemini で生成しました（編集できます）' : ai.reason}</p>
        )}
        <label className="poster-field">
          タイトル
          <input type="text" value={copy.title} onChange={(e) => editCopy('title', e.target.value)} />
        </label>
        <label className="poster-field">
          副題
          <input type="text" value={copy.subtitle} onChange={(e) => editCopy('subtitle', e.target.value)} />
        </label>
        <label className="poster-field">
          キャッチコピー
          <input type="text" value={copy.tagline} onChange={(e) => editCopy('tagline', e.target.value)} />
        </label>
        <details className="poster-endpoint">
          <summary>AI の接続先</summary>
          <input type="url" value={endpoint} placeholder="空欄：この開発サーバー / iPhone：http://<Mac の IP>:8787" onChange={(e) => setEndpoint(e.target.value)} onBlur={() => savePosterEndpoint(endpoint)} aria-label="AI の接続先" />
          <p>
            Mac で <code>npm run poster-server</code> を起動し、表示された URL を入力します。写真は送らず、作風とお題だけを送ります。未設定・失敗時は定型文になります。
          </p>
        </details>
        <div className="poster-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            戻る
          </button>
          {canShare && (
            <button type="button" onClick={share} disabled={busy || !image}>
              共有
            </button>
          )}
          <button type="button" className="primary" onClick={save} disabled={busy || !image}>
            {busy ? '処理中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
