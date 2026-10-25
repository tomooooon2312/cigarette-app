/**
 * STEP 9：写真の保存。
 * - iOS アプリ（Capacitor）：アプリ内のネイティブプラグイン PhotoSaver（ios/App/App/PhotoSaverPlugin.swift）で写真アプリに追加する。
 *   権限は「写真の追加のみ」（NSPhotoLibraryAddUsageDescription、PHAccessLevel.addOnly）。写真の読み取りは求めない。
 * - Web 版：画像をダウンロードする（a 要素の download）。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

type PhotoSaverPlugin = { saveImage(options: { data: string }): Promise<void> }

const PhotoSaver = registerPlugin<PhotoSaverPlugin>('PhotoSaver')

export type SaveTarget = 'photos' | 'download'

export type SaveDeps = {
  /** iOS アプリの中で動いているか */
  isNative: () => boolean
  saveToPhotos: (base64: string) => Promise<void>
  download: (blob: Blob, fileName: string) => void
  toBase64: (blob: Blob) => Promise<string>
}

/** 画像を base64（data: の前置きなし）にする */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}

/** Web 版：画像をダウンロードする（object URL はクリックの後に解放する） */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const DEFAULT_DEPS: SaveDeps = {
  isNative: () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios',
  saveToPhotos: (data) => PhotoSaver.saveImage({ data }),
  download: downloadBlob,
  toBase64: blobToBase64,
}

/** 写真を保存する。iOS アプリなら写真アプリ、それ以外はダウンロード。失敗したら例外（メッセージは日本語） */
export async function savePhoto(blob: Blob, fileName: string, deps: SaveDeps = DEFAULT_DEPS): Promise<SaveTarget> {
  if (deps.isNative()) {
    try {
      await deps.saveToPhotos(await deps.toBase64(blob))
    } catch (e) {
      const code = (e as { code?: string } | null)?.code
      if (code === 'PERMISSION_DENIED') {
        throw new Error('写真への追加が許可されていません（設定 → シブガレット → 写真 で許可してください）')
      }
      throw new Error(`写真アプリに保存できませんでした：${e instanceof Error ? e.message : String(e)}`)
    }
    return 'photos'
  }
  deps.download(blob, fileName)
  return 'download'
}
